# E2E test taxonomy

The E2E suites are grouped by the external boundary they cross:

- `local/` — deterministic cross-process tests using isolated local fixtures. These are part of `test:e2e`.
- `live/mcp/` — explicit opt-in tests against public or externally managed MCP services. These never use default Bun test names.
- `live/model/` — explicit opt-in tests that spend real model-provider quota. This directory currently contains no maintained suite.

TUI PTY scenarios remain under `tests/tui-system/scenarios/` because they have their own serial harness and standards.

Files under `live/` must use `*.live.ts`, not `*.test.ts` or `*.spec.ts`, and must be standalone runners invoked with `bun run` by an explicit package script.
