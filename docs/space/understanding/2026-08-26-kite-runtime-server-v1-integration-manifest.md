# Kite Runtime Server V1 workspace integration manifest

日期：2026-08-26

用途：KRSV1-00 的实施影响清单。此文件不授权实现，也不替代未来新增 workspace 的 README、`docs/active/` 或
documentation-map current authority。

相关：ADR-0142、ADR-0140、ADR-0141、KRSV1 计划。

## 新 workspace contract

三个新增 workspace 均须为 private ESM package，具有 `README.md`、`tsconfig.json`、非空 `src/`、非空 owner-local
`test/`、根 `exports` 和 `build`/`typecheck`/`test` scripts。`test` 使用 `bun run ../../scripts/run-owned-tests.ts .`；
需要真实进程、socket、cwd、SQLite 或环境变量的测试置于各自 `test/isolated/`。

| Package | README 必须说明 | `package.json` / exports | `tsconfig` | owner tests |
| --- | --- | --- | --- | --- |
| `packages/runtime-protocol` / `@kite-ai/runtime-protocol` | repo-private Protocol V1、browser-safe/transport-neutral codec、严格 allowlist，不拥有 Runtime/listener/Workspace | 根 `.` 仅导出 protocol DTO/codec/schema；依赖仅 `@kite-ai/runtime-contract` 与允许的 browser-safe codec | extend root；只 include own `src/**`、`test/**`；不得引入 Bun/Node/App types | strict JSON-RPC/codec/schema golden、unknown/oversize/batch/version negatives、browser build |
| `packages/runtime-server` / `@kite-ai/runtime-server` | connection state、routing、subscription pump、bounded queue；只消费 `RuntimeAccess + RuntimeServerAdmissionPort` | 根 `.` 仅导出 server core/ports；依赖仅 contract + protocol；不导出 carrier | extend root；own source/tests；core 不导入 stdio/WebSocket/process signal | fake RuntimeAccess/admission conformance、initialize/ack-ready/order/gap/index/slow consumer/iterator cleanup |
| `packages/runtime-client` / `@kite-ai/runtime-client` | transport interface、correlation/reconnect/resubscribe/store/history seam；不拥有 Host/Server/SQLite/UI | 根 `.` 仅导出 client、transport/history interfaces；依赖仅 contract + protocol | extend root；own source/tests；browser-safe client entry | fake/in-process real Server conformance、reconnect/stale generation/reset/history resync/slow listener |

`runtime-protocol` 和 `runtime-client` 的 browser build 必须在没有 Bun/Node/App import 的情况下通过；
`runtime-server` 的 carrier-specific I/O 位于 `apps/kite`。如需 subpath export，必须同时把它列入 README、package
exports、build input、runtime package checker 与 external consumer test；禁止为 test 便利 public export。

## graph、TypeScript 与 static checker 更新点

| 位置 | 必须更新 | 不变量 |
| --- | --- | --- |
| `scripts/runtime-packages/check-runtime-packages.ts` | `RUNTIME_WORKSPACE_PACKAGES` 从 7 扩至 10；`ALLOWED_DIRECT_DEPENDENCIES`、forbidden public names、consumer/import rules、cycle/transitive checks、Client boundary 与 App composition expected imports | protocol/client/server 只依赖 contract/protocol；server 不导入 Host concrete；client 不到 Host/SQLite/Server implementation；App 仍唯一 composition root |
| `scripts/run-runtime-workspace-script.ts` | build/test/typecheck workspace list 加三项 | 三项缺任一 script 即 fail |
| `scripts/run-default-tests.ts` | default workspace list 加三项并保持 owner-local parallel/isolated split | 默认 runner 自动发现 owner tests，不以中央 file list 代替 |
| root `package.json` / `bun.lock` / root `tsconfig.json` | 追加 workspace devDependencies、path aliases（仅确有 source need 时）与锁文件 | root build/typecheck/test 仍经 workspace runner；不把 carrier runtime dependency 塞入 protocol/client |
| `scripts/check-pre-release-architecture.ts` | package/required-domain/forbidden import checks 需要认识新 package，且不把 implementation task identity 写入 production source | 无第二 composition root、无 Runtime→TUI、无 versioned/legacy compatibility bypass |
| checker owner tests | 扩展 `apps/kite/test/scripts/check-runtime-packages.test.ts` 及相应 integration script tests | fixture 证明 missing README/tsconfig/export/test、非法 edge、deep import、client direct Host import 与多 composition root 都失败 |

目标 internal graph：

```text
runtime-contract → ∅
runtime-protocol → runtime-contract
runtime-client   → runtime-contract + runtime-protocol
runtime-server   → runtime-contract + runtime-protocol
agent-kernel     → ∅
runtime-spi      → runtime-contract
runtime-host     → agent-kernel + runtime-contract + runtime-spi
runtime-storage  → runtime-host
builtin-runtime  → runtime-contract + runtime-spi
apps/kite        → client + server + host + builtin + sqlite + existing contract/spi
```

## App, carrier 与 product integration

