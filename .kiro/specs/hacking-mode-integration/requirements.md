# Requirements Document

## Introduction

This document defines requirements for integrating the AnimAIOS Code module (a standalone browser-based AI coding assistant) into the stage-tamagotchi Electron application to implement "Hacking Mode" functionality. The Code module is a fork of Roo Code that runs as a self-contained React SPA with a Fastify backend at localhost:3210. Hacking Mode enables AIRI to activate Code inside the AIRI interface via BrowserView, transforming the AIRI chatbox into the Code interface while AIRI narrates Code's summaries via TTS.

The integration must preserve the Code module's independence (it remains a standalone product) while creating a seamless embedded experience where AIRI acts as the host and Code provides the coding intelligence on demand.

## Glossary

- **AIRI**: The AI companion personality that hosts the stage-tamagotchi Electron application
- **Code_Module**: The standalone browser-based AI coding assistant (AnimAIOS Code fork of Roo Code) - operates as a dumb execution runtime with no AIRI knowledge
- **Hacking_Session**: The canonical state object owned by Electron main process representing current integration state
- **Hacking_Session_Service**: Single orchestrator owning lifecycle, mode, process, and activation rules
- **Code_Process**: The child process running Code_Backend (Fastify server on port 3210)
- **Code_Bridge_Service**: Manages WebSocket connection, config sync, and summary stream from Code to AIRI
- **UI_Adapter_Layer**: Manages BrowserView rendering, resizing, and visibility only (no authority)
- **Main_Window**: The primary stage-tamagotchi Electron window
- **Input_Gateway**: Normalized message bus that routes user input to AIRI or Code consumers
- **Session_ID**: Shared identifier correlating AIRI and Code_Module activity across reconnects
- **Bridge_Readiness**: Three-tier state (process_started → http_ready → bridge_ready) indicating Code_Backend availability
- **Eventa**: The type-safe IPC/RPC framework used for all communication contracts

## Requirements

### Requirement 1: Hacking Session Service as Single Orchestrator

**User Story:** As a developer, I want a single service to own all Hacking Mode lifecycle, state, and coordination, so that there is one source of truth preventing state desync and race conditions.

#### Acceptance Criteria

1. THE Hacking_Session_Service SHALL be registered in the injeca container in `src/main/index.ts` with dependencies { lifecycle, mainWindow, serverChannel }
2. THE Hacking_Session_Service SHALL maintain a canonical Hacking_Session state object with fields: { sessionId, state, processInfo, healthStatus, lastError }
3. THE state field SHALL use finite state machine with exactly four values: "inactive", "starting", "active", "failed"
4. WHEN Hacking_Session_Service starts, THE state SHALL initialize to "inactive"
5. WHEN activation is requested, THE Hacking_Session_Service SHALL transition through: "starting" → "active" (on success) or "starting" → "failed" (on error)
6. THE Hacking_Session_Service SHALL expose public methods: activate(config), deactivate(), getState(), getSessionId()
7. THE Hacking_Session_Service SHALL own Code_Process lifecycle, Code_Bridge_Service instantiation, and UI_Adapter_Layer coordination
8. WHEN state changes, THE Hacking_Session_Service SHALL emit a single Eventa broadcast event `electronHackingSessionStateChanged` with full state payload
9. ALL other components SHALL subscribe to Hacking_Session state via Eventa events only
10. THE Hacking_Session_Service SHALL generate a unique sessionId (UUID v4) on each activation and include it in all Code_Backend communication

### Requirement 2: Code Process Lifecycle with Three-Tier Readiness

**User Story:** As a developer, I want Code_Process to progress through three distinct readiness states, so that activation only proceeds when WebSocket bridge is truly ready, not just HTTP.

#### Acceptance Criteria

