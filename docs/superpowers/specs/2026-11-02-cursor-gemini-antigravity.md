# WOTS RELAY — CURSOR & GOOGLE ANTIGRAVITY INTEGRATION

(Spec supplied by the owner on 2026-11-02; stored verbatim so the implementation plan can cite it.)

## ROLE

You are a senior software architect, TypeScript engineer, AI agent orchestration specialist, and security engineer.

Your task is to extend the existing Wots Relay application by integrating two additional AI coding providers:

1. Cursor CLI
2. Google Antigravity / Gemini

Wots Relay already supports Claude Code and OpenAI Codex. Your responsibility is to integrate the additional providers without breaking existing functionality.

**DO NOT rebuild the application from scratch.**

## 1. MANDATORY PLANNING

Before implementing anything:

1. Inspect the entire existing repository.
2. Read `CLAUDE.md`, `AGENTS.md`, and relevant project documentation.
3. Use the Superpowers skill for brainstorming, architectural planning, implementation planning, and verification where available.
4. Identify the current provider architecture.
5. Identify existing authentication, session management, and fallback mechanisms.
6. Identify the desktop, mobile, and terminal execution boundaries.
7. Review existing tests and security controls.
8. Consult current official documentation for every CLI command and integration method.

Produce an implementation plan containing:

- Existing architecture summary
- Proposed provider adapter architecture
- Required file changes
- Database/schema changes, if necessary
- Security considerations
- Provider-specific limitations
- Testing strategy
- Migration and rollback strategy

Follow the approved architecture and implement in small, testable stages.

Do not invent CLI flags, subscription capabilities, or undocumented authentication methods.

## 2. PROVIDER ARCHITECTURE

Support the following providers:

| Provider | Provider ID | Interface |
|---|---|---|
| Claude Code | claude | Existing CLI |
| OpenAI Codex | codex | Existing CLI |
| Cursor | cursor | Cursor CLI |
| Google Gemini | gemini | Official Gemini API / supported integration |
| Antigravity | antigravity | Standalone CLI launch where permitted |

Default provider priority:

1. Claude
2. Codex
3. Cursor
4. Gemini

Allow users to change this priority.

Distinguish Gemini API integration from the consumer Antigravity CLI. They must not be treated as interchangeable authentication or billing systems.

IMPORTANT: Google's published terms do not support wrapping consumer Antigravity CLI inside third-party applications or automating consumer account rotation. Do not implement such behavior. Support a legitimate Gemini API integration for automatic fallback and offer an independent Antigravity launch option where appropriate.

## 3. PROVIDER ADAPTER SYSTEM

Implement a modular provider adapter architecture.

Each provider should expose a consistent contract:

- `detectInstallation()`
- `getVersion()`
- `checkAuthentication()`
- `listModels()`
- `startSession()`
- `sendPrompt()`
- `streamResponse()`
- `cancelExecution()`
- `getStatus()`
- `classifyError()`
- `prepareHandoff()`
- `dispose()`

Only implement methods genuinely supported by the underlying provider.

Unsupported capabilities must be explicitly reported, never silently simulated.

Define shared types for:

- Provider ID
- Model ID
- Session ID
- Agent execution state
- Provider capabilities
- Authentication state
- Usage state
- Rate-limit error
- Handoff context
- Execution permissions
- Provider result

Use strict TypeScript typing and runtime validation for external provider output.

Preserve the existing architecture and coding conventions wherever practical.

## 4. CURSOR CLI INTEGRATION

Official documentation:

https://cursor.com/docs/cli/overview

### Installation detection

Detect supported executable names, including `agent` and legacy `cursor-agent`, where installed.

Verify the binary rather than assuming it exists.

Example installation:

```bash
curl https://cursor.com/install -fsS | bash
```

Do not automatically download or execute an installer without explicit user approval.

### Authentication

Support Cursor's documented authentication methods, including:

- Browser-based account login
- Supported API-key authentication

Examples:

```bash
agent login
agent status
```

Do not collect Cursor account passwords inside Wots Relay.

Use the provider's supported authentication process.

### Execution

Implement the documented non-interactive interface.

Example:

```bash
agent -p "Analyze this project" --output-format json
```

Requirements:

- Support streaming where available.
- Parse structured output.
- Capture execution errors.
- Display execution progress.
- Support cancellation.
- Preserve execution logs.
- Respect the user's configured permissions.
- Run inside the selected project directory.
- Support configurable model selection when available.

Never automatically enable unrestricted command execution.

Do not assume every Cursor model is available to every account.

## 5. GOOGLE GEMINI INTEGRATION

Implement Gemini as an independently selectable coding provider using a supported Google API.

Documentation:

https://ai.google.dev/

Requirements:

- Support API-key authentication.
- Load supported models dynamically where possible.
- Support streaming output.
- Provide structured tool execution through Wots Relay's existing local execution layer.
- Preserve project context across turns.
- Support code generation, editing, reasoning, debugging, and testing.
- Track token usage when exposed by the API.
- Report quotas and API errors accurately.

