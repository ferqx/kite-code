# Kite Local Runtime Service V1 workspace 与路径 Gate 清单

日期：2026-08-27

用途：KLSV1-00 的 workspace rename、package graph、test、release、workflow 与 documentation-map 注册表。此文件
不授权实现，也不能作为 current authority。

相关：ADR-0144、[`Kite Local Runtime Service V1 实施方案`](../plans/2026-08-27-kite-local-runtime-service-v1.md)、
[relocation manifest](2026-08-27-kite-local-runtime-service-v1-relocation-manifest.md)。

## KLSV1-01 rename exact contract

`apps/kite` 基线有 455 个 tracked files：261 source、186 tests、5 local docs、README、package manifest 与 tsconfig。
KLSV1-01 moves the whole workspace without behavior change:

| 旧 identity | 新 identity | 保持不变 |
| --- | --- | --- |
| `apps/kite` | `apps/kite-cli` | relative source/test/docs layout |
| `@kite-ai/kite` | `@kite-ai/kite-cli` | repo-private package；public binary仍是 `kite` |
| `@kite-ai/kite/cli` | `@kite-ai/kite-cli/cli` | `./cli` export behavior |
| `@kite-ai/kite/tui` | `@kite-ai/kite-cli/tui` | `./tui` export behavior；binary仍是 `kite-tui` |
| `#app/*` | `#kite-cli/*` | workspace-local source alias only |
| `@/app/*`、`@/app/sandbox/*` | removed | no global App alias；new alias cannot resolve another App |

KLSV1-01 still has one InProcess composition root at `apps/kite-cli/src/bootstrap.ts`; it does not create
`apps/kite-service` and does not cut over the default Store. Retired aliases may remain only as explicit negative fixture strings.

## root manifest、lock 与 TypeScript

| 文件 | 当前注册点 | required change |
| --- | --- | --- |
| `package.json` | root `module`、agent/tui/prod/test/transport scripts use `apps/kite` | replace source path and package identity；user command names unchanged |
| `tsconfig.json` | `@kite-ai/kite/{cli,tui}`、`#app/*`、`@/app/*` paths | add `@kite-ai/kite-cli/{cli,tui}` and `#kite-cli/*`；remove retired aliases |
| `apps/kite/package.json` | name、imports、exports、dependencies、scripts | move to CLI；name/import alias update；exports unchanged |
| `apps/kite/tsconfig.json` | workspace build/typecheck include | move mechanically；verify relative extends/rootDir |
| `bun.lock` | workspace path/name/link identity | regenerate deterministically and verify old workspace identity absent |
| `.gitignore` | explicit `apps/kite/src/logs/**` exception | update path |
| `CLAUDE.md` | current App topology/source paths | update current path only；do not announce Service before cutover |

## runtime package graph/static checker

`scripts/runtime-packages/check-runtime-packages.ts` must update all of:

- `RUNTIME_WORKSPACE_PACKAGES` app name/path and `ALLOWED_DIRECT_DEPENDENCIES` key;
- root module、App entrypoint、composition root、execution module、CLI/TUI executable exceptions;
- App lookup、UI dependency owner and expected composition root;
- source resolver for `#kite-cli/*` with owner/containment checks;
- explicit rejection for `#app/*`、`@/app/*` and cross-App source import.

The rename keeps the current 10-workspace count. KLSV1-02 adds `kite-app-contract` and `kite-local-runtime`; KLSV1-04 adds
`apps/kite-service`; KLSV1-06 changes the only concrete root from CLI bootstrap to Service application. Each graph change must
land with package README、manifest/export/build/test coverage and owner tests; do not predeclare nonexistent workspace rules.

Owner test is moved from `apps/kite/test/scripts/check-runtime-packages.test.ts` and must update synthetic fixture paths、root
shim import、alternate composition fixtures and `compositionRoots` expectations.

## default/owned runner 与 test ownership