1. WHEN Hacking_Session_Service.activate() is called, THE Service SHALL spawn Code_Process running Code_Backend on localhost:3210 with executable path `modules/code/apps/roo-code-standalone/dist/server.js`
2. IF port 3210 is already in use, THEN THE Service SHALL log error, transition state to "failed", and set lastError to "Port conflict: 3210 already bound"
3. WHEN Code_Process starts, THE Service SHALL wait for three-tier readiness: process_started → http_ready → bridge_ready
4. THE process_started state SHALL be reached when Code_Process PID is available
5. THE http_ready state SHALL be reached when GET http://localhost:3210/health returns HTTP 200 within 10000ms
6. THE bridge_ready state SHALL be reached when WebSocket connection to ws://localhost:3210/bridge completes handshake with sessionId
7. IF bridge_ready is not reached within 15000ms total, THEN THE Service SHALL transition to "failed" state and kill Code_Process
8. WHEN the Electron app quits, THE Hacking_Session_Service SHALL send SIGTERM to Code_Process and wait up to 3000ms for graceful shutdown
9. IF Code_Process does not exit within timeout, THEN THE Service SHALL send SIGKILL to force termination
10. WHEN Code_Process crashes unexpectedly while state is "active", THE Service SHALL transition to "failed" and emit state change event
11. THE Hacking_Session_Service SHALL log PID, port, startup duration, and all three readiness transitions using `@guiiai/logg` namespace "hacking-session"

### Requirement 3: Code Bridge Service for WebSocket and Config Sync

**User Story:** As a developer, I want a single service to manage the WebSocket connection and config synchronization with Code_Backend, so that summary streaming and configuration are handled through one canonical path.

#### Acceptance Criteria

1. THE Code_Bridge_Service SHALL be instantiated by Hacking_Session_Service when state transitions to "starting"
2. THE Code_Bridge_Service SHALL establish WebSocket connection to ws://localhost:3210/bridge with sessionId in handshake payload
3. WHEN WebSocket connection opens, THE Code_Bridge_Service SHALL send authentication message: `{ type: "auth", sessionId, token: <shared-secret> }`
4. IF authentication fails (Code_Backend responds with close code 4001), THEN THE Code_Bridge_Service SHALL emit error and not attempt reconnection
5. WHEN Code_Backend emits a "summary" message, THE Code_Bridge_Service SHALL validate payload contains { text, metadata: { mode, model, tokens } }
6. WHEN a valid summary is received, THE Code_Bridge_Service SHALL emit Eventa broadcast `electronCodeSummaryReceived` with payload { sessionId, text, metadata }
7. THE Code_Bridge_Service SHALL ignore all other summary sources (BrowserView events, HTTP polling) to prevent duplication
8. WHEN Hacking_Session_Service.activate() is called with config parameter, THE Code_Bridge_Service SHALL POST config to http://localhost:3210/config with sessionId header
9. IF config sync fails, THEN THE Code_Bridge_Service SHALL log error but allow activation to proceed (Code uses stored settings)
10. WHEN WebSocket connection closes unexpectedly, THE Code_Bridge_Service SHALL attempt reconnection with exponential backoff (base: 1000ms, max: 30000ms)
11. WHEN Hacking_Session_Service.deactivate() is called, THE Code_Bridge_Service SHALL close WebSocket connection and stop reconnection attempts
12. THE Code_Bridge_Service SHALL implement keepalive pings every 30000ms to detect stale connections

### Requirement 4: UI Adapter Layer for BrowserView Management

**User Story:** As a developer, I want BrowserView to be a dumb rendering surface with no authority, so that all state is controlled by Electron and we avoid dual control planes.

#### Acceptance Criteria

