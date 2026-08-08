# ADR-0075: App Shell availability downgrade

Status: accepted

Date: 2026-08-05

## Context

The native sandbox is preferred when available, but the user explicitly
authorizes shell availability over a refusal when that backend cannot be used.
The app composition previously hard-coded a fail-closed fallback whenever an
execution boundary was present.

## Decision

1. App TUI and foreground CLI composition use `bare_shell` when a sealed
   surface admits Shell and the native sandbox is unavailable or explicitly
   disabled.
2. On Windows this invokes the existing host Bash resolution path: system Git
   Bash first, then vendored Bash, and finally `cmd.exe` only if Bash is absent.
3. A selected and started native runner never retries through the host shell.
   Its execution failure, timeout, cancellation, or cleanup failure remains a
   failure.
4. A sealed surface that does not admit Shell, or a boundary with
   `filesystemScope=full_access`, still returns the stable unavailable refusal.
5. The fallback is explicitly unisolated. It does not satisfy filesystem,
   protected-path, process-tree, or network enforcement; no evidence or
   production qualification may count it as sandbox execution.

## Consequences

- App Shell remains usable when a runner binary is missing, invalid, or its
  platform backend cannot be selected.
- The user accepts the host authority of the command in that condition.
- Existing production qualification remains excluded and requires native
  evidence independently of this availability behavior.

## Reversibility

ADR-0077 supersedes this TUI/CLI composition split; this record remains as the
historical rationale for treating host fallback as unisolated execution.