| 文件 | responsibility | rename/update |
| --- | --- | --- |
| `scripts/run-default-tests.ts` | workspace list + App parallel shard | `apps/kite-cli` path and shard condition |
| `scripts/run-runtime-workspace-script.ts` | runtime build/test/typecheck list | rename now；add new packages/App only when created |
| `scripts/run-owned-tests.ts` | generic owner-local runner | no hardcoded path；verify moved package script |
| `scripts/test-suite.ts` | generic discovery/isolation/sharding | no path change |
| `scripts/check-test-ownership.ts` | App owner tests、integration deep import/alias boundary | new path/alias + retired alias negatives |
| `tests/integration/scripts/check-test-ownership.test.ts` | synthetic owner fixture | create `apps/kite-cli/test` |
| `scripts/check-compaction-legacy.ts` | App compaction implementation path | new prefix |
| `scripts/runtime/run-fault-soak.ts` | App runtime/model/MCP/session logger test manifest + lifecycle files | replace every App path；case semantics unchanged |

Root integration/helper/fixture imports that must be updated include:

- `tests/helpers/{mcp-test-composition,provider-readiness,runtime-model,sandbox-execution-provider,sandbox-executor,tool-runtime-projection}.ts`;
- `scripts/support/{runtime-agent,runtime-host-state,runtime-state-reducer}.ts` and `tests/golden/run.ts`;
- live/e2e fixtures for MCP、Skill、session logger and model compaction;
- qualification sandbox tests and worktree-controller isolated tests;
- TUI system fixtures/harness/scenarios, especially default executable path and thought-header model path fixtures.

Integration tests may import only package exports. Moving a helper path is not permission to add a production export or keep
`apps/kite-cli/src` deep imports after the final package boundary exists.

## pre-release 与 core boundary Gate

| Gate | exact path responsibilities |
| --- | --- |
| `scripts/check-pre-release-architecture.ts` | production root、historical read owner、App Runtime→TUI check、direct Session delete、composition root、required domain files |
| `scripts/check-core-boundary.ts` | App alias resolver、tool/Subagent provider bypass、sandbox production bypass、App source root |
| `scripts/check-test-ownership.ts` | App owner path、integration deep import、new and retired aliases |
| `packages/builtin-runtime/test/runtime-tool-pipeline-callbacks.test.ts` | forbid any App alias dependency, including new `#kite-cli/*` and retired aliases |
| `tests/isolated/scripts/check-core-boundary.test.ts` | synthetic App paths and alias negative fixtures |

Only doing a string replace is insufficient: current checkers special-case `@/app`, while `#kite-cli` otherwise looks like an
unresolved private specifier. The new resolver must prove the alias belongs to CLI and remains within its source root; later
`#kite-service` needs the symmetric check and neither may resolve the other App.

## release/build/internal runner inventory

| surface | current location | required evolution |
| --- | --- | --- |
| CLI standalone entry | `scripts/release/entrypoints/cli.ts` imports `@kite-ai/kite/cli` | rename package import |
| TUI standalone entry | `scripts/release/entrypoints/tui.ts` imports `@kite-ai/kite/tui` | rename package import |
| standalone resolver | `scripts/release/oss-candidate.ts` maps all workspace exports and `#app/*` | rename path/package/alias；later include both new packages and Service companion |
| release re-export helpers | `scripts/release/{artifact-layout,canonical-json,sign-rollout-manifest}.ts` | new owner path；final Service authority relocation |
| platform/session/execution smoke | `scripts/release/{platform-capability-probe,session-log-acl-smoke,execution-boundary-smoke}.ts` | new App alias/path；final Host-owned runner via Service |
| profile/manifest helpers | capability maturity、GA selection、generate manifest | new alias；safe CLI status only through App Control after cutover |

KLSV1-01 does not rename archive outputs `bin/kite` or `bin/kite-tui`. KLSV1-06/07 add `bin/kite-service` as a
manifest-managed companion, migrate RuntimeHost-owned MCP stdio/POSIX supervisor/internal Runtime entrypoints, and update candidate
layout/verify/install/smoke atomically. Installed startup resolves companion only from the managed manifest; source run uses an exact
source executable resolver. Upgrade/rollback must ordinary-stop the Service before changing current candidate and remain unchanged
on `service_busy`.

Release test owners include `tests/release/oss-candidate.test.ts`、manifest、rollout/status/profile/capability/GA and execution
workflow contract tests. Binary name stability and standalone keyring `unavailable` are explicit regression assertions.

## GitHub workflow path filters

The following workflows contain App-specific path filters and/or commands and must update both locations:

