# 文档体系

AI 请先读 [AGENTS.md](AGENTS.md) 获取简明工作流。本文件是 AI 与开发者共用的入口。

当前总体架构见 [Kite Code 六概念 Runtime 架构](active/six-concept-runtime-architecture.md)。每个 workspace 的职责、依赖、公开入口与局部不变量由自身 README 定义；跨包行为、安全、恢复、发布与运维规则位于 `active/`。

## 权威顺序

1. 用户、system 与 developer 的直接指令。
2. 当前源码与测试。
3. 改动所属 workspace README 及其索引的本地 current 文档。
4. 与改动范围匹配的 `active/` 跨包记录。
5. `adr/` 中已接受的 ADR。
6. book、计划、调研、完成记录与外部参考。
7. `design/` 和 `deprecated/` 永远不是当前实现依据。

代码与 current authority 冲突时，必须在同一改动中更新 owner 文档；跨包行为变化同时更新 active 记录，不得静默保留过期文档。

## 工程环境基线

GitHub Actions 与正式 qualification 统一使用 Bun `1.4.0`。所有 `setup-bun` workflow 必须显式 pin
该版本；版本变更必须同时更新 workflow、formal verifier、测试夹具和对应 current authority。

## 映射精度

`documentation-map.json` 只映射拥有当前行为的生产源码、package manifest 和测试/发布基础设施。普通测试、
fixture 与 owner-local 文档不因位于 workspace 目录内而触发架构 authority。被专业规则覆盖的 Model、MCP、
Sandbox、TUI、qualification 或 observability 路径必须从通用 owner 规则排除；代表路径矩阵负责防止规则重新
膨胀或跨语义满足。根 `package.json` 同时承载安装、测试和 workspace 配置，使用独立
`root-package-manifest` 规则，由实际发生变化的 current authority 承接，不强迫修改无关 Runtime 文档。

Runtime Server V1 将 `runtime-protocol`、`runtime-server`、`runtime-client`、Host command receipt、App
carrier 与跨 transport qualification 分成独立映射规则；通用 Runtime/App owner 必须排除这些专业路径。
同一生产文件仍只能命中一个 source owner，新增 transport、receipt 或 workspace 时必须同步代表路径矩阵，
不得靠重叠规则让任意一份无关 authority 满足检查。

当前 terminal App workspace 的规范路径是 `apps/kite-cli`，workspace-local source alias 是
`#kite-cli/*`；旧 `apps/kite`、`@kite-ai/kite`、`#app/*` 与 `@/app/*` 只可作为历史记录或明确的负向
fixture。后续新增 Service 或 package 时，只有在 source 与 owner README 实际存在的同一改动中才加入 V2
规则，不以无效 future path 或空 workspace 预占 documentation owner。

当前 Browser observer workspace 的规范路径是 `apps/kite-web`。它是独立的 private presentation workspace，
只消费 browser-safe `@kite-ai/kite-app-contract`，不属于 Service/Runtime composition，也不得依赖 Native、Host、
Store、Protocol、Service、CLI 或 raw Runtime source；其 `@/` alias 只解析到自身 `src/`，不新增 `#kite-web/*` alias。
源码中的完整Web启动入口是根`package.json`的`bun run web:dev`：它依次执行Web build、fixed asset preflight和single-Service Web
ensure。`apps/kite-web`的Vite dev server只是资源开发入口，Browser也不拥有启动本机Service的authority；当前角色见
[`active/single-service-local-runtime.md`](active/single-service-local-runtime.md)，旧Gateway恢复仅见transition文档。
KASAPI-01A后，根build、test、typecheck discovery覆盖15个实际workspace；新增的
`packages/agent-api-contract`是zero-workspace-dependency、browser-safe Public wire contract，当前由Service Agent API façade消费。Runtime
package owner gate当前覆盖15个workspace并检查Service→contract唯一依赖边，独立`check:agent-api-packages`继续强化Public contract/consumer
边界；`apps/kite-web`仍不成为Runtime
composition owner。KASAPI-01B后，该owner rule同时覆盖package-local generator script与committed `generated/**`，确保artifact变化命中同一
current authority；generator不成为runtime export。KASAPI-02C后，Web build逐字节把canonical OpenAPI装入固定
`payload/web/api-docs/openapi.json`，只读`/api-docs` renderer不发现Worker、不保存credential也不提供在线执行。Agent API跨包当前边界见
[`active/agent-api-contract.md`](active/agent-api-contract.md)。