Use official SDKs where practical.

Do not invent a Gemini subscription-to-API entitlement. API billing and consumer subscriptions may differ.

## 6. ANTIGRAVITY CLI SUPPORT

Official documentation:

https://antigravity.google/docs/getting-started?tab=cli

Detect installation of:

```bash
agy
```

Offer:

- Installation status
- Version information
- Documentation link
- Launch in an independent terminal session
- Supported workspace selection
- Clear account/API authentication guidance

Antigravity supports headless operation:

```bash
agy -p "Explain this codebase"
```

However, do not invoke this through Wots Relay under a consumer Antigravity account, because Google's published restrictions prohibit wrapping consumer use inside third-party applications.

For any future automated Antigravity integration, require a documented, authorized use case and compatible authentication method. Otherwise, route automation through Gemini's supported API integration.

## 7. AUTOMATIC FALLBACK ENGINE

Extend Wots Relay's existing fallback engine.

Default priority:

```text
Claude → Codex → Cursor → Gemini
```

Users must be able to:

- Enable or disable individual providers.
- Reorder fallback priorities.
- Select a primary provider.
- Manually switch providers.
- Enable or disable automatic fallback.
- Configure fallback notifications.

### Fallback triggers

Detect:

1. Confirmed rate-limit errors
2. Confirmed quota exhaustion
3. Authentication expiration
4. Provider unavailability
5. Network failures
6. Execution crashes
7. User-requested switching

Different errors require different treatment.

A provider quota error may trigger fallback.

An authentication error must prompt the user to reconnect the provider or skip it.

A network failure should use bounded retries before considering fallback.

Do not interpret an ordinary coding error, failed test, or rejected tool execution as a provider usage limit.

### Fallback algorithm

```text
1. Receive user task.
2. Select active provider.
3. Begin execution.
4. Monitor structured provider results.
5. If execution succeeds, continue normally.
6. If a recoverable failure occurs, retry according to policy.
7. If fallback is appropriate:
   a. Stop the active execution safely.
   b. Capture the task state.
   c. Capture relevant file changes.
   d. Capture completed and pending actions.
   e. Select the next available authorized provider.
   f. Transfer the verified task context.
   g. Resume from the unfinished work.
8. If no provider is available:
   a. Preserve the session.
   b. Explain the problem.
   c. Offer manual recovery.
```

Never automatically switch to a provider that lacks valid authorization.

Avoid infinite fallback loops.

Add maximum retry counts, execution timeouts, and per-provider cooldowns.

## 8. CROSS-PROVIDER CONTEXT HANDOFF

This is one of the most important Wots Relay features.

When switching providers, the next coding agent must receive enough information to continue the task without repeating completed work.

Implement a provider-independent handoff record containing:

```json
{
  "taskId": "task-id",
  "previousProvider": "claude",
  "nextProvider": "cursor",
  "originalRequest": "Build authentication",
  "completedWork": [],
  "pendingWork": [],
  "modifiedFiles": [],
  "testsExecuted": [],
  "knownErrors": [],
  "lastSuccessfulCheckpoint": null,
  "handoffReason": "rate_limit"
}
```

Extend the schema as necessary.

Capture:

- Original user instructions
- Current task objective
- Relevant conversation summary
- Completed work
- Pending actions
- Current Git status
- Modified files and diffs
- Test results
- Known problems
- Decisions already made
- User-approved execution permissions

Preserve the working directory and existing uncommitted changes.

Do not automatically reset, discard, or overwrite changes.

Do not pass secrets, credentials, private environment files, or unrelated user data to another provider.

Context continuity does not require transferring a provider's proprietary hidden state.

Instead, create a clean, portable task summary using observable task data.

Prevent duplicate file operations and repeated destructive actions after handoff.

## 9. USER INTERFACE

Extend Wots Relay's existing UI.

Keep the design simple, clean, and consistent with the current application.

### Provider selector

Display available providers:

- Claude
- Codex
- Cursor
- Gemini

Each should show:

- Provider name
- Current status
- Selected model
- Authentication status
- Availability
- Whether automatic fallback is enabled

Do not show invented quota percentages.

### Agent switching

Provide a clear status indicator when a handoff occurs.

Example:

"Claude reached its usage limit. Continuing with Cursor."

The user should be able to:

- View the active provider
- Understand why a provider switched
- Inspect the handoff summary
- Cancel execution
- Choose another provider manually

### Settings

Create or extend a provider configuration page.

Include:

- Provider connections
- Installation checks
- Model selection
- Fallback priorities
- Automatic switching
- Execution permissions
- Provider diagnostics
- Antigravity standalone launch option

Preserve existing styling, responsiveness, and accessibility.

## 10. TERMINAL INTEGRATION

Maintain Wots Relay's terminal-based workflow.

Extend the existing CLI rather than replacing it.

Suggested commands, subject to current CLI conventions:

