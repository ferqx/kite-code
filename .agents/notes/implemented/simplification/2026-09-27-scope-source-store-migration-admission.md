# Agent Note: Scope Store migration writer admission to its data home

Status: implemented

此处旧写入者观测是迁移准入的安全 owner，不是 Runtime 的旧格式读取或旧 writer。架构门禁对该 owner 的窄边界见[受控兼容 owner 的架构门禁](../process/2026-09-28-scope-pre-release-architecture-gate-to-compatibility-owners.md)。

## Problem

The macOS source, paired Desktop, and installed Service admission paths used machine-wide Kite process or distribution scans before migrating one Store. Another installation or a client on a separate canonical config home could block migration indefinitely. The Store maintenance lock cannot by itself protect against an older writer that does not participate in the lock protocol.

## Decision

Source CLI/TUI migration keeps build and parent identity checks; paired Desktop keeps its manifest, executable, and parent checks; installed CLI/TUI keeps selected-candidate, lineage, and release-selection lock checks. All three paths check active Kite processes against the target canonical config home, including explicit, environment, and default roots that may have routed an older client. An unresolved candidate home still blocks migration. Mere presence of another installation, PATH entry, or application bundle no longer blocks any Store. A process whose executable is demonstrably unable to carry a supported Kite entrypoint does not block migration merely because its arguments are unreadable. The Store still takes exclusive maintenance locks and rechecks admission and source files before publication.

## Alternatives considered

- Keep the global process and distribution scans: conservative for the default Store, but rejects unrelated homes, empty installation directories, and same-name PATH files; it also makes migration depend on ambient Desktop state.
- Remove all process checks: simpler, but an active older writer could modify a source Store without honoring the maintenance lock.
- Inspect another process's open database handles: does not prove an idle old client cannot open the Store later and requires a larger platform-specific observer.

## Consequences

Different homes can migrate concurrently when their identities are verified. Same-home and unknown-home Kite processes remain blockers. A manually launched historical binary can still start after the final process observation; removing static entrypoint checks does not establish a guarantee against that race. This is a scoped macOS entrypoint qualification and does not extend automatic migration to unqualified platforms.
