# Kite Local Runtime Service V1 App relocation manifest

日期：2026-08-27

用途：KLSV1-00 对 `apps/kite/src/**` 的完整 owner partition。此文件是实施清单，不是 current authority；实际移动
必须同步目标 workspace README、`docs/active/` 与 documentation map。

相关：ADR-0144、[`Kite Local Runtime Service V1 实施方案`](../plans/2026-08-27-kite-local-runtime-service-v1.md)、
[事实与依赖基线](2026-08-27-kite-local-runtime-service-v1-baseline.md)。

## 覆盖与执行顺序

基线 `119cd271` 下 `apps/kite/src` 精确包含 261 个 `.ts`/`.tsx` 文件。下表是互斥 partition，计数总和为
261；目录规则按完整相对路径匹配，不使用优先级重叠。KLSV1-01 先把整棵 workspace 机械移动到
`apps/kite-cli`，不改变下列最终 owner；KLSV1-02/03 提取 contract/facade，KLSV1-06 按本表一次性完成真实 Runtime
owner relocation。任何新文件都必须在写入时显式加入同类 owner/文档映射，不能依赖“最近目录”猜测。

| 当前互斥路径 partition | 文件数 | 最终 owner | 迁移裁决 |
| --- | ---: | --- | --- |
| `tui/**` | 100 | `apps/kite-cli` | Ink/React、reducer、render、i18n、terminal/input、UI controller；所有 direct Manager/Store/Builtin 依赖改 client |
| `bootstrap.ts`、`bootstrap/**` | 59 | `apps/kite-service` | 唯一 Runtime Application/composition/execution/recovery owner；`TuiRuntimeBridge` 原文件拆分后删除 |
| `cli/**` | 2 | `apps/kite-cli` | parser、stdout/stderr、foreground prompts；Runtime/stdio/internal child owner改为 Native client/managed Service |
| `adapters/tui/**` | 1 | `apps/kite-cli` | 用 explicit closed `TuiRuntimeClientFacade` 替代从 `SessionManager` 派生的 facade |
| `carrier/**` | 6 | 见逐文件表 | Native client transport、Service-side carrier 与 development-only fixture 分开，禁止整个目录原样搬迁 |
| `config/**` | 14 | `apps/kite-service` 为原逻辑 owner | language/theme 等纯 UI preference 拆到 CLI；safe DTO 到 contract；不整体共享 config package |
| `git/**` | 2 | `apps/kite-service` | Git broker/process environment 与 Workspace authority |
| `index.ts` | 1 | `apps/kite-cli` | 只保留 CLI/TUI public entry；删除/迁移 Runtime composition export |
| `logs/**` | 1 | `apps/kite-service` | raw Runtime log safe projector，供 History handler 使用 |
| `observability/**` | 6 | `apps/kite-service` | exporter/consent/Runtime bridge owner；status 只提取 safe DTO/formatter |
| `release/**` | 10 | `apps/kite-service` | manifest/profile/capability/execution authority；status 只提取 safe DTO/formatter |
| `runtime-client/**` | 7 | 见逐文件表 | raw projector/History 入 Service，safe facade/command allocator入 client side |
| `runtime-projection.ts` | 1 | `apps/kite-cli` | foreground CLI safe terminal/tool outcome formatting；必要 pure DTO 可入 contract |
| `runtime/session/**` | 10 | `apps/kite-service` | SessionManager/Runtime/registry/lifecycle/rewind/compaction/planning；contracts 中 safe DTO另行提取 |
| `runtime/tool-execution/**` | 8 | `apps/kite-service` | Builtin/MCP/Skill/Subagent executor/router/terminal projection |
| `runtime/tool-persistence/**` | 11 | `apps/kite-service` | attempt/receipt/filesystem evidence/mutation/recovery |
| `sandbox/**` | 9 | `apps/kite-service` | sandbox composition、prepared process/tool pipeline、recovery |
| `session-logger/**` | 9 | `apps/kite-service` | logging policy enforcement、lease、collector、retention、writer |
| `session-types.ts` | 1 | `@kite-ai/kite-app-contract` | frontend-safe Session/History DTO；先移除对 TUI presentation type 的反向依赖 |
| `trace/**` | 1 | `apps/kite-cli` | explicit user-invoked trace file reading/formatting，不是 Service Runtime authority |
| `workspace/**` | 2 | `apps/kite-service` | worktree/change handoff writer authority |
| **总计** | **261** | — | partition 完整 |