1. THE UI_Adapter_Layer SHALL be a private implementation detail within Hacking_Session_Service
2. WHEN Hacking_Session state transitions to "active", THE UI_Adapter_Layer SHALL create a BrowserView instance loading http://localhost:3210
3. THE BrowserView SHALL be created with security settings: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false }
4. THE BrowserView SHALL use session partition "persist:hacking-mode" for isolation
5. THE BrowserView SHALL load content ONLY from http://localhost:3210 origin and reject all other origins
6. THE UI_Adapter_Layer SHALL attach BrowserView to Main_Window with bounds matching chat content area (minimum: 320x240px)
7. WHILE state is "active", THE UI_Adapter_Layer SHALL update BrowserView bounds whenever Main_Window resizes, recalculating within 16ms (60fps frame budget)
8. IF BrowserView fails to load within 10000ms, THEN THE UI_Adapter_Layer SHALL retry once after 2000ms
9. IF retry fails, THEN THE Hacking_Session_Service SHALL transition to "failed" state with lastError indicating load timeout
10. WHEN state transitions from "active" to "inactive" or "failed", THE UI_Adapter_Layer SHALL detach and destroy BrowserView instance
11. THE UI_Adapter_Layer SHALL NOT expose any Electron APIs to Code_Module via preload scripts
12. THE UI_Adapter_Layer SHALL log BrowserView ID, bounds, and lifecycle events using namespace "hacking-session:ui"

### Requirement 5: Input Gateway for Normalized Message Routing

**User Story:** As a developer, I want user input to flow through a normalized message bus, so that routing is explicit, testable, and prevents DOM injection coupling.

#### Acceptance Criteria

1. THE Input_Gateway SHALL be implemented as a message bus with methods: route(message, context), subscribe(consumer)
2. THE Input_Gateway SHALL accept normalized messages with structure: { text: string, timestamp: number, sessionContext: string }
3. WHEN Hacking_Session state is "inactive" or "failed", THE Input_Gateway SHALL route messages to AIRI_Consumer only
4. WHEN Hacking_Session state is "active", THE Input_Gateway SHALL route messages to Code_Consumer only
5. THE Input_Gateway SHALL ensure exactly one consumer receives each message (no duplication)
6. THE AIRI_Consumer SHALL forward messages to AIRI's existing chat processing pipeline
7. THE Code_Consumer SHALL send messages to Code_Backend via WebSocket (NOT via DOM injection into BrowserView)
8. THE Input_Gateway SHALL enforce maximum message size of 10000 characters
9. IF message exceeds size limit, THEN THE Input_Gateway SHALL truncate and log warning
10. THE Input_Gateway SHALL maintain separate in-memory message histories (max 1000 messages each) for AIRI and Code consumers
11. WHEN Hacking_Session state changes, THE Input_Gateway SHALL switch active consumer without replaying history
12. THE Input_Gateway SHALL preserve pending input text in a buffer when state transitions occur

### Requirement 6: TTS Narration via Single Event Path

**User Story:** As an AIRI user, I want AIRI to narrate Code's progress summaries in her voice via a single canonical event path, so that I receive audio feedback without duplication or race conditions.

#### Acceptance Criteria

1. THE TTS_Narrator SHALL subscribe to Eventa broadcast event `electronCodeSummaryReceived` ONLY (ignoring all other summary sources)
2. WHEN `electronCodeSummaryReceived` event is received with payload { sessionId, text, metadata }, THE TTS_Narrator SHALL validate sessionId matches current Hacking_Session sessionId
3. IF sessionId mismatch occurs, THEN THE TTS_Narrator SHALL ignore the event and log warning "Summary from stale session"
4. WHEN sessionId validates, THE TTS_Narrator SHALL send summary text to AIRI's existing TTS pipeline
5. THE TTS_Narrator SHALL use AIRI's configured voice settings for narration (voice model, speed, pitch)
6. IF TTS generation fails, THEN THE TTS_Narrator SHALL log error with namespace "hacking-session:tts" but continue without blocking Code_Module
7. THE TTS_Narrator SHALL implement throttling: max 1 narration per 2000ms to prevent audio overlap
8. IF summaries arrive faster than throttle limit, THEN THE TTS_Narrator SHALL queue them and process in order

### Requirement 7: Eventa IPC Contracts (Minimal Set)

