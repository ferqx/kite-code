# Space Records

`docs/space/` is the repository-local record system for durable agent context.
It keeps decisions discoverable without turning `AGENTS.md` into a long manual.

Start here:

1. Read `index.md`.
2. Follow only the records whose scope matches the current task.
3. If a record is added, moved, retired, or materially changed, update
   `index.md` in the same change.

Directory roles:

- `understanding/`: rationale, mental models, and design background.
- `execution/active/`: active rules that should constrain future edits.
- `execution/completed/`: completed implementation records and verification notes.
- `references/`: external source summaries that informed local decisions.
- `generated/`: derived or temporary materials with lower authority.

Authority order:

1. Direct user, developer, and system instructions.
2. Repository source code and tests.
3. `execution/active/` records linked from `index.md`.
4. `understanding/` and `references/` records.
5. `generated/` records.

For the design rules behind this directory, read
`understanding/space-system-design.md`.

Boundary: `docs/space/` is not runtime plan storage. Per-run
`graph.state.plan` values remain in LangGraph checkpoint state; space records
only capture durable design rules, implementation history, and external
references.
