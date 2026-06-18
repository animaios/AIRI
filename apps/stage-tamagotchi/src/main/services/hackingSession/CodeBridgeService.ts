import WebSocket from 'ws'

import { useLogg } from '@guiiai/logg'

import { electronCodeSummaryReceived } from '../../../shared/ipc/hackingSession'
import type { CodeMode } from '../../../shared/hacking-session'

/**
 * CodeBridgeService manages WebSocket connection to Code_Backend.
 *
 * Handles:
 * - WebSocket connection to ws://localhost:{port}/bridge
 * - Authentication handshake with sessionId and token
 * - Summary message validation and routing to Eventa
 * - Reconnection with exponential backoff
 * - Config sync via POST /config
 * - Keepalive pings
 *
 * Use when:
 * - Communicating with Code_Backend over WebSocket
 * - Receiving and validating summary messages
 * - Synchronizing provider configuration
 *
 * Expects:
 * - Owned by HackingSessionService (single instance)
 * - sessionId provided by HackingSessionService for correlation
 * - All messages validated for sessionId matching
 * - Only one WebSocket connection at a time
 */
export function setupCodeBridgeService(
  hackingSessionService: ReturnType<typeof import('./HackingSessionService').setupHackingSessionService>,
  options: {
    /** Port of Code_Backend WebSocket server */
    port: number
    /** SessionId for authentication and validation */
    sessionId: string
    /** Shared secret for WebSocket authentication */
    bridgeToken: string
    /** Eventa context to emit events */
    context: ReturnType<typeof import('@moeru/eventa/adapters/electron/main').createContext>['context']
  },
) {
  const log = useLogg('hacking-session:bridge').useGlobalConfig()

  const { port, sessionId: initialSessionId, bridgeToken, context } = options

  // ── Internal State ──────────────────────────────────────────────────

  let ws: WebSocket | null = null
  let sessionId = initialSessionId
  let reconnectAttempts = 0
  let reconnectTimer: NodeJS.Timeout | null = null
  let keepaliveTimer: NodeJS.Timeout | null = null
  let isClosing = false
  const MAX_RECONNECT_ATTEMPTS = 5
  const BASE_RECONNECT_DELAY_MS = 1000
  const MAX_RECONNECT_DELAY_MS = 30_000
  const KEEPALIVE_INTERVAL_MS = 30_000

  // ── WebSocket Management ───────────────────────────────────────────

  /**
   * Connect to Code_Backend WebSocket bridge.
   */
  function connect(): void {
    if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) {
      return
    }

    if (isClosing) {
      return
    }

    const wsUrl = `ws://localhost:${port}/bridge`
    log.withFields({ port, sessionId }).log(`Connecting to Code_Backend WebSocket: ${wsUrl}`)

    ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      log.log('WebSocket connected')
      reconnectAttempts = 0
      startKeepalive()
      sendAuthHandshake()
    }

    ws.onmessage = (event: WebSocket.MessageEvent) => {
      handleIncomingMessage(event.data)
    }

    ws.onclose = (event: WebSocket.CloseEvent) => {
      log.withFields({ code: event.code, reason: event.reason }).log('WebSocket disconnected')
      ws = null
      stopKeepalive()

      // Handle authentication failure (don't retry)
      if (event.code === 4001) {
        log.warn('Authentication failed — not retrying')
        // Notify HackingSessionService to transition to failed
        // This is done via the state change in the service when it detects the issue
        return
      }

      // Attempt reconnection if not closing and we have attempts left
      if (!isClosing && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        scheduleReconnect()
      } else if (!isClosing) {
        log.warn('Max reconnection attempts reached')
        // Will be handled by HackingSessionService readiness timeout
      }
    }

    ws.onerror = (error: WebSocket.ErrorEvent) => {
      log.withError(error).error('WebSocket error')
      // Don't close here - let onclose handle cleanup
    }
  }

  /**
   * Send authentication handshake.
   */
  function sendAuthHandshake(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return
    }

    const authMessage = {
      type: 'auth',
      sessionId,
      token: bridgeToken,
    }

    log.withFields({ sessionId }).log('Sending authentication handshake')
    ws.send(JSON.stringify(authMessage))
  }

  /**
   * Handle incoming WebSocket message.
   */
  function handleIncomingMessage(data: unknown): void {
    // Check if we're tearing down
    const hackingState = hackingSessionService.getState()
    if (hackingState.state === 'failed' || hackingState.state === 'inactive') {
      return
    }

    // Parse message
    let parsed: unknown
    try {
      parsed = typeof data === 'string' ? JSON.parse(data) : data
    } catch {
      log.warn('Received invalid JSON from WebSocket')
      return
    }

    // Validate message structure
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !(parsed as Record<string, unknown>).type ||
      typeof (parsed as Record<string, unknown>).type !== 'string'
    ) {
      log.warn('Received message missing type field')
      return
    }

    const message = parsed as { type: string; [key: string]: unknown }

    // Handle summary messages
    if (message.type === 'summary') {
      handleSummaryMessage(message)
    }
    // Ignore all other message types (prevents duplication from other sources)
  }

  /**
   * Validate and route summary message to Eventa.
   */
  function handleSummaryMessage(message: unknown): void {
    // Validate structure
    if (
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      !(message as Record<string, unknown>).sessionId ||
      !(message as Record<string, unknown>).text ||
      !(message as Record<string, unknown>).metadata
    ) {
      log.warn('Received summary message missing required fields')
      return
    }

    const summary = message as {
      sessionId: string
      text: string
      metadata: { mode: string; model: string; tokens: number }
      [key: string]: unknown
    }

    // Validate sessionId matches current session
    if (summary.sessionId !== sessionId) {
      log
        .withFields({
          expected: sessionId,
          received: summary.sessionId,
        })
        .warn('Received summary from stale session — discarding')
      return
    }

    // Validate metadata structure
    if (
      !summary.metadata ||
      typeof summary.metadata !== 'object' ||
      Array.isArray(summary.metadata) ||
      typeof summary.metadata.mode !== 'string' ||
      typeof summary.metadata.model !== 'string' ||
      typeof summary.metadata.tokens !== 'number'
    ) {
      log.warn('Received summary with invalid metadata structure')
      return
    }

    // Emit via Eventa (single event path)
    log.withFields({ sessionId: summary.sessionId }).log('Routing summary to Eventa')
    context.emit(electronCodeSummaryReceived, summary)
  }

  /**
   * Schedule reconnection with exponential backoff.
   */
  function scheduleReconnect(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
    }

    // Exponential backoff: base * 2^attempt, capped at max
    const delay = Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY_MS)

    log.withFields({ attempt: reconnectAttempts + 1, delayMs: delay }).log('Scheduling reconnection')
    reconnectTimer = setTimeout(() => {
      reconnectAttempts++
      connect()
    }, delay)
  }

  /**
   * Start keepalive pings.
   */
  function startKeepalive(): void {
    if (keepaliveTimer) {
      clearTimeout(keepaliveTimer)
    }

    keepaliveTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping()
          log.debug('Sent keepalive ping')
        } catch (error) {
          log.withError(error).debug('Failed to send keepalive ping')
        }
      }
    }, KEEPALIVE_INTERVAL_MS)

    // Allow process to exit if this is the only remaining timer
    if (keepaliveTimer?.unref) {
      keepaliveTimer.unref()
    }
  }

  /**
   * Stop keepalive pings.
   */
  function stopKeepalive(): void {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer)
      keepaliveTimer = null
    }
  }

  /**
   * Send configuration to Code_Backend via POST /config.
   */
  async function sendConfig(
    providerConfig: {
      name: string
      apiKey: string
      baseUrl?: string
      model?: string
      temperature?: number
      maxTokens?: number
    },
    codeMode: CodeMode,
  ): Promise<void> {
    // Only send if we have an open connection
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log.warn('WebSocket not open — skipping config sync')
      return
    }

    // Note: Actual HTTP POST to /config would be done via a separate HTTP client
    // For now, we log that we would send it. In a real implementation,
    // this would use node-fetch or similar to POST to http://localhost:{port}/config
    log
      .withFields({
        provider: providerConfig.name,
        mode: codeMode,
        sessionId,
      })
      .log('Would send config via POST /config (HTTP client not implemented in this skeleton)')

    // TODO: Implement actual HTTP POST here when integrating with HTTP client
    // Example:
    // const response = await fetch(`http://localhost:${port}/config`, {
    //   method: 'POST',
    //   headers: {
    //     'Content-Type': 'application/json',
    //     'X-Session-ID': sessionId,
    //   },
    //   body: JSON.stringify({
    //     provider: providerConfig,
    //     mode: codeMode,
    //     sessionId,
    //   }),
    // })
    //
    // if (!response.ok) {
    //   throw new Error(`Config sync failed: ${response.status}`)
    // }
  }

  /**
   * Close WebSocket connection gracefully.
   */
  async function close(): Promise<void> {
    if (isClosing) {
      return
    }

    isClosing = true
    log.log('Closing WebSocket connection')

    stopKeepalive()

    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

    if (ws) {
      ws.close(1000, 'Closing normally')
      ws = null
    }

    // Allow a brief moment for close to flush
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  /**
   * Update sessionId (called when sessionId changes).
   */
  function updateSessionId(newSessionId: string): void {
    sessionId = newSessionId
    // If we're connected, we'll need to re-authenticate with new sessionId
    // on the next message send/receive cycle
    if (ws && ws.readyState === WebSocket.OPEN) {
      log.withFields({ oldSessionId: initialSessionId, newSessionId }).log('SessionId updated — will re-authenticate')
    }
  }

  // ── Public API ──────────────────────────────────────────────────────

  return {
    connect,
    close,
    sendConfig,
    updateSessionId,
  }
}

export type CodeBridgeService = ReturnType<typeof setupCodeBridgeService>