```bash
relay providers
relay provider cursor
relay provider gemini
relay status
relay fallback on
relay fallback off
relay doctor
```

Suggested additional commands:

```bash
relay providers check
relay providers auth cursor
relay handoff status
```

These are proposed Wots Relay commands, not existing provider CLI commands.

The CLI should:

- Detect installed providers.
- Display authentication readiness.
- Allow manual provider selection.
- Display fallback activity.
- Stream agent output.
- Support interactive cancellation.
- Save recoverable execution state.

Do not introduce breaking CLI changes.

## 11. DESKTOP AND MOBILE SUPPORT

Preserve Wots Relay's planned cross-platform architecture.

### macOS

Allow authorized local CLI execution through the appropriate backend.

### Mobile

Do not assume mobile applications can directly execute macOS CLI binaries.

If remote execution already exists, integrate through the authenticated backend.

Otherwise, clearly separate:

- Local execution
- Remote execution
- Unsupported execution modes

Never expose an unrestricted shell execution API to mobile clients.

## 12. SECURITY REQUIREMENTS

Security is mandatory.

Implement or preserve:

- Secure credential storage
- Least-privilege execution
- Process argument validation
- Command execution boundaries
- Directory access restrictions
- Safe cancellation
- Secret redaction
- Structured audit logs
- Encrypted sensitive data where appropriate
- Provider authentication isolation
- User approval for destructive commands

Never:

- Store plaintext passwords.
- Extract browser session cookies.
- Bypass provider usage limits.
- Rotate accounts to evade quotas.
- Circumvent provider authentication.
- Run arbitrary commands received from an untrusted client.
- Automatically commit or push code unless authorized.
- Execute destructive Git commands without approval.

Provider switching must respect all provider terms and permitted access methods.

## 13. ERROR HANDLING

Create a shared provider error classification system.

Include categories:

- RATE_LIMIT
- QUOTA_EXCEEDED
- AUTH_EXPIRED
- PROVIDER_UNAVAILABLE
- NETWORK_ERROR
- TIMEOUT
- PERMISSION_DENIED
- EXECUTION_ERROR
- USER_CANCELLED
- UNKNOWN

Use provider-specific adapters to classify documented errors.

Preserve unrecognized error information for debugging after redacting sensitive values.

Never silently suppress errors.

## 14. TESTING

Create comprehensive automated tests.

### Cursor tests

- CLI installed
- CLI missing
- Authenticated
- Authentication expired
- Prompt execution
- Streaming output
- Structured output parsing
- Rate-limit handling
- Cancellation

### Gemini tests

- Valid API key
- Invalid API key
- Model discovery
- API response
- Streaming
- Quota exhaustion
- API failure
- Tool permission checks

### Fallback tests

- Claude to Codex
- Codex to Cursor
- Cursor to Gemini
- Multiple unavailable providers
- All providers unavailable
- Manual provider switching
- Context handoff
- Retry limits
- Cancellation during handoff
- Recovery from interrupted execution

### Security tests

- Command injection attempts
- Path traversal attempts
- Secret leakage
- Unauthorized execution
- Malformed provider responses
- Sensitive logging
- Concurrent execution conflicts

Mock provider calls in automated unit tests.

Keep real provider integration tests optional and clearly identify tests that may incur charges.

## 15. DOCUMENTATION

Update project documentation.

Include:

- New provider architecture
- Cursor installation instructions
- Gemini API setup
- Antigravity CLI standalone setup
- Authentication instructions
- Fallback configuration
- Handoff architecture
- Security model
- Troubleshooting guide
- Known provider limitations

Do not describe restricted or unimplemented features as working.

## 16. COMPLETION CRITERIA

The implementation is complete only when:

- Cursor CLI is integrated through a tested adapter.
- Gemini is integrated through a supported API.
- Antigravity standalone functionality is clearly separated from automated integration.
- Existing Claude and Codex functionality remains operational.
- Users can manually select providers.
- Automatic fallback respects provider availability and permissions.
- Task handoffs preserve meaningful context.
- Existing project changes are protected.
- Authentication failures are handled safely.
- Unit and integration tests pass.
- Documentation is updated.
- The application builds successfully.

## 17. FINAL INSTRUCTIONS

Follow this sequence:

1. Inspect the existing codebase.
2. Use Superpowers planning skills where available.
3. Produce a detailed implementation plan.
4. Identify risks and compatibility issues.
5. Implement the provider adapters.
6. Extend the fallback engine.
7. Implement context handoffs.
8. Update the UI and terminal interface.
9. Add tests.
10. Run builds, linting, type checking, and tests.
11. Review the implementation for security issues.
12. Document the completed changes.

Prioritize reliability over unnecessary complexity.

Do not replace functioning code without a clear reason.

Do not claim success without running the relevant verification steps.

The ultimate goal is for Wots Relay to become a reliable, extensible AI coding workspace that can intelligently continue development across multiple authorized AI providers while preserving project state, security, and user control.
