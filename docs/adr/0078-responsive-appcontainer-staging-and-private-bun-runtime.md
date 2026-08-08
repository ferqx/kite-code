# ADR-0078: Responsive AppContainer staging and private Bun runtime

Status: accepted

Date: 2026-08-05

## Context

ADR-0077 starts sandbox qualification when the TUI mounts. On Windows, the
AppContainer adapter originally copied, hashed, reconciled, and deleted the
entire Workspace synchronously on the Ink event-loop thread. The startup
preflight therefore delayed input focus, and every real Shell invocation froze
the prompt and Working animation while staging ran.

The AppContainer intentionally grants no access to arbitrary host PATH roots.
Consequently, inheriting the host PATH did not make a user-profile Bun
installation executable inside the container; isksh reported that `bun` was
not found. Granting the whole installation directory would widen the sandbox
read surface beyond the invocation.

## Decision

1. TUI construction performs no synchronous backend qualification. Pending
   qualification projects backend `none`, keeps Full disabled, and leaves the
   prompt editable.
2. The cached `:` startup preflight uses a dedicated empty temporary Workspace.
   It validates the backend, runner, Shell, Job, ACL, and cleanup path without
   copying the user's real Workspace.
3. Each real Windows invocation owns one dedicated Worker for private Workspace
   creation, baseline retention, reconciliation, and physical runtime cleanup.
   Synchronous filesystem work stays inside that Worker rather than the TUI
   event loop.
4. Worker startup, protocol, reconciliation, or cleanup failure remains
   fail-closed. The adapter never falls back to synchronous main-thread staging,
   and it never replays a user command on the host.
5. When a canonical installed Bun executable is available, the Worker copies it
   into the invocation-private runtime before AppContainer ACL grants. That
   private runtime is placed first on PATH. The AppContainer receives no ACL
   grant on the host Bun installation, and the copy is removed with the
   invocation.
6. The lightweight startup preflight skips the Bun copy. A real Workspace
   executor may materialize Bun; a standalone Kite executable is never renamed
   or treated as Bun merely because it is `process.execPath`.
7. A SessionRuntime claims its single-flight run and creates its
   AbortController before waiting for sandbox preparation. Duplicate prompts
   cannot start concurrent agents, and cancellation during preparation prevents
   the agent from starting after preparation resolves.

## Consequences

- TUI input, timers, and Working animation remain responsive during AppContainer
  staging and reconciliation, although a command still waits for that isolated
  control-plane work to complete.
- Startup qualification is fast and independent of Workspace size.
- `bun run ...` can execute inside the Windows sandbox when a real Bun
  installation is available, without exposing its host directory.
- Each invocation pays for a private Bun copy and Workspace staging. Persistent
  sandbox workspaces or shared executable caches remain outside this decision.
- macOS and Linux keep the same App-level background-preflight and cached
  downgrade state machine; only the Windows staging implementation needs the
  Worker and private Bun copy.

## Relationship

This ADR refines ADR-0077's startup preflight implementation and ADR-0073's
private Workspace staging. It does not change their no-replay, protected-path,
or fail-closed reconciliation decisions.
