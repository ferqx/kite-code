# Agent Note: 原 MCP 工具 metadata 由真实 publisher 封存为不可变 Artifact

Status: implemented

## Problem

新 MCP 的可执行 ToolDefinition 与有限连接目录不足以向用户展示实际原工具的全部描述和 schema。把完整 SDK Tool 放入普通 Query、ToolResult 或 Worker 记录会扩大既有有界协议；在查看时重新 discovery 或借当前缓存替代旧目录，会混淆 generation、冷历史及实际副作用。用户查看历史不能同时建立连接或获得 Tool 执行授权。

## Decision

实际 dispatched connect/refresh Tool 或 Action 在执行成功尾部同步捕获同一个冻结 SDK metadata generation，与原 saved catalogue 匹配；按实际 publisher Execution scope 保存 canonical UTF-8 的64 KiB chunks、manifest、32项 index pages 和 root。root 原字节 hash 即 indexDigest，节点不含自身 digest。getter、冷 Query 和缓存读取不发布、不 discovery、不联网。

两种 builtin.mcp Query 只读原 snapshot/index，完整 display envelope≤32 KiB/32 rows。公共 Client 沿现有 ArtifactReader 单次读取原 manifest，按准确 refs 顺序核完整 EOF/size/hash/fatal UTF-8/JSON/schema 后才交付整个原 SDK Tool；accepted 字段与省略保留，有限 label 明示截短。共享 TUI 保存原 generation 与 scope，可在空目录或 Server 已移除后选择旧页并滚至全文尾部；关闭或切scope只取消自身读取。

metadata available 与当前 live 分开。普通 Tool 与 Action 都可以成为实际 publisher；相同 key 的 prior 分支保持原事实，零按当前 cache 重发。发布失败保留真实连接/刷新 effect，并尝试保存有限 unavailable；record 写入未确认仍保 unknown，Query 不修补。Artifact 树不授执行权限。

non-executable ExtensionRecord 没有独立 writer Execution 字段，originStoreId 可为 null；sourceRecordKey 只定位，不能独立证明 writer。读取核实际 publisher 保存结果去 toolsMetadata 后与完整 source value 全等，原输入 digest/版本/Store/Session、真实 connection command/parent/root-work及 Artifact scope。warm connection 的原 operation key A 与合法新 source key B 分别证明，不要求两个 parent 相等、不依赖可变 A record head；私有 bootstrap Job 全文不由公共投影重建。当前 Store 只负责 admission，恢复后的原 origin Store 仍用于 Artifact 核验；不修改通用 SQL/Core/HTTP schema。

当前协议与累计上限归[MCP owner](../../../../packages/agent/src/mcp/README.md#query节点与工程上限)，公共读取归[Client](../../../../packages/client/README.md)，交互与实际终端归[TUI](../../../../packages/ui/src/tui/README.md)和[CLI](../../../../apps/cli/README.md)。原来源与认证的未完成范围仍见[scoped MCP提案](../../proposed/architecture/2026-10-03-scoped-default-mcp-sources.md)，本决定保留[原 Select 决定](../feature/2026-07-19-mcp-tui-select-management-center.md)的可见选择、scope与独立许可理由。

## Alternatives considered

- 从可执行 ToolDefinition 重建展示：会丢 SDK accepted 字段和 absent 语义，保存实际完整原 descriptor。
- Query 或冷打开时重新 discovery：会产生连接/凭据/RPC并替换原 generation，只在显式 connect/refresh 原执行封存。
- 把全文或完整 catalogue 放 Worker/ToolResult：会放大 ordinary/control 与待处理请求预算，使用 immutable chunks 和有限 pointer。
- 每块都调用 detail Query 重新解析 manifest：会按 chunk 数重复大 manifest IO，直接公共 Artifact read 一次 manifest 后读原 refs。
- latest 自动替代原 snapshot：会混绑旧 definition/version/批准对象，用户选择固定原 snapshot，当前 live 单独观察。
- sourceRecordKey 或手写 scope 作为独立 writer 证明：普通 record 没有该事实，额外核实际 publisher result/operation/Artifact scope，准确保留证明边界。

## Consequences

顺序发布大型目录增加原 connect/refresh 保存时间与磁盘占用；节点、整树 Artifact 和 metadata 总量上限使整份 unavailable，不把部分 root 或前缀称 complete，也不扩大 Worker 预算。部分 Artifact 可以存在但未形成可用 root，保存失败不能抹掉已经发生的连接。只读 admission 保留现有8192 records整组上限，超过上限仍有限失败。来源核查证明实际公共事实与 Artifact 绑定，不承诺任意全ledger伪造或物理Blob保真。

实际 macOS Agent13/952包含普通 Tool connect/refresh、两代3.66MiB原全文、warm B复用A、故障否例及公共maintenance A→B冷读；公共Client HTTP40/128验证18chunks超过1MiB和Unicode跨块；UI/Host25/550及源码外80×24暖冷PTY1/43验证后页、完整schema/metadata尾帧，832GET、RPC保持4、Model/凭据0。PTY自身默认wire预算不变、schema约714KiB，不能冒称其验证大于1MiB；正常关闭清理已证，timeout/throw/SIGKILL清理未注入。cancelled-A、A head变化及全部累计极限未取得实际资格。Root正常八build与完整Root/八types已通过，整体默认图另按V1.3进度核对；本implemented决定不代表全部MCP管理、OAuth、OS vault、安装或三平台资格。
