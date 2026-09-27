# Agent Note: Host Shell fallback is limited to sandbox-environment unavailability

Status: implemented

## Problem
The App-level startup state machine needs one recoverable route when a required
native sandbox environment cannot be selected or started. That route is useful
on every desktop platform: it preserves interactive Shell access while projecting
effective backend `none` and keeping Full unavailable.

The old Windows AppContainer private-workspace path also has a separate
admission phase. Its Worker scan, staging budget, timeout, and later staging
checks decide whether this *experimental backend* may receive a command. They
do not prove that the host environment is safe to execute the command instead.
Treating a rejected copy budget as native-backend unavailability accidentally
turns an isolation admission error into an unrestricted execution decision.

The successor managed restricted-token design instead targets the real
Workspace directly. It must not copy the repository on the normal path, but it
is not selectable until its managed identity, restricted token, ACL recovery,
network boundary, dynamic protected-name projection/COW enforcement, pinned
runtime, and Win10 API baseline are all independently available.

## Decision
1. A foreground App may choose host Bash/cmd/PowerShell before a user script
   only when its required sandbox environment or an essential structural native
   startup capability is unavailable. The decision is cached as backend `none`;
   it is never sandbox evidence and Full remains disabled.
2. Once an experimental AppContainer backend has been selected, private
   Workspace staging assessment failure is an admission denial. Worker startup,
   protocol, traversal, timeout, invalid-budget, file-count, or byte-budget
   failure returns a fail-closed executor. It must not select a host executor
   and must not run or replay the user script.
3. A command-time staging/reconciliation/cleanup/runner failure remains
   fail-closed for the same reason. The `:` structural startup probe may still
   lead to host fallback only when it establishes that the selected sandbox
   environment itself cannot start before any user command.
4. Windows default selection prioritizes the managed restricted-token direct
   Workspace backend. It accesses the real Workspace through its qualified
   projection/COW boundary and does not create a full-repository staging copy.
   The AppContainer staging backend remains explicit migration/experimental
   only and is never the large-Workspace default.
5. Elevated managed provisioning is preferred; an unelevated candidate is
   considered only after elevated setup cannot qualify. If neither candidate
   supplies every required capability, the sandbox environment is unavailable
   and the normal cross-platform host-Shell fallback rule applies.

## Alternatives considered

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences
- An oversized experimental AppContainer Workspace is rejected promptly rather
  than waiting to copy it or silently running the requested command on host.
- The TUI remains responsive because the bounded experimental admission scan is
  off the main event loop; responsiveness does not weaken the execution
  boundary.
- On a machine without the managed projection/COW prerequisite, Windows
  immediately reports a managed-sandbox availability reason and may use the
  host Shell with Full unavailable. It performs no repository staging copy on
  that default route.
- The same availability-vs-admission distinction applies to Windows, macOS,
  and Linux App composition.

## Supersession
This Agent Note supersedes [Agent Note 0077](2026-08-08-unified-sandbox-startup-downgrade.md) only where its phrase "failed preflight" could
include a selected backend's workspace-admission failure. It supersedes
[Agent Note 0079](../architecture/2026-08-08-windows-managed-restricted-token-sandbox.md) decision item 6 and its related consequence that classified an
AppContainer staging-budget excess as host-Shell availability unavailability.
The dynamic protected-path requirement, Windows Worker isolation,
and [Agent Note 0079](../architecture/2026-08-08-windows-managed-restricted-token-sandbox.md)'s managed restricted-token direction otherwise remain in force.

## Historical relationships

Related: [Agent Note 0054](../architecture/2026-07-30-production-execution-isolation.md), [Agent Note 0061](../process/2026-07-31-production-platform-capability-admission.md), [Agent Note 0077](2026-08-08-unified-sandbox-startup-downgrade.md), [Agent Note 0079](../architecture/2026-08-08-windows-managed-restricted-token-sandbox.md)
