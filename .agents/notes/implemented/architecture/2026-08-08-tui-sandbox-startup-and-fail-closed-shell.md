# Agent Note: TUI sandbox startup and fail-closed Shell

Status: implemented

## Problem
The TUI is an interactive long-lived authority surface. Deferring native sandbox
startup until the first model-requested Shell command makes readiness ambiguous,
and a host-Bash downgrade would let later TUI Shell tools escape isolation.

## Decision
1. The TUI starts a no-op (`:`) isolated Shell invocation when it mounts.
2. TUI composition always uses `unavailableFallback='fail'`. A disabled,
   missing, or unavailable native backend refuses Shell rather than invoking
   host Bash, cmd, or PowerShell.
3. Every actual Shell tool call still creates its own invocation boundary; the
   startup invocation is only an early readiness and diagnostic check.
4. Foreground CLI retains the availability downgrade authorized by [Agent Note 0075](../feature/2026-08-08-app-shell-availability-downgrade.md).
5. A preflight failure is surfaced in the TUI and does not weaken later
   fail-closed enforcement.

## Alternatives considered

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences
- TUI startup detects an unavailable runner before the first agent task.
- All TUI Shell scripts either run in the selected native sandbox or fail.
- The TUI does not claim a persistent AppContainer process between invocations.