**User Story:** As a developer, I want type-safe IPC contracts for Hacking Session operations with minimal duplication, so that renderer and main process communication is reliable without redundant events.

#### Acceptance Criteria

1. THE IPC_Contracts SHALL define exactly TWO invoke events:
   - `electronHackingSessionActivate` (params: { codeMode?: string, providerConfig?: object }) returns { success: boolean, sessionId?: string, error?: string }
   - `electronHackingSessionDeactivate` returns { success: boolean }
2. THE IPC_Contracts SHALL define exactly TWO broadcast events:
   - `electronHackingSessionStateChanged` with payload: { sessionId: string | null, state: "inactive" | "starting" | "active" | "failed", processInfo?: { pid: number, port: number }, lastError?: string }
   - `electronCodeSummaryReceived` with payload: { sessionId: string, text: string, metadata: { mode: string, model: string, tokens: number } }
3. THE IPC_Contracts SHALL include TypeScript interfaces for all payload structures
4. ALL IPC contracts SHALL follow the existing Eventa naming convention (eventa:invoke:electron:hacking-session:*, eventa:broadcast:electron:*)
5. THE IPC_Contracts SHALL NOT include separate health monitoring events (health is derived from state field)
6. THE IPC_Contracts SHALL NOT include mode-only events (mode is part of state payload)

### Requirement 8: Code Module as Dumb Execution Runtime

**User Story:** As a developer, I want Code_Module to have no knowledge of AIRI and operate as a pure execution runtime, so that coupling is minimized and Code remains independently testable.

#### Acceptance Criteria

1. THE Code_Module SHALL NOT import any AIRI-specific types, modules, or configurations
2. THE Code_Module SHALL accept configuration via HTTP POST /config endpoint with generic payload: { provider: object, mode: string, sessionId: string }
3. WHEN Code_Module receives configuration, THE Code_Module SHALL apply settings to its internal state without validating against AIRI schema
4. THE Code_Module SHALL emit summaries via WebSocket /bridge with payload: { type: "summary", text: string, metadata: object, sessionId: string }
5. THE Code_Module SHALL NOT maintain any AIRI session state or awareness of whether it is embedded vs standalone
6. THE Code_Module SHALL execute LLM tasks based solely on input messages received via WebSocket, treating all clients identically
7. THE Code_Module SHALL throttle summary emissions to max 1 per second per WebSocket client connection
8. THE Code_Module SHALL validate authentication token on /bridge WebSocket connections and close with code 4001 if invalid

### Requirement 9: Settings UI Integration

**User Story:** As an AIRI user, I want to configure Hacking Session settings from the settings UI, so that I can control activation, see status, and select Code modes.

#### Acceptance Criteria

1. THE Settings_Page SHALL include a "Hacking Mode" section in the appropriate settings category (e.g., "Developer Tools" or "Advanced")
2. THE Settings_Page SHALL subscribe to `electronHackingSessionStateChanged` and display current state: "Inactive", "Starting...", "Active", or "Failed"
3. WHEN state is "active", THE Settings_Page SHALL display processInfo.pid and processInfo.port for debugging
4. WHEN state is "failed", THE Settings_Page SHALL display lastError message with red/error styling
5. THE Settings_Page SHALL provide a toggle button with labels: "Activate Hacking Mode" (when inactive) / "Deactivate Hacking Mode" (when active)
6. WHEN toggle is clicked and state is "inactive", THE Settings_Page SHALL invoke `electronHackingSessionActivate` with { codeMode: <selected-mode>, providerConfig: <airi-config> } and show loading spinner
7. WHEN toggle is clicked and state is "active", THE Settings_Page SHALL invoke `electronHackingSessionDeactivate` and show loading spinner
8. THE Settings_Page SHALL disable the toggle button while state is "starting" (prevent duplicate activation)
9. THE Settings_Page SHALL include a dropdown for selecting Code mode with options: "Spec", "Vibe", "Boss", "Ask", "Debug" (default: "Vibe")
10. WHEN mode selection changes, THE Settings_Page SHALL persist choice to app config and only apply on next activation
11. THE Settings_Page SHALL include keyboard shortcut display: "Ctrl+Shift+H (Cmd+Shift+H on macOS)" with explanatory text