## carrier 逐文件裁决

| 当前文件 | 最终 owner/disposition | 约束 |
| --- | --- | --- |
| `carrier/bun-stdio-child-transport.ts` | `kite-local-runtime/client` | Native child/stdio connector；只给显式隔离 Store/reference 使用 |
| `carrier/bun-websocket-transport.ts` | `kite-local-runtime/client` | Runtime Client WebSocket framing/queue/backpressure primitive |
| `carrier/development-loopback-carrier.ts` | `apps/kite-service` 的 development/test carrier | 可抽 socket/backpressure primitive；production Native auth policy 独立 |
| `carrier/development-runtime-reference.ts` | qualification fixture；不进入 Web/Desktop/public SDK | 不产生 production entrypoint 或 future adapter |
| `carrier/local-bootstrap-auth.ts` | 保留 development-only 或删除 | bearer→cookie 单 session 模型不得复用为 production access/control/ticket auth |
| `carrier/runtime-server-stdio.ts` | `apps/kite-service` internal carrier | CLI workspace 不再拥有 Host/Server；要求显式非默认 Store |

## runtime-client 逐文件裁决

| 当前文件 | 最终 owner | 约束 |
| --- | --- | --- |
| `runtime-client/command-id.ts` | `kite-local-runtime/client` | one logical Runtime mutation 的 Native entropy；不属于 Server/Host |
| `runtime-client/event-projector.ts` | `apps/kite-service` | raw Runtime Event → closed safe event 的唯一 projector |
| `runtime-client/history-adapter.ts` | `apps/kite-service` | raw/SQLite readonly History composition；由 authenticated handler 调用 |
| `runtime-client/interaction-projector.ts` | `apps/kite-service` | raw State/effect identity validation 与 safe interaction projection |
| `runtime-client/presentation-history.ts` | `apps/kite-service` | raw durable event portion 全部在 Service；不得复制 CLI projector |
| `runtime-client/safe-text.ts` | `apps/kite-service` | projector 的 control-character/secret/size boundary |
| `runtime-client/tui-history-facade.ts` | `apps/kite-cli` | only consumes safe `RuntimeHistoryClient` DTO and builds TUI replay state |

## 必须拆分而非原样移动的混合文件

| 当前文件 | 原文件最终 disposition | 提取内容 |
| --- | --- | --- |
| `bootstrap/runtime/TuiRuntimeBridge.ts` | 删除 | Service execution/admission/recovery进入 Service；explicit TUI client facade进入 CLI/native connector；移除 Reflect/Proxy passthrough |
| `config/index.ts` | Service owner | language/theme/terminal-only preferences进入 CLI；provider/model/config safe DTO/action进入 App Contract |
| `config/paths.ts` | Service/native identity owner | `KiteHomeIdentity`/default Store/state paths进入 native/service；UI export path等CLI-only helper留 CLI |
| `config/features.ts` | Service authority | CLI只解析 exact request/展示 safe projection，不能直接改变 Service flags |
| `runtime/session/contracts.ts` | Service implementation file或删除 | frontend-safe interaction/status DTO进入 App Contract；sandbox/Builtin/Manager types不得随之进入 contract |
| `runtime-client/presentation-history.ts` | Service owner | TUI-only safe replay assembly留在 `tui-history-facade`，raw projection不跨 Service |
| `release/status-projection.ts` | Service source owner | no-secret status DTO/codec进入 App Contract；terminal formatter可留 CLI |
| `observability/status.ts` | Service source owner | no-secret status DTO/codec进入 App Contract；不得传 consent/exporter object |
| `session-types.ts` | 原文件迁入 App Contract后删除 CLI副本 | `SessionInfo`/`SessionData`只引用 safe contract types；UI-only unknown message block另留CLI |
| `index.ts` | CLI entry | `createKiteRuntimeBoundary` export删除或改为 Service-internal；`runCli`/`runTui`保留 |
| `cli/index.ts` | CLI entry | config/trust/sandbox/Git/observability/Store composition删除，替换为 exact clients |
| `cli/executable.ts` | CLI entry | `createKiteCliRuntimeServer`与Host-owned internal child移Service companion |

