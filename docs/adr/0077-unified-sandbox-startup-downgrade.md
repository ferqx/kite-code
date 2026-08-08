# ADR-0077: Unified sandbox startup downgrade and host Shell resolution

Status: accepted

Date: 2026-08-05

## Context

TUI and foreground CLI previously diverged: the CLI could downgrade when no
backend was selected, while ADR-0076 made the TUI fail closed. The user now
requires the same behavior on Windows, macOS, and Linux: prefer the native
sandbox, but retain Shell availability when that sandbox cannot start.

Retrying an arbitrary failed sandbox command in a host shell is unsafe because
the user script may already have produced effects. Bash, cmd, and PowerShell
also have different syntax, so fallback must preserve a deterministic default
while allowing callers to invoke another installed interpreter explicitly.

## Decision

1. TUI and foreground CLI use the same startup state machine.
2. Before any user script, the App executor runs one isolated no-op (`:`)
   invocation and caches the result for its lifetime.
3. A successful preflight selects the native sandbox. A failed preflight, a
   disabled sandbox, or an unavailable backend selects the host Shell.
4. User scripts execute exactly once in the selected environment. A non-zero
   exit, timeout, cancellation, cleanup failure, or later runner failure never
   retries the script in another interpreter.
5. The TUI starts preflight on mount and shares that executor with all sessions.
   Foreground CLI completes the same preflight before admitting Full mode.
6. Host resolution is cross-platform and ordered. Windows tries system/vendored
   Bash, cmd, then PowerShell when an earlier interpreter cannot start.
   macOS/Linux prefer Bash or the configured POSIX shell and may use installed
   cmd/PowerShell candidates before the final POSIX sh fallback.
7. Commands default to Bash/POSIX syntax. A command may explicitly invoke
   `cmd.exe`, `pwsh`, or `powershell.exe` when installed.
8. Host fallback projects effective backend `none`; Full remains unavailable.
9. A sealed capability surface that denies Shell, or requests unsupported
   `full_access`, is a policy denial and never falls back.

## Consequences

- Windows, macOS, and Linux have one sandbox-first availability policy.
- Startup failure remains recoverable without risking duplicate user effects.
- Native sandbox qualification never counts host execution as isolation.
- Per-invocation failures after successful preflight remain fail closed because
  current protocols cannot prove that the user command never started.

## Supersession

This ADR supersedes ADR-0076's TUI fail-closed availability decision and
supersedes ADR-0075's TUI/CLI divergence. Their historical rationale remains
unchanged.