### Requirement 10: Error Handling and User Notifications

**User Story:** As an AIRI user, I want clear error messages when Hacking Session fails, so that I understand what went wrong and can take corrective action.

#### Acceptance Criteria

1. WHEN Hacking_Session state transitions to "failed", THE Hacking_Session_Service SHALL display a notification with title "Hacking Mode Failed" and message from lastError field
2. THE notification SHALL include troubleshooting steps based on error type:
   - Port conflict: "Port 3210 is in use. Close conflicting application or change Code backend port."
   - Process crash: "Code backend crashed. Check logs in ~/.kiro/logs/hacking-session.log"
   - Timeout: "Code backend did not become ready in time. Ensure modules/code dependencies are installed."
3. WHEN Code_Process crashes while state is "active", THE Hacking_Session_Service SHALL automatically transition to "failed" and deactivate
4. THE Hacking_Session_Service SHALL log all errors to main process console using `@guiiai/logg` with namespace "hacking-session" and level "error"
5. ERROR logs SHALL include: timestamp, sessionId, state before error, error message, stack trace, processInfo (PID, port)
6. WHEN BrowserView load fails after retry, THE lastError SHALL be set to "BrowserView failed to load after 2 attempts"
7. THE Settings_Page SHALL display a "Retry" button when state is "failed"

### Requirement 11: Keyboard Shortcut for Toggle

**User Story:** As an AIRI user, I want a keyboard shortcut to toggle Hacking Session on/off, so that I can quickly switch contexts without using the mouse.

#### Acceptance Criteria

1. THE Shortcut_Controller SHALL register Ctrl+Shift+H (Cmd+Shift+H on macOS) as the Hacking Session toggle shortcut using existing global shortcut service
2. WHEN shortcut is pressed and Hacking_Session state is "inactive", THE Shortcut_Controller SHALL invoke `electronHackingSessionActivate`
3. WHEN shortcut is pressed and Hacking_Session state is "active", THE Shortcut_Controller SHALL invoke `electronHackingSessionDeactivate`
4. WHEN shortcut is pressed and state is "starting", THE Shortcut_Controller SHALL do nothing (debounce to prevent double activation)
5. WHEN shortcut is pressed and state is "failed", THE Shortcut_Controller SHALL attempt activation (implicit retry)
6. THE shortcut SHALL be configurable via settings UI (stored in app config as "hackingModeShortcut")
7. THE Shortcut_Controller SHALL display notification when shortcut is triggered: "Activating Hacking Mode..." or "Deactivating Hacking Mode..."

### Requirement 12: Renderer Integration and State Subscription

**User Story:** As a developer, I want renderer components to subscribe to Hacking Session state via Eventa, so that UI updates are reactive and derived from single source of truth.

#### Acceptance Criteria

1. THE Chat_Component (renderer) SHALL subscribe to `electronHackingSessionStateChanged` broadcast event
2. WHEN state is "inactive" or "failed", THE Chat_Component SHALL display AIRI chatbox and hide Code BrowserView overlay
3. WHEN state is "active", THE Chat_Component SHALL hide AIRI chatbox and show Code BrowserView overlay
4. WHEN state is "starting", THE Chat_Component SHALL display loading indicator: "Activating Hacking Mode..."
5. THE Chat_Component SHALL use CSS transitions (duration: 300ms) for smooth visibility changes
6. THE Chat_Component SHALL ensure only ONE interface is visible at a time (no overlap)
7. THE Chat_Component SHALL pass current Hacking_Session state to Input_Gateway for routing decisions
8. THE Chat_Component SHALL display visual indicator badge when state is "active": "Code Mode: <mode>" (e.g., "Code Mode: Vibe")