## TUI 文件的 owner 不等于依赖许可

`tui/**` 全部留在 `apps/kite-cli`，但以下 direct dependency必须替换；文件本身不因此搬入 Service：

| CLI 文件/区域 | 移除的 direct implementation dependency | replacement |
| --- | --- | --- |
| `tui/index.tsx` | default checkpoint、AgentConfig、sandbox、observability、SessionManager composition | Native Runtime/History/App clients + CLI-local preferences |
| `tui/hooks/useSkillsLoader.ts` | Builtin Skill scan 与 project path | exact Service Skill catalog query |
| `tui/hooks/useMcpController.ts` | MCP Supervisor/repository/credential/stdio/sandbox | exact App Control snapshot/actions；native secret route |
| `tui/mcp/controller.ts` | live Supervisor object | presentation controller over typed client |
| `tui/mcp/{model,types}.ts` | Builtin MCP control types | `kite-app-contract` safe DTO |
| `tui/components/WorkspaceTrustGate.tsx` | trust store read/write | App Control trust query/decision；Service revalidation |
| `tui/components/first-run/**`、`SetupWizard.tsx` | provider fetch/config/key persistence | safe Provider/model App Control + native credential command |
| `tui/components/ModelSelector.tsx`、`App.tsx` | local config/model persistence | App Control model snapshot/CAS action |
| `tui/provider.ts` | frontend-owned pending waiter | UI normalization/display only；Service interaction broker waits，Runtime command responds |
| reducers、`runtime-presentation.ts`、`replay-blocks.ts` | raw Runtime event assumptions | only closed live/History client events |
| `tui/exit-coordinator.ts`、unmount cleanup | `abortAll()`/Host dispose | close local connections only；Ctrl+C remains explicit cancel command |

## 非 source 文件 relocation

KLSV1-01 moves all 186 owner-local tests、5 local docs、README、package manifest and tsconfig mechanically to
`apps/kite-cli` while preserving their relative layout. Tests for Runtime implementation later follow the production owner:

- pure UI/facade tests remain `apps/kite-cli/test`;
- Service application/carrier/process/state tests move to `apps/kite-service/test`;
- package codecs/transports move to the matching package `test`;
- cross-package public-export tests stay `tests/integration`;
- cwd/env/SQLite/socket/real-process tests stay owner-local `test/isolated` or `tests/qualification`.

No collaborator or bulk move may stage partial paths. KLSV1-06 must delete the old backend files from CLI in the same tranche
that creates their Service owner; it may not retain app-to-app imports、copied backend、dual composition or silent fallback.

## 机械审计

实施时必须重新计算：

```bash
find apps/kite-cli/src -type f \( -name '*.ts' -o -name '*.tsx' \) | sort
rg -n "RuntimeHost|RuntimeServer|SqliteRuntimeStorage|@kite-ai/builtin-runtime" apps/kite-cli/src
rg -n "react|ink|#kite-cli|apps/kite-cli" apps/kite-service/src
rg -n "apps/kite-(cli|service)/src" apps/kite-{cli,service}/src packages/kite-{app-contract,local-runtime}/src
```

最终结果必须证明每个生产文件只有一个 source owner，CLI 无 concrete Runtime dependency，Service 无 Ink/React/TUI
reducer，两个 package 无 app import，raw History projector 只在 Service。
