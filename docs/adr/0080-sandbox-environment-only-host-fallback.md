# ADR-0080: Host Shell fallback is limited to sandbox-environment unavailability

Status: accepted

Date: 2026-08-06

Related: ADR-0054, ADR-0061, ADR-0073, ADR-0077, ADR-0078, ADR-0079

## Context

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

This ADR supersedes ADR-0077 only where its phrase "failed preflight" could
include a selected backend's workspace-admission failure. It supersedes
ADR-0079 decision item 6 and its related consequence that classified an
AppContainer staging-budget excess as host-Shell availability unavailability.
ADR-0073's dynamic protected-path requirement, ADR-0078's Worker isolation,
and ADR-0079's managed restricted-token direction otherwise remain in force.
