import type { ChildProcess } from 'node:child_process'

import process from 'node:process'

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import { useLogg } from '@guiiai/logg'
import { getPort } from 'get-port-please'
import WebSocket from 'ws'

import { onAppBeforeQuit } from '../../libs/bootkit/lifecycle'

/**
 * Hacking Session state machine values.
 *
 * - `inactive` — No Code_Process running, sessionId null
 * - `starting` — Process spawning, progressing through readiness tiers
 * - `active` — Fully operational, WebView mounted, WebSocket connected
 * - `failed` — Error occurred, teardown completed, retry available
 */
import type {
  HackingSessionState,
  ActivationConfig,
  ProcessInfo,
  HackingSessionStatePayload,
} from '../../../shared/hacking-session'

export type { HackingSessionStatePayload } from '../../../shared/hacking-session'

/**
 * Type for state change listeners.
 */
type StateChangeListener = (payload: HackingSessionStatePayload) => void

/**
 * Options for HackingSessionService constructor.
 */
export interface HackingSessionServiceOptions {
  /**
   * Path to Code_Backend entry script.
   * @default 'modules/code/apps/roo-code-standalone/dist/server.js'
   */
  codeBackendPath?: string

  /**
   * Timeout in ms for the entire readiness progression (3 tiers).
   * @default 15000
   */
  readinessTimeoutMs?: number

  /**
   * Timeout in ms for HTTP readiness check (tier 2).
   * @default 10000
   */
  httpReadyTimeoutMs?: number

  /**
   * Interval in ms for parent-death detection.
   * @default 5000
   */
  parentDeathPollIntervalMs?: number

  /**
   * Shared secret for WebSocket authentication.
   * @default 'animaios-hacking-bridge'
   */
  bridgeToken?: string
}

const DEFAULT_CODE_BACKEND_PATH = 'modules/code/apps/roo-code-standalone/dist/server.js'
const DEFAULT_READINESS_TIMEOUT_MS = 15_000
const DEFAULT_HTTP_READY_TIMEOUT_MS = 10_000
const DEFAULT_PARENT_DEATH_POLL_INTERVAL_MS = 5_000
const DEFAULT_BRIDGE_TOKEN = 'animaios-hacking-bridge'

/**
 * HackingSessionService — single orchestrator for Hacking Mode.
 *
 * Owns the 4-state FSM, Code_Process lifecycle, 3-tier readiness progression,
 * and the 8-step ordered teardown contract.
 *
 * Use when:
 * - Managing the Hacking Mode lifecycle (activate, deactivate)
 * - Subscribing to state changes from renderer components
 * - Coordinating CodeBridgeService, Code_Process, and UIAdapterLayer
 *
 * Expects:
 * - Only one activation at a time (singleton service)
 * - sessionId is ephemeral UUID v4, never persisted
 * - All failures trigger full teardown (no partial recovery)
 */
