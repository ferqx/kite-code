---
name: document-before-commit
version: 1.0.0
description: Synchronize affected repository documentation before staging, committing, pushing, publishing, or opening a pull request after implementation changes.
invocation:
  allow_implicit: false
  allow_manual: true
context:
  mode: inline
  agent: code
input_schema:
  type: object
  properties:
    action:
      type: string
      enum: [stage, commit, push, pull_request]
  required: [action]
output_schema:
  type: object
  properties:
    status:
      type: string
      enum: [ready, blocked]
    documents_checked:
      type: array
      items:
        type: string
    documents_updated:
      type: array
      items:
        type: string
  required: [status, documents_checked, documents_updated]
capabilities:
  require: [builtin:read_file, builtin:shell_execute, builtin:edit_file, builtin:write_file]
  deny: []
effects:
  filesystem: write
  network: none
  external_state: none
approval:
  minimum: user
execution:
  timeout_ms: 300000
  max_attempts: 2
verification:
  mode: required
recovery:
  retry: never
---

# Synchronize documentation before commit

1. Read `AGENTS.md`, `docs/AGENTS.md`, and `docs/documentation-map.json`.
2. Inspect `git diff --cached --name-status` and `git diff --name-status`. Include untracked implementation and documentation files from `git status --short`.
3. Match changed implementation files against every mapping rule. Read each matched current document before deciding whether it needs an update.
4. Update documentation when behavior, contracts, architecture, configuration, user interaction, validation, or lifecycle changed:
   - update `docs/active/` for current behavior and invariants;
   - update root documents or `docs/book/` for user/developer-facing changes;
   - add a new ADR for a new architecture decision; never rewrite accepted ADR history;
   - archive completed plans and update `docs/space/plans/index.md`.
5. For behavior-neutral changes, verify that the mapping already has another affected current document in the change. If the mapping is wrong, correct the mapping; never add meaningless documentation edits.
6. Scan changed current documents for deleted source paths, deleted tests, obsolete framework names, fixed tool/event counts, and conflicting statements.
7. Run `bun run check:docs-impact`, `bun run check:docs`, `bun run check:core-boundary`, and the relevant tests. Run `bun run typecheck` when TypeScript changed.
8. Reinspect the final diff. Return `ready` only when required documentation is updated and every documentation gate passes. Otherwise return `blocked` with the unresolved reason and do not commit.
