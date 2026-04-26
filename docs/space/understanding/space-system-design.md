# Space System Design

Date: 2026-04-26
Status: understanding
Related:

- `../index.md`
- `../references/openai-harness-engineering.md`

## Purpose

`docs/space/` is a lightweight repository-local record system for decisions that
should survive across agent sessions. It fills the gap between source code,
tests, and conversation history.

The main problem it solves: later agents often see only the current code shape,
not the reasoning that made that shape intentional. Space records preserve
reasoning, active constraints, and verification history without turning
`AGENTS.md` into a large manual.

This design follows the harness-engineering principle that the repository should
be the agent-readable record system, while `AGENTS.md` stays a compact map to
deeper sources.

`docs/space/` is not a replacement for LangGraph checkpoint state. Per-run
`graph.state.plan` values remain runtime state. Space records only preserve
durable design rules, completed-change evidence, and reference material.

## Design Principles

- Map first: `AGENTS.md` points to `docs/space/index.md`; it should not embed the
  whole knowledge base.
- Progressive disclosure: future agents read the index first, then only the
  records matching the current task scope.
- First-class execution records: active and completed decisions live in versioned
  files, not only in chat history.
- Runtime boundary: do not generate plan files for every `graph.state.plan`;
  record only durable design decisions and completed implementation history.
- Stale-aware context: records carry status, scope, and verification notes so a
  later agent can judge whether they still apply.
- Garbage collection: stale active rules must be retired or rewritten with
  rationale instead of accumulating silently.

## Directory Model

### `index.md`

The catalog for all durable space records.

Use it for:

- locating active rules by scope;
- discovering background and reference records;
- checking whether a record is active, completed, generated, or reference-only;
- keeping the directory navigable without reading every file.

Every new, moved, retired, or materially changed space record should update the
index in the same change.

### `understanding/`

Stores rationale, mental models, and background explanations.

Use it for:

- why a design exists;
- tradeoffs that are easy to forget;
- analysis of source behavior;
- cross-provider or architectural reasoning.

These records explain decisions but are not direct execution checklists.

### `execution/active/`

Stores currently active rules that future work should preserve.

Use it for:

- constraints that should block casual refactors;
- behavior that tests should continue to assert;
- design choices that look accidental but are intentional;
- rules that must be checked before editing a related subsystem.

Active records should be short, concrete, and scoped to specific files or
subsystems.

Active records should not be read for every task. They are mandatory only when
the current task overlaps their declared scope.

### `execution/completed/`

Stores completed change records.

Use it for:

- what changed;
- why it changed;
- which files were touched;
- which verification commands were run;
- what risk remains.

Completed records are historical evidence, not active rules by themselves.

### `references/`

Stores external reference summaries.

Use it for:

- upstream source comparisons;
- third-party behavior notes;
- documentation summaries that informed local rules.

Reference records should not become binding unless promoted into
`execution/active/`.

### `generated/`

Stores generated or derived materials with explicit lower authority.

Use it for:

- drafts;
- synthesized comparisons;
- temporary generated notes;
- material that may be useful but must not silently become policy.

## Authority And Conflict Rules

Authority order:

1. Direct user, system, and developer instructions.
2. Source code and tests.
3. `execution/active/` records linked from `index.md`.
4. `understanding/` and `references/`.
5. `generated/`.

If an active record conflicts with source or tests, do not blindly follow either
side. Inspect the implementation, tests, and completed records, then update the
stale side with an explicit rationale.

If a user explicitly asks to change an active rule, update the rule as part of
the implementation and record why the design changed.

## Read Path For Future Agents

Do not read all space records for every task.

Read `docs/space/index.md` when first orienting to durable project context.

Read an `execution/active/` record when the task touches that record's scope,
for example:

- model context construction;
- plan state handling;
- graph routing, autonomy, or tool gating;
- tool gating and approval behavior;
- cache-sensitive prompt layout;
- any subsystem named in an active record's scope.

Read `understanding/` or `references/` only when the active rule needs
background or the implementation intent is unclear.

## Record Metadata

Records that can affect future implementation should include:

- `Status`: `active`, `completed`, `understanding`, `reference`, or `generated`.
- `Scope`: files, subsystems, or behaviors covered by the record.
- `Read when`: task conditions that require reading the record.
- `Related`: links to active rules, completed records, references, or tests.
- `Verification`: commands, tests, or inspection evidence when applicable.

The format can remain simple Markdown key-value text. The important invariant is
that a later agent can mechanically scan the record and decide whether it is
current and relevant.

## Write Path

Add or update a space record when a decision has future cost if forgotten.

Good candidates:

- provider-specific behavior that affects architecture;
- prompt or context layout decisions;
- safety, approval, or plan-mode invariants;
- rules that are not obvious from code;
- choices made after comparing external projects.

Avoid space records for routine implementation details, temporary debugging
notes, or facts already obvious from a nearby test name.

When adding a new active rule:

1. Add a concise record under `execution/active/`.
2. Include status, scope, read conditions, required behavior, and "do not"
   guidance.
3. Add or update tests that enforce the behavior where practical.
4. Add a completed record if the rule comes from an implementation change.
5. Update `index.md`.

When retiring a rule:

1. Move or rewrite the active record with rationale.
2. Add a completed record describing the retirement.
3. Update tests and source together.
4. Update `index.md`.

## Garbage Collection

Space records should not grow into a second README.

During related maintenance, check for:

- active rules whose scope no longer matches the implementation;
- completed records that should remain historical but no longer imply a current
  rule;
- generated or reference material that should either be promoted into an active
  rule or left explicitly non-binding;
- records missing status, scope, or links from `index.md`.

The immediate expectation is manual upkeep. If the directory grows, add a
lightweight check that validates index links and required metadata.

## Naming

Use descriptive kebab-case filenames.

Recommended patterns:

- `understanding/YYYY-MM-DD-topic.md`
- `execution/active/topic-rule.md`
- `execution/completed/YYYY-MM-DD-topic.md`
- `references/source-topic.md`

Prefer date prefixes for historical records. Active records do not need dates in
filenames because they represent the current rule.

## Current Important Rule

The first active rule is `execution/active/plan-state-reminder.md`.

It records that `graph.state.plan` must be projected as a trailing synthetic
user-side runtime state reminder, not as a system prompt or cacheable runtime
context.