| workflow | representative App scope |
| --- | --- |
| `runtime-stdio-smoke.yml` | bootstrap/runtime/carrier/cli and stdio isolated tests |
| `runtime-transport-qualification.yml` | bootstrap/runtime/carrier/cli and stdio/loopback/WebSocket/transport tests |
| `session-log-acl-smoke.yml` | session logger + config paths |
| `platform-capability-probe.yml` | sandbox/config/CLI/TUI/adapters and native tests |
| `execution-boundary-conformance.yml` | config/release/sandbox/workspace and adversarial tests |

`release-candidate.yml` and `runtime-resilience-qualification.yml` execute affected scripts/runners even without App-specific path
filters and need end-to-end verification. Workflow expectation tests must update expected paths. KLSV1-07 extends the existing
runtime transport/release matrices; it must not create a duplicate workflow with equivalent semantics.

## documentation-map phased convergence

Current `check-docs.ts` requires every source pattern base and every authority path to exist. Therefore KLSV1-00 freezes the target
matrix here but does not create fake empty workspaces or invalid future map entries. This is a deliberate correction to the plan's
“update map in KLSV1-00” wording:

| Task | map action when source exists | authorities |
| --- | --- | --- |
| KLSV1-01 | move/split every `apps/kite` source, manifest, TUI, carrier/history/release/qualification rule to `apps/kite-cli`; update representative tests | CLI README/local docs + matching active authority |
| KLSV1-02 | add mutually exclusive `kite-app-contract` and `kite-local-runtime` rules | package READMEs + Runtime architecture/authority/resilience |
| KLSV1-03 | update runtime-server admission and application/control source owners | package/App README + architecture/authority/trust |
| KLSV1-04 | add Service application/carrier/process/state/auth rules | Service README/local docs + authority/resilience/trust/log-query |
| KLSV1-05 | add Native connector/transport qualification representatives | native package README + resilience/execution platform |
| KLSV1-06/07 | move unique composition/history/release/runner owners to Service and add companion release sources | Service/CLI README + runtime/release/execution active docs |
| KLSV1-08 | audit representative matrix and remove obsolete/overlapping source owners | actual current authorities only |

At minimum the existing rule families affected by the rename are `kite-app`、`kite-runtime-carriers`、
`kite-runtime-history`、TUI localization/rendering/interaction/system、runtime transport qualification、release candidate、
MCP control、execution governance and observability/session logging. A production source must match exactly one source owner;
specialist rules must be excluded from generic App rules.

Historical ADR、plan、completion、design、deprecated and book paths keep historical spelling where appropriate and cannot satisfy
the impact Gate. All `docs/active` and workspace local current docs must use the real current path in the same Task.

## KLSV1-01 targeted verification

After dependency installation/lock convergence:

```bash
bun run check:runtime-packages
bun run check:pre-release-architecture
bun run check:core-boundary
bun run check:test-ownership
bun run typecheck
bun run test:runtime:stdio
bun run test:runtime:websocket
bun run test:runtime:transport
bun test apps/kite-cli/test/scripts/check-runtime-packages.test.ts
bun test tests/integration/scripts/check-test-ownership.test.ts
bun test tests/integration/scripts/ci-bun-baseline.test.ts
bun test tests/integration/docs-impact.test.ts tests/integration/docs-space.test.ts
bun test tests/release/oss-candidate.test.ts tests/release/manifest.test.ts
```

Final old-path scan excludes historical document trees but not current docs、production、tests、scripts or workflows. Allowed
matches are only explicit retired-alias negative fixtures. KLSV1-01 does not repeat full PTY/native/release smoke; those remain
KLSV1-06/07 final gates.

## 漏网风险

1. TS paths、runtime/core checkers and standalone release resolver each implement alias resolution independently.
2. Workflow `paths` and commands are separate strings; updating only one creates false green/failed qualification.
3. model-output/path fixture strings in TUI layout/thought tests are behavior assertions, not imports, but still need intentional
   path expectation updates.
4. Bun workspace links/lock entries can preserve old identity after filesystem move; reinstall and lock audit are required.
5. Active docs contain many exact App/test paths. Update current paths mechanically but do not invent missing tests or alter behavior.
6. Release binary names remain `kite`/`kite-tui`; only the package identity changes in KLSV1-01.
7. The final Service companion cannot be added without installer/verify/rollback/busy-stop coverage and real three-platform artifact
   evidence; local source smoke cannot upgrade the support matrix.