export function setupHackingSessionService(options: HackingSessionServiceOptions = {}) {
  const log = useLogg('hacking-session').useGlobalConfig()

  const {
    codeBackendPath = DEFAULT_CODE_BACKEND_PATH,
    readinessTimeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
    httpReadyTimeoutMs = DEFAULT_HTTP_READY_TIMEOUT_MS,
    parentDeathPollIntervalMs = DEFAULT_PARENT_DEATH_POLL_INTERVAL_MS,
    bridgeToken = DEFAULT_BRIDGE_TOKEN,
  } = options

  // ── Internal State ──────────────────────────────────────────────────────

  let state: HackingSessionState = 'inactive'
  let sessionId: string | null = null
  let processInfo: ProcessInfo | undefined
  let lastError: string | undefined
  let codeProcess: ChildProcess | null = null
  let isTearingDown = false
  let parentDeathInterval: ReturnType<typeof setInterval> | null = null
  const listeners = new Set<StateChangeListener>()

  // ── State Management ─────────────────────────────────────────────────────

  function getPayload(): HackingSessionStatePayload {
    return {
      sessionId,
      state,
      ...(processInfo ? { processInfo } : {}),
      ...(lastError ? { lastError } : {}),
    }
  }

  function emitStateChange(): void {
    const payload = getPayload()
    for (const listener of listeners) {
      try {
        listener(payload)
      } catch (error) {
        log.withError(error).warn('State change listener threw')
      }
    }
  }

  function transitionTo(newState: HackingSessionState, error?: string): void {
    log
      .withFields({ from: state, to: newState, sessionId, ...(error ? { error } : {}) })
      .log(`State transition: ${state} → ${newState}`)

    state = newState

    if (error) {
      lastError = error
    }

    if (newState === 'inactive' || newState === 'failed') {
      sessionId = null
    }

    emitStateChange()
  }

  // ── Readiness Checking ───────────────────────────────────────────────────

  /**
   * Check if the Code_Backend HTTP server is ready by polling /health.
   */
  async function waitForHttpReady(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    const url = `http://localhost:${port}/health`

    while (Date.now() < deadline) {
      try {
        const response = await fetch(url)
        if (response.ok) {
          return true
        }
      } catch {
        // Server not ready yet, will retry
      }
      await sleep(500)
    }

    return false
  }

  /**
   * Check if the WebSocket bridge is ready by attempting a handshake.
   */
  async function waitForBridgeReady(port: number, overallDeadlineMs: number): Promise<boolean> {
    const deadline = Date.now() + overallDeadlineMs

    while (Date.now() < deadline) {
      try {
        const wsUrl = `ws://localhost:${port}/bridge`
        const ws = new WebSocket(wsUrl)

        const handshakeResult = await new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => {
            ws.close()
            resolve(false)
          }, 3000)

          ws.onopen = () => {
            // Send authentication handshake
            ws.send(
              JSON.stringify({
                type: 'auth',
                sessionId,
                token: bridgeToken,
              }),
            )
          }

          ws.onmessage = (event) => {
            try {
              const msg = JSON.parse(event.data as string)
              if (msg.type === 'auth_ok') {
                clearTimeout(timeout)
                ws.close()
                resolve(true)
              }
            } catch {
              // Invalid message, continue waiting
            }
          }

          ws.onerror = () => {
            clearTimeout(timeout)
            resolve(false)
          }

          ws.onclose = () => {
            clearTimeout(timeout)
            resolve(false)
          }
        })

        if (handshakeResult) {
          return true
        }
      } catch {
        // Bridge not ready yet
      }

      await sleep(500)
    }

    return false
  }

  // ── Parent-Death Detection ───────────────────────────────────────────────

  /**
   * Monitor parent Electron PID. If the parent dies (zombie prevention),
   * kill the Code_Process and clean up.
   */
  function startParentDeathDetection(): void {
    if (parentDeathInterval) {
      clearInterval(parentDeathInterval)
    }

    const parentPid = process.ppid

    parentDeathInterval = setInterval(() => {
      try {
        // Sending signal 0 tests whether the process exists without killing it.
        // Throws ESRCH if the parent is gone.
        process.kill(parentPid, 0)
      } catch {
        log.warn('Parent process died — cleaning up Code_Process')
        cleanupProcess()
        if (parentDeathInterval) {
          clearInterval(parentDeathInterval)
          parentDeathInterval = null
        }
      }
    }, parentDeathPollIntervalMs)

    // Allow the process to exit cleanly if this is the only remaining reference
    if (parentDeathInterval?.unref) {
      parentDeathInterval.unref()
    }
  }

  function stopParentDeathDetection(): void {
    if (parentDeathInterval) {
      clearInterval(parentDeathInterval)
      parentDeathInterval = null
    }
  }

  // ── Process Management ──────────────────────────────────────────────────

  function cleanupProcess(): void {
    if (codeProcess) {
      try {
        codeProcess.kill('SIGKILL')
      } catch {
        // Process may already be dead
      }
      codeProcess = null
    }
    processInfo = undefined
  }

  /**
   * Send SIGTERM, wait, then SIGKILL if still alive.
   */
  async function gracefulKillProcess(timeoutMs: number): Promise<void> {
    if (!codeProcess || !codeProcess.pid) return

    try {
      codeProcess.kill('SIGTERM')
    } catch {
      // Process already dead
      codeProcess = null
      processInfo = undefined
      return
    }

    // Wait for graceful shutdown
    await sleep(timeoutMs)

    // Force kill if still alive
    if (codeProcess && codeProcess.pid) {
      try {
        codeProcess.kill('SIGKILL')
      } catch {
        // Already dead
      }
    }

    codeProcess = null
    processInfo = undefined
  }

  // ── 8-Step Ordered Teardown ──────────────────────────────────────────────

  /**
   * Execute the 8-step ordered teardown contract.
   *
   * 1. Set isTearingDown flag (drops incoming WS messages)
   * 2. Blank the WebView (about:blank, 500ms timeout)
   * 3. Close WebSocket connection (1000ms timeout)
   * 4. Send SIGTERM to Code_Process (3000ms timeout)
   * 5. Send SIGKILL if process still alive
   * 6. Destroy WebView (500ms timeout)
   * 7. Nullify sessionId
   * 8. Emit state change event
   */
  async function executeOrderedTeardown(): Promise<void> {
    if (isTearingDown) return
    isTearingDown = true

    log.withFields({ sessionId }).log('Starting 8-step ordered teardown')

    // Step 1: Stop input routing
    // (isTearingDown flag is set, CodeBridgeService checks this)

    // Step 2-6: managed externally via callbacks
    // (UIAdapterLayer handles WebView blanking/destruction)
    // (CodeBridgeService handles WS close)

    // Step 4-5: Kill process
    await gracefulKillProcess(3000)

    // Step 6: Stop parent-death detection
    stopParentDeathDetection()

    // Step 7: Nullify sessionId
    sessionId = null

    // Step 8: The caller (activate/deactivate) owns the final state transition
    isTearingDown = false
    // Do NOT transition here — the caller handles failed/inactive transition
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Activate Hacking Mode.
   *
   * Spawns Code_Process, waits for 3-tier readiness (process → HTTP → bridge),
   * then transitions to active state.
   *
   * @param config - Optional activation configuration
   * @returns Object with success flag and sessionId or error
   */
  async function activate(
    _config?: ActivationConfig,
  ): Promise<{ success: true; sessionId: string } | { success: false; error: string }> {
    // Guard: cannot activate in starting or active state
    if (state === 'starting' || state === 'active') {
      return { success: false, error: `Cannot activate while state is "${state}"` }
    }

    // Reset state
    lastError = undefined
    isTearingDown = false

    // Generate ephemeral sessionId
    const newSessionId = randomUUID()
    sessionId = newSessionId

    transitionTo('starting')

    // Tier 1: Acquire dynamic port
    let port: number
    try {
      port = await getPort()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      transitionTo('failed', `Failed to acquire port: ${msg}`)
      return { success: false, error: `Failed to acquire port: ${msg}` }
    }

    // Tier 1: Spawn Code_Process
    try {
      codeProcess = spawn('node', [codeBackendPath], {
        env: {
          ...process.env,
          PORT: String(port),
          BRIDGE_TOKEN: bridgeToken,
          PARENT_PID: String(process.pid),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      processInfo = { pid: codeProcess.pid ?? -1, port }

      // Handle process exit — mark for failure; the main activation flow
      // will pick up the failure via readiness check timeouts.
      codeProcess.on('exit', (exitCode, signal) => {
        codeProcess = null
        processInfo = undefined

        if (state === 'active' || state === 'starting') {
          log.withFields({ exitCode, signal, sessionId }).log('Code_Process exited unexpectedly')
        }
      })

      codeProcess.on('error', (err) => {
        codeProcess = null
        processInfo = undefined

        if (state === 'starting' && !isTearingDown) {
          log.withError(err).log('Code_Process spawn error — readiness checks will time out')
        }
      })

      // Log process stdout/stderr for debugging
      if (codeProcess.stdout) {
        codeProcess.stdout.on('data', (data: Buffer) => {
          log.withFields({ pid: processInfo?.pid }).debug(`[stdout] ${data.toString().trim()}`)
        })
      }
      if (codeProcess.stderr) {
        codeProcess.stderr.on('data', (data: Buffer) => {
          log.withFields({ pid: processInfo?.pid }).debug(`[stderr] ${data.toString().trim()}`)
        })
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      transitionTo('failed', `Failed to spawn Code_Process: ${msg}`)
      return { success: false, error: msg }
    }

    emitStateChange()

    // Start parent-death detection
    startParentDeathDetection()

    // Tier 2: Wait for HTTP readiness
    const httpReady = await waitForHttpReady(port, httpReadyTimeoutMs)
    if (!httpReady) {
      const msg = 'HTTP readiness check failed — Code_Backend did not respond to /health within timeout'
      log.error(msg)
      await executeOrderedTeardown()
      transitionTo('inactive')
      transitionTo('failed', msg)
      return { success: false, error: msg }
    }

    emitStateChange()

    // Tier 3: Wait for bridge readiness
    const remainingDeadline = readinessTimeoutMs - httpReadyTimeoutMs + Date.now()
    const bridgeReady = await waitForBridgeReady(port, Math.max(remainingDeadline - Date.now(), 5000))
    if (!bridgeReady) {
      const msg = 'Bridge readiness check failed — WebSocket handshake did not complete within timeout'
      log.error(msg)
      await executeOrderedTeardown()
      transitionTo('inactive')
      transitionTo('failed', msg)
      return { success: false, error: msg }
    }

    // All 3 tiers passed — mark as active
    transitionTo('active')

    return { success: true, sessionId: newSessionId }
  }

  /**
   * Deactivate Hacking Mode.
   *
   * Executes the full 8-step ordered teardown contract.
   *
   * @returns Object with success flag
   */
  async function deactivate(): Promise<{ success: true } | { success: false; error?: string }> {
    if (state === 'inactive') {
      return { success: true } // Already inactive — idempotent
    }

    try {
      await executeOrderedTeardown()
      transitionTo('inactive')
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      log.withError(error).error('Teardown failed')
      transitionTo('failed', msg)
      return { success: false, error: msg }
    }

    return { success: true }
  }

  /**
   * Subscribe to state changes.
   *
   * @param listener - Callback receiving state payload on changes
   * @returns Unsubscribe function
   */
  function onStateChange(listener: StateChangeListener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  /**
   * Get current state snapshot.
   */
  function getState(): HackingSessionStatePayload {
    return getPayload()
  }

  /**
   * Get the bridge token for WebSocket authentication.
   */
  function getBridgeToken(): string {
    return bridgeToken
  }

  function getPortNum(): number | undefined {
    return processInfo?.port
  }

  // ── Cleanup on app quit ─────────────────────────────────────────────────

  onAppBeforeQuit(async () => {
    if (state === 'active' || state === 'starting') {
      log.log('Cleaning up Hacking Session on app quit')
      await deactivate()
    }
  })

  // ── Return ──────────────────────────────────────────────────────────────

  return {
    activate,
    deactivate,
    onStateChange,
    getState,
    getPort: getPortNum,
    getBridgeToken,
  }
}

export type HackingSessionService = ReturnType<typeof setupHackingSessionService>
