# Inline Compaction Progress Design

## Goal

Keep the prompt editable during both manual and automatic context compaction, render both flows in the message area with the same progress component, and preserve the surrounding agent-run status only for automatic compaction.

## User-visible contract

- Manual compaction adds the existing `/compact` command message to the conversation.
- Automatic compaction adds a read-only semantic `/auto-compact` message to the conversation. It is presentation text backed by the durable automatic compaction request event; it is not registered as a slash command and cannot be invoked by the user.
- Both flows render the same `preparing`, `summarizing`, and `validating` progress animation inline at the end of the message area.
- The prompt remains editable and accepts submission throughout either compaction flow. Runtime serialization remains responsible for ordering submitted work behind an in-flight compaction.
- Manual compaction does not show an agent-run status because it is a standalone command outside an agent conversation.
- Automatic compaction keeps the current agent-run status because it occurs within an active user turn. The inline compaction animation supplements rather than replaces that status.
- Switching, loading, or creating a session clears the ephemeral progress projection. Durable `/compact` and `/auto-compact` message rows are reconstructed from Runtime events.

## State and event model

`TuiState.compactionProgress` becomes `{ phase, source }`, where `source` is `manual | automatic`. The source controls only the agent-run status rule; placement is no longer configurable because all compaction progress is inline.

`SET_COMPACTION_PROGRESS` carries the same source while a phase is active. Clearing the phase clears the entire projection. It no longer rewrites `status.currentNode`, so automatic compaction cannot replace the active agent verb with a compaction verb or erase that verb when compaction finishes.

The durable `context.compaction_requested` event already distinguishes `reason: auto | manual`. The TUI event reducer appends `/auto-compact` only for `reason: auto`. Manual requests remain paired with their existing durable `user.command_invoked` event, avoiding duplicate `/compact` rows.

## Rendering and input

`App` always passes the active compaction phase to `OutputArea`. `OutputArea` renders `CompactionProgress` after the active message blocks.

`shouldShowRunStatus` hides the status only when the active compaction source is manual. Automatic compaction follows the normal `running` and interrupt rules. `shouldDisablePromptInput` depends only on an active interrupt; compaction never owns or disables the prompt surface.

## Verification

Unit and render tests cover:

- automatic requests append exactly one `/auto-compact` row while manual requests do not;
- `/auto-compact` is not accepted by slash-command parsing;
- both progress sources leave prompt input enabled;
- manual progress hides agent-run status while automatic progress preserves it;
- both sources render the same inline progress component;
- session reload clears only the ephemeral progress projection.

A deterministic real-PTY scenario runs manual and automatic fixture variants independently. Each variant verifies the command row, inline progress, expected agent-run status visibility, and real terminal typing while progress is active.
