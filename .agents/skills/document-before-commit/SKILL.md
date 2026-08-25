---
name: document-before-commit
version: 1.1.0
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
2. Confirm this is a task-isolated branch/worktree with one Git owner. Run `bun run check:docs-impact` with its default `all` scope so staged, unstaged, deleted, renamed and untracked paths are considered together. Also inspect `git diff --cached --name-status`, `git diff --name-status` and `git status --short`. Preserve unrelated dirty files and return `blocked` instead of absorbing them with `git add -A`.
3. Match changed implementation files against every V2 mapping rule. Read each matched workspace README, workspace-local current document or `docs/active/` authority before deciding whether it needs an update. Historical ADR、book、plan、completed、design 与 deprecated 不能满足影响门禁。
4. Update documentation when behavior, contracts, architecture, configuration, user interaction, validation, or lifecycle changed:
   - update the owning workspace README or workspace-local document for module-local behavior;
   - update `docs/active/` for cross-workspace behavior and invariants;
   - update root documents or `docs/book/` for user/developer-facing changes;
   - add a new ADR for a new architecture decision; never rewrite accepted ADR history;
   - archive completed plans and update `docs/space/plans/index.md`.
5. For behavior-neutral changes, verify that the mapping already has another affected current document in the change. If the mapping is wrong, correct the mapping; never add meaningless documentation edits.
6. Scan changed current documents for deleted source paths, deleted tests, obsolete framework names, fixed tool/event counts, and conflicting statements.
7. For `action=stage`, run `bun run check:docs-impact` with default `all`. After explicit staging, `action=commit`、`push` or `pull_request` must also run `bun run check:docs-impact --scope=staged`. Then run `bun run check:docs`, `bun run check:core-boundary`, and the relevant tests. Run `bun run typecheck` when TypeScript changed.
8. Reinspect the final diff and staged boundary. If another task affects the same current authority, serialize the work: merge one task, rebase the other, and rerun the gates. Return `ready` only when required documentation is updated and every documentation gate passes. Otherwise return `blocked` with the unresolved reason and do not commit.
