# Agent Note: Managed restricted-token Windows sandbox direction

Status: implemented

## Problem
The initial Windows Shell candidate used Classic AppContainer plus a Job Object.
The dynamic protected-path requirement kept the real Workspace outside that
container and used an invocation-private staging copy so a dynamically-created root `.env.*` can never
touch the host Workspace before reconciliation rejects it.

That security property made full source-tree copy, hashing, scanning, and cleanup
part of every AppContainer invocation. On the observed 880 MiB Workspace it consumed
48--57 seconds. Moving this work to a Worker kept Ink responsive but did not make a
user command start quickly.

Codex's Windows architecture uses managed sandbox identities, persistent ACL/WFP
setup, a restricted child token, and direct Workspace ACLs. It avoids per-command
Workspace copies, but cannot alone express this project's rule that every future
root `.env.*` must be denied.

## Decision
1. Treat a managed `windows_restricted_token` backend as the next Windows sandbox
   candidate, in parallel with the existing `windows_appcontainer` private-staging
   candidate. This Agent Note is an architectural decision; it does not make that backend
   selectable, qualified, or production supported.
2. The intended strong mode is managed/elevated setup: create non-administrator
   sandbox identities, store only DPAPI-protected setup state, maintain an
   idempotent ACL/WFP recovery ledger, and validate setup health before use.
   Setup must be explicit and auditable; normal Shell invocations must not create
   users, mutate firewall policy, or grant broad ACLs.
3. The runner design uses a managed account token, `CreateRestrictedToken`, and
   suspended `CreateProcessAsUserW` followed by Job assignment and resume. Direct
   Workspace and declared runtime roots receive only the necessary ACL grants.
   Network-off requires WFP (or an equally strong independently proven mechanism)
   for the sandbox identity and all descendants; a capability-token HTTP broker
   remains the only allowed controlled egress path.
4. An unelevated restricted-token-only path is not a security-equivalent fallback:
   it may be investigated for diagnostics, but cannot claim direct Workspace ACL
   isolation or network-off enforcement without an independently qualified identity
   and network boundary.
5. Dynamic protected-path enforcement remains a hard gate. A direct-ACL
   `workspace_write` path may become the default only after a projection/COW or equivalent creation-intercept mechanism
   proves that arbitrary future protected names, including `.env.*`, cannot be
   created in the real Workspace. Until then it must use private staging or select
   the explicit host-shell availability fallback.
6. The existing AppContainer path gains a conservative Worker-based source budget
   before a real executor is bound. Budget excess is treated as sandbox
   unavailability before a user script begins, so TUI/CLI select Bash/cmd/PowerShell
   with effective backend `none` and Full unavailable. Command-time staging repeats
   the budget check to close the source-tree race.
7. Win11 remains the primary native-E2E environment. Win10 22H2 (10.0.19045) is the
   API/build baseline; no untested Win10 runtime behavior is claimed.

## Alternatives considered

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences
- Large workspaces no longer incur an unbounded staging wait before the first user
  Shell command. The availability downgrade is deliberately not isolation evidence.
- The managed backend requires privileged provisioning, ACL/WFP crash recovery,
  teardown, status reporting, and native negative conformance tests before it can
  replace AppContainer staging or affect D-04 qualification.
- Direct Workspace ACLs must not be granted to the current AppContainer identity as
  a shortcut: that would violate the dynamic protected-path guarantee.
- The current production support set remains empty and `productionSupported=false`.

## Non-goals
- Do not silently create a local account, firewall rule, or Workspace ACL during
  application startup or an ordinary Shell request.
- Do not relax protected-path semantics to make direct ACLs convenient.
- Do not treat unrestricted host Bash/cmd/PowerShell as a sandbox, or permit Full
  after an availability downgrade.
- Do not replace Win11 evidence with an assumption that Win10 behaves identically.

## Supersession
This Agent Note supersedes the earlier rejection of a managed restricted-token
design as a future Windows candidate. It does not make that candidate selectable
before the projected namespace, managed identity, ACL ledger, WFP, and native
conformance gates above are complete. The dynamic protected-path requirement
remains in force: the existing AppContainer private-staging path is retained only as an explicit migration or
experimental backend until the new path can prove the same dynamic protection.

## Historical relationships

Owners: Security + Platform (single maintainer)

Related: [Agent Note 0054](2026-07-30-production-execution-isolation.md), [Agent Note 0061](../process/2026-07-31-production-platform-capability-admission.md), [Agent Note 0065](../process/2026-08-02-cross-platform-distribution-and-capability-admission.md), [Agent Note 0074](../process/2026-08-08-windows-10-api-compatibility-baseline.md), [Agent Note 0077](../simplification/2026-08-08-unified-sandbox-startup-downgrade.md)