### Requirement 13: Session Identity and Correlation

**User Story:** As a developer, I want a shared session ID to correlate activity across AIRI and Code_Module, so that reconnects, logs, and summaries can be tracked across the lifecycle.

#### Acceptance Criteria

1. THE Hacking_Session_Service SHALL generate a unique sessionId (UUID v4) when state transitions from "inactive" to "starting"
2. THE sessionId SHALL be included in Code_Bridge_Service WebSocket handshake: `{ type: "auth", sessionId, token }`
3. THE sessionId SHALL be included in HTTP POST to /config endpoint as header: `X-Session-ID: <sessionId>`
4. WHEN Code_Module emits summary messages, THE payload SHALL include sessionId: `{ type: "summary", sessionId, text, metadata }`
5. THE Hacking_Session_Service SHALL include sessionId in all log entries using structured logging: `{ sessionId, level, message, ... }`
6. WHEN state transitions to "inactive", THE sessionId SHALL be cleared (set to null)
7. IF Code_Bridge_Service receives a message with mismatched sessionId, THE Service SHALL log warning and ignore the message
8. THE sessionId SHALL be exposed in `electronHackingSessionStateChanged` payload for debugging and correlation

### Requirement 14: Code Backend WebSocket Bridge Endpoint

**User Story:** As a developer, I want Code Backend to expose a /bridge WebSocket endpoint for Electron connections, so that summaries and metadata flow to AIRI without polling.

#### Acceptance Criteria

1. THE Code_Backend SHALL implement a WebSocket endpoint at ws://localhost:3210/bridge
2. WHEN a WebSocket client connects to /bridge, THE Code_Backend SHALL expect handshake message: `{ type: "auth", sessionId: string, token: string }`
3. THE Code_Backend SHALL validate token against shared secret (environment variable CODE_BRIDGE_TOKEN or default: "animaios-hacking-bridge")
4. IF authentication fails (invalid token), THEN THE Code_Backend SHALL close WebSocket with code 4001 and reason "Authentication failed"
5. IF authentication succeeds, THEN THE Code_Backend SHALL store connection with sessionId mapping
6. WHEN Code_Module completes a task and generates a summary, THE Code_Backend SHALL emit to all authenticated /bridge clients: `{ type: "summary", sessionId, text, metadata: { mode, model, tokens } }`
7. THE Code_Backend SHALL implement keepalive pings every 30000ms to detect stale connections
8. THE Code_Backend SHALL close connections gracefully when receiving SIGTERM or SIGINT signals

### Requirement 15: Code Backend Configuration Endpoint

**User Story:** As a developer, I want Code Backend to accept configuration via HTTP POST, so that AIRI can sync provider settings without Code_Module knowing about AIRI.

#### Acceptance Criteria

1. THE Code_Backend SHALL implement HTTP POST endpoint at /config accepting JSON payload: `{ provider: object, mode: string, sessionId: string }`
2. THE Code_Backend SHALL validate X-Session-ID header matches sessionId in payload
3. IF sessionId mismatch, THEN THE Code_Backend SHALL respond with HTTP 400 "Session ID mismatch"
4. IF valid, THE Code_Backend SHALL apply provider config to Code_Module settings (overwriting stored settings)
5. THE Code_Backend SHALL apply mode selection (Spec, Vibe, Boss, Ask, Debug) to active instance
6. THE Code_Backend SHALL respond with HTTP 200 and JSON: `{ success: true, appliedConfig: { provider: string, mode: string } }`
7. IF config application fails, THEN THE Code_Backend SHALL respond with HTTP 500 and error message
8. THE Code_Backend SHALL NOT persist configuration (config is ephemeral per session)
9. THE Code_Backend SHALL accept configuration updates while running (hot reload)

### Requirement 16: Provider Configuration Mapping

**User Story:** As a developer, I want AIRI's provider config to be mapped to Code_Module format, so that users don't need to configure providers twice.

