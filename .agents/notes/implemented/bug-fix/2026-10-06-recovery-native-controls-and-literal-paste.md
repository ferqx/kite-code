# Agent Note: Recovery native controls and literal paste

Status: implemented

## Problem

The current terminal SDK can group native Ctrl+C and Ctrl+L bytes into one input value. The recovery panel treated that value as text, so the real interrupt recovery window stayed unknown after the original effect had settled. Without an active paste handler, bracketed paste also fell back to key parsing: a pasted Ctrl+L queried the original request and a pasted Enter submitted an already typed interrupt confirmation.

Cancelling an original GET exposed a related state problem. A transport that resolved after its signal was aborted could overwrite the result of the next explicit query. Input collection and read completion must preserve the existing distinction between local observation and durable work.

## Decision

The private [recovery panel](../../../../packages/ui/src/tui/recovery-panel.tsx) uses the SDK's separate paste channel for literal text. It handles only native batches composed of Ctrl+C/Ctrl+L, in byte order, through the existing cancel-read and original-lookup actions. Pasted control characters do not reach these actions or Enter confirmation. Single native keys retain their existing behavior; other keyboard routing stays with its existing owner.

The [controller](../../../../packages/ui/src/tui/controller.ts) ignores replies and exceptions from an aborted recovery GET. It still records the result of an original submission: cancelling observation does not undo a POST or erase its original identity. No HTTP port, permission, journal format, retry authority or Core execution state changes.

## Alternatives considered

- Increasing the driver's delay between keys would depend on scheduling and leave real users' coalesced input broken. The original whole-default failure and deterministic rendered input reproduce the behavior directly.
- Splitting raw control bytes without registering the paste channel would reinterpret pasted Ctrl/Enter bytes as actions. Separate paste regression cases demonstrate this failure.
- A global keyboard parser or router would affect unrelated panels and terminal escape semantics. The observed consumer is the recovery panel; its existing hooks and bounded C/L handling are sufficient.

## Consequences

[Rendered recovery cases](../../../../packages/ui/test/tui/recovery.test.tsx) verify cancellation of only the original read, the same original query intent, zero new work/cancellation, literal paste, and ignored late replies. The current recovery component has 15 passing cases; all 24 TUI files have 243 passing cases and 2020 assertions. UI/CLI typechecks and UI build pass.

[Original recovery PTY cases](../../../../apps/cli/test/isolated/tui-recovery-host.test.ts) deliberately send C/L in one native write for Run, interrupt and report, retaining five cases, 43 assertions, original approvals and effects, and cold GET-only checks. This is finite macOS/Bun evidence. It does not qualify other panels, all paste/terminal protocols, installed Native stdin, other platforms or complete V1.3 delivery. Current product behavior belongs to the [TUI recovery guide](../../../../docs/handbook/clients/tui/guides/cancellation-and-recovery.md); implementation and final qualification belong to the UI/CLI owner documents and [overall progress](../../../../docs/plans/unified-agent-refactor-v1-progress.md).