Local Runtime Service 的客户端边界已经分成 browser-safe `kite-app-contract` 与 Bun/Node-only
`kite-local-runtime`；前者使用独立 App Control source owner，后者的 Native client 与 Service state primitive
使用互斥规则。未来 listener/process 实现不得落回通用 CLI、Runtime Client 或 carrier 规则。
当前默认单Service、单SQLite、最小OS runtime与legacy migration边界见
[`active/single-service-local-runtime.md`](active/single-service-local-runtime.md)。

KLSV1-06 clean cutover 后，`apps/kite-service` 的 application/composition、carrier、Runtime backend、App Control、
MCP、Sandbox、Observability、Session Logger、release 与 process harness 使用互斥 owner；`manager/**` 已迁入
`kite-local-runtime-manager`。不得添加覆盖整个 Service source 的 generic 通配规则，也不得让已迁出的 CLI 路径
继续满足 Service authority。Native filesystem primitive 仍由 `kite-local-runtime-service-state` 独占；代表路径测试
固定验证每个生产文件只命中一个 owner，并验证 `apps/kite-cli` 仍有真实 package consumer，不能靠放宽 public entry
消除 consumer gate。

process harness 继续是未公开 fake-application fixture，不能用其 source 满足真实 composition 或 release authority。
CLI Service-mode adapter只消费`kite-local-runtime/client`，不拥有 manager、carrier 或 backend。

## 并发开发

可写任务可直接使用只有本任务改动、唯一 Git owner且没有authority冲突的当前工作树。独立 branch/worktree只用于隔离无关dirty状态、
并发写入、用户明确要求或长期独立分支；它不是默认前置步骤。临时worktree完成验证后默认fast-forward合并并清理，不能安全合并时再请求方向。
默认 `all` 作用域检查当前任务工作树的完整状态，pre-commit 使用 `staged`，CI 使用 `range`。同一 current authority不能由两个任务并发拥有；
后开始的任务必须等待、rebase并重新验证。不得建立文档锁服务、临时authority副本或兼容重定向来规避冲突。

本地TUI开发中，`bun run tui`允许复用wire-compatible的常驻`dev:` Service，并在build drift时显示警告；使用`/status`核对
Service PID、启动时间和actual/expected build。需要确保加载当前源码时使用`bun run tui:fresh`，它通过现有manager安全restart后再启动TUI。

## 目录职责

- `packages/*/README.md`、`apps/*/README.md` 与 workspace `docs/` — 模块局部当前职责、边界和验证。
- `active/` — 跨 workspace 当前行为、安全、恢复、持久化、发布和运维指引。
- `book/` — 面向新开发者和评审者的解释性导览；它不定义当前行为，冲突时必须回到源码、测试和对应的 workspace/active authority。
- `design/` — 未来 RFC 与提案；批准后必须先转入 `space/plans/` 才能实施。
- `adr/` — 已接受的架构决策；不改写历史，使用新 ADR 替代旧决定。
- `deprecated/` — 不得作为实现依据的历史材料。
- `space/plans/` — 具有明确验证条件的提案或进行中工作。
- `space/execution/completed/` — 已完成工作的验证证据。
- `space/understanding/`、`space/references/`、`space/backlog/` — 背景、调研与延期工作。

## 文档生命周期

```text
design/RFC → space/plan → 实施 + active/ + ADR（架构级变更）
                                  ↓
                      execution/completed 验证证据
                                  ↓
                         不再有效时迁入 deprecated/
```

每份新跨包 `active/` 记录必须包含：

```markdown
状态：active
读取时机：何时必须阅读。
验证：对应测试或验证命令。
相关：关联 ADR、计划或代码入口（可选）。
```

模块局部文档使用 workspace `docs/` 路径并由 README 索引；ADR、book、plan、completed、design、deprecated 和索引不得出现在 `documentation-map.json` 的 `authorities` 中。相关决策见 ADR-0140。