#### Acceptance Criteria

1. THE Hacking_Session_Service SHALL read AIRI's current provider configuration from app config when activate() is called
2. THE Hacking_Session_Service SHALL extract provider fields: { name, apiKey, baseUrl?, model?, temperature?, maxTokens? }
3. THE Hacking_Session_Service SHALL map AIRI provider names to Code_Module provider names using lookup table:
   - "openai" → "openai"
   - "anthropic" → "anthropic"
   - "gemini" → "gemini"
   - "openrouter" → "openrouter"
   - (extend as needed for common providers)
4. IF AIRI provider name is not in lookup table, THEN THE Service SHALL pass provider name unchanged and log warning
5. THE Hacking_Session_Service SHALL construct config payload: `{ provider: { name: <mapped>, apiKey, baseUrl?, model?, temperature?, maxTokens? }, mode: <selected>, sessionId }`
6. THE Code_Bridge_Service SHALL send config payload to POST /config after WebSocket handshake completes
7. IF config POST fails, THEN THE Service SHALL log error but continue activation (Code uses stored settings)
8. THE mapping table SHALL be configurable via app config for extensibility

### Requirement 17: Graceful Degradation and AIRI Continuity

**User Story:** As an AIRI user, I want AIRI to continue working normally if Hacking Session fails, so that a Code integration issue doesn't prevent me from using AIRI's core features.

#### Acceptance Criteria

1. IF Code_Process fails to start within 30000ms during app initialization, THEN THE Hacking_Session_Service SHALL mark state as "failed" and continue AIRI startup
2. THE Main_Window SHALL load and render normally regardless of Hacking_Session state
3. THE Chat_Component SHALL display AIRI chatbox and function normally when state is "failed" or "inactive"
4. WHEN state is "failed", THE Settings_Page SHALL display error message with "Retry" button
5. WHEN "Retry" button is clicked, THE Settings_Page SHALL invoke `electronHackingSessionActivate` (implicit retry)
6. THE AIRI chat interface SHALL support all core features in "inactive" state: text input, TTS, provider selection, history, settings
7. THE Hacking_Session_Service SHALL NOT block AIRI initialization or operation
8. IF state is "failed" at app startup, THE Hacking_Session_Service SHALL log error to ~/.kiro/logs/hacking-session.log but NOT show notification (avoid startup spam)

### Requirement 18: Logging and Observability

**User Story:** As a developer, I want comprehensive structured logging for all Hacking Session operations, so that I can diagnose issues in production and development environments.

#### Acceptance Criteria

1. THE Hacking_Session_Service SHALL use `@guiiai/logg` for all logging with namespace "hacking-session"
2. THE Hacking_Session_Service SHALL use structured logging with fields: { sessionId, state, timestamp, level, message, metadata }
3. WHEN state transitions occur, THE Service SHALL log: { level: "info", message: "State transition", from: <old-state>, to: <new-state>, reason: <trigger> }
4. WHEN Code_Process starts, THE Service SHALL log: { level: "info", message: "Process started", pid, port, startupDuration: <ms> }
5. WHEN errors occur, THE Service SHALL log: { level: "error", message: <error>, stack: <trace>, context: { sessionId, state, processInfo } }
6. THE Code_Bridge_Service SHALL log WebSocket state changes: { level: "debug", message: "WebSocket <event>", sessionId, event: "connected" | "disconnected" | "error" }
7. THE UI_Adapter_Layer SHALL log BrowserView lifecycle: { level: "debug", message: "BrowserView <event>", id: <view-id>, bounds: { x, y, width, height } }
8. ALL log entries SHALL include timestamp (ISO 8601 format) and sessionId when available
9. THE Hacking_Session_Service SHALL write logs to ~/.kiro/logs/hacking-session.log with daily rotation (max 7 days retention)
10. IN debug mode (env var HACKING_SESSION_DEBUG=1), THE Service SHALL also log to console and include additional metadata

