# ask_user Structured Result Design

## Goal

Make selected answers from `ask_user`, including multi-question wizard answers, reliably visible in the TUI and in session replay. The display must not depend on parsing a truncated tool-output string.

## Problem

The multi-question wizard collects a `Record<string, string>`, but that data is repeatedly converted between structured values and text:

1. `InputBlock` submits a text summary plus an optional answer map.
2. The runtime serializes both into `tool.finished.result.stdout` JSON.
3. `handleRuntimeEventAction` truncates stdout/stderr to 200 characters for `tool_done`.
4. `handleEventAction` and `ToolCardBlock` parse the resulting string again to reconstruct the map for display.

This transport is lossy and has no typed contract at the TUI boundary. A longer five-step response can be cut in the middle of JSON; any parse or key mismatch then makes `ToolCardBlock` fall back to `(no answer)` for a step.

## Options considered

### 1. Increase/remove the 200-character summary limit

This reduces one failure mode but retains a fragile string protocol and duplicate parsers. It does not make rendering or replay type-safe. Rejected.

### 2. Keep the textual summary but add more permissive parsing

This would conceal some malformed payloads while making the parser more complex. It cannot recover data after truncation. Rejected.

### 3. Carry an `ask_user` result as structured data through the runtime-to-TUI event boundary

The wizard answer map becomes the canonical UI result. Tool summaries remain a compact textual representation for model context and generic logging, but no longer drive the answer UI. Recommended and approved.

## Design

### Result contract

Add an optional structured result field to the protocol/runtime tool-result payload for `ask_user`:

- `answer`: the single-text answer / compact compatibility answer.
- `answers`: optional map from the normalized question id to its selected text.

Only `ask_user` produces this field. Other tools keep using their existing summary/output handling.

When an input action resolves a user-input interaction, the runtime creates both:

- a normal `tool.finished` event, keeping JSON stdout for the model transcript; and
- the structured `ask_user` result for UI consumers.

### TUI state and rendering

`tool_card` stores the structured result independently from `summary`. `handleRuntimeEventAction` maps the runtime result directly to that field and may still truncate the generic summary without affecting answers.

`ToolCardBlock` renders answers from the structured result when present. The existing JSON/plain-text parsing is retained only as a backwards-compatible fallback for old persisted sessions that lack the structured field.

For multi-question cards, the renderer matches values by the same normalized id convention used by `MultiQuestionWizard`: explicit question id or zero-based string index. Missing data remains visibly marked `(no answer)`, but completed wizard answers cannot be lost due to formatting or truncation.

### Immediate resolution and replay

On `RESOLVE_INTERRUPT`, the TUI can populate the active `ask_user` card with the structured result immediately, including multi-question responses. The later `tool.finished` event confirms lifecycle status and provides the same authoritative payload.

Session replay continues to process persisted runtime events. Since the structured result travels in `tool.finished`, replay produces the same `tool_card` state as the live UI. Legacy events retain the existing summary-parser fallback.

### Error handling

- A cancelled question stays cancelled and does not manufacture a successful result.
- A malformed or absent structured result falls back to the legacy summary parser.
- A response map may have fewer keys than the requested questions; only those genuinely absent values render as `(no answer)`.

### Tests

Add focused tests for:

1. Runtime action conversion preserving the text answer and multi-answer map in the `tool.finished` event.
2. TUI reducer storing structured answers even when generic output is truncated.
3. Tool-card rendering of all five answers with explicit ids and index-derived ids.
4. Session replay rendering the same answers from persisted runtime events.
5. Legacy raw JSON/plain-text summary fallback behavior.

## Non-goals

- Changing how models receive `ask_user` tool messages.
- Altering the wizard flow, option selection, or cancellation key bindings.
- Generalizing structured result schemas for all tools in this change.