`apps/kite` 是唯一可写 composition owner。它负责 InProcess endpoint 的两端组合、one trusted Workspace admission、
safe history adapter、stdio child lifecycle，以及随后 test/development loopback carrier。需要更新：

- `apps/kite/README.md`：新增 client/server/protocol dependency、single composition、TUI/CLI single path、
  history seam、reference-only Web/Desktop 和 ADR-0053 No-Go；
- `apps/kite/package.json`/`tsconfig.json`/exports/build inputs：声明三个 workspace dependency，必要时仅暴露
  approved CLI/TUI executable；不增加 `kite server --web` production release export；
- App test：bootstrap InProcess composition、CLI/TUI all journeys、history recovery、Workspace admission、stdio child
  lifecycle、development carrier security/conformance；
- App local docs：更新 `docs/tui-interaction.md`、`docs/tui-system-testing.md`，并在 server carrier 生效时新增
  owner-local carrier/CLI doc 与 test command；
- LOGWEB-05～09 由同一 App owner 实现，但 `/rpc` 只能 receive RuntimeAccess/admission，`/api/logs/*` 只能 receive
  RuntimeLogQueryPort/safe projector。

TUI/CLI 的 production import static test 必须证明不直接到 Host execution、SQLite、Builtin 或 Kernel。测试可做
one-tranche behavior comparison，但不能 dual-execute command；cutover 后没有 runtime fallback flag。

## test ownership 与 required suites

| Layer | owner/location | required evidence |
| --- | --- | --- |
| Protocol | `packages/runtime-protocol/test/` | codec, schema, JSON-RPC, allowlist, security negative, generated artifact/browser compatibility |
| Server | `packages/runtime-server/test/` and `test/isolated/` for real I/O fixtures | fake/real backend, subscription order, queue isolation, shutdown and transport conformance |
| Client | `packages/runtime-client/test/` | correlation, reconnect, resubscribe, stale generation, snapshot/index atomics, history seam |
| Host/SQLite | existing owner tests plus new receipt/store tests | Store 6 DDL/preflight, Store 5 source→target import, atomic receipt/runtime commit, crash/restart/no redispatch |
| App | `apps/kite/test/`, `apps/kite/test/isolated/`, `tests/tui-system/` | TUI/CLI journeys, old-session history, Workspace Trust, stdio, development WebSocket negative and browser reference smoke |
| Cross-package | `tests/integration/` | imports only package exports; same matrix across in-process/stdio/test WebSocket |
| Qualification | `tests/qualification/` and explicit suites | slow consumers, crash windows, fault/soak; Web evidence does not become production support |

Default `bun run test` must include new owner-local tests via the runner lists but continue excluding PTY system scenarios,
fault/soak, native smoke and live providers. `bun run test:tui:system` remains explicit. Required implementation gates are
`bun run check:runtime-packages`、`bun run check:core-boundary`、`bun run check:pre-release-architecture`、
`bun run check:test-ownership`、`bun run typecheck`、`bun run build` and the owner/transport suites. Store and restart
tranches also run the Runtime fault/soak and relevant isolated child-process tests.

## build, release, SBOM 与 entrypoint inventory

| Surface | update requirement | boundary |
| --- | --- | --- |
| workspace build/typecheck | package build entries and `scripts/run-runtime-workspace-script.ts` cover all ten workspaces | protocol browser build is independent; server carrier stays out of core |
| package checker | export targets/consumer test/allowed edges/source/test presence include new workspaces | no deep import or hidden package |
| OSS candidate build | `scripts/release/oss-candidate.ts` and release contract tests account for changed CLI/TUI entrypoint dependency closure | shipped production entries remain CLI/TUI only |
| release manifest/artifact layout | update only if actual bundled files or entrypoint metadata change | no Web/Desktop production entrypoint or support claim |
| SBOM | `bun.lock` and synthetic CycloneDX generation/verification reflect new workspace dependencies when they are materialized | SBOM is not native support evidence |
| platform/release smoke | CLI/TUI existing entrypoint probes remain authoritative; stdio/reference WebSocket get separate conformance, not production manifest admission | ADR-0053 Web No-Go remains |

## documentation-map convergence

Before code is staged, add precise V2 rules in `docs/documentation-map.json` for each new production workspace source and
manifest. Required current authorities are the new package README plus the applicable active records:

- protocol/client/server cross-package dependency and composition behavior → `docs/active/six-concept-runtime-architecture.md`;
- server admission, scoped receipt and Store 6 transaction/compatibility → `docs/active/runtime-authority-boundary.md` and
  `docs/active/runtime-resilience-qualification.md`;
- history/query-only separation and shared App carrier → `docs/active/sqlite-runtime-log-query.md`;
- one trusted Workspace admission → `docs/active/workspace-trust.md`;
- production entrypoint/support wording → `docs/active/execution-platform-support.md` and ADR-0053.

The new ADR and these understanding manifests are not `authorities` and cannot satisfy docs-impact themselves. KRSV1-10 must
update the owner README/current authority/docs map in the same change as the behavior it documents, then run
`bun run check:docs-impact` and `bun run check:docs` without bypass.
