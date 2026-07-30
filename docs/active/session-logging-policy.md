# Session logging policy

状态：active

读取时机：修改 SessionLogCollector、Runtime 日志事件映射、日志字段、日志目录创建或 `sessionLoggingPolicyV1` 时。

验证：`bun test tests/session-logger/metadata.test.ts tests/session-logger/recorder.test.ts tests/session-logger/writer.test.ts`、`bun run typecheck`。

相关：`model-provider-boundary.md`、`feature-flags.md`、`docs/space/plans/2026-07-29-agent-production-local-data-privacy.md`。

## 模式与组合

`SessionLogCollector` 只接受 `off | metadata | content` 三种已解析模式。App 配置加载边界先
合并 artifact policy、用户配置和项目配置，再把 resolved policy 注入 Runtime；Runtime 不从
展示层配置重新推导 mode。`sessionLoggingPolicyV1=false` 时强制为 `off`；开启且 artifact
policy 未放宽时为 `metadata`。

`off` 不创建 writer、目录或正文缓存，也不能回退到旧 content serializer。`content` 必须同时
满足 artifact policy 允许和用户/管理员在用户配置中显式设置 `mode: content`；artifact 单独
允许不能代表用户同意。项目配置不得开启 `content`，也不得把 artifact/用户限制放宽。TUI
每个 session 首次运行显示 resolved mode，CLI 每次运行把 mode 写到 stderr；进入 `content`
时两端都显示独立披露。

## Metadata allowlist

Metadata 记录由 `metadata-mapper.ts` 直接从结构化 RuntimeEvent 构造，禁止先序列化完整事件再
删除字段。允许字段限于：

- event type、status、duration；
- 低基数 tool/capability kind 与 `FailureKind`；
- token、cache、retry 计数；
- approval/verification 类型与结果；
- compaction before/after/failure kind；
- release version/profile/cohort。

动态 MCP 工具名统一收敛为 `mcp_tool`，未知工具名收敛为 `other`，不得形成高基数或内容旁路。
Provider policy 状态只记录固定 capability kind、结构化 reason 与批准 revision/digest，不记录
route、endpoint 或 payload。revision/cohort 使用最多 64 字符的小写标识格式，digest 只接受
`sha256:` 加 64 位小写十六进制，release version 最多 32 字符且只接受版本字符；不合法值直接
省略。release profile 是 `limited | internal | canary | ga` 封闭枚举。

永久禁止 user/model/reasoning/summary 正文、tool args/stdout/stderr、MCP content、文件和
workspace path、Plan/Skill/Capability description、base URL、header、credential reference、
原始异常栈和 Provider response body。Failure classifier 只消费结构化 failure，不从用户可见
字符串推导新的 kind。

Secret fixture 必须同时注入唯一 secret、绝对路径、命令和源码 marker，并断言 metadata 输出
全文不包含任一 marker。

## Content 兼容边界

`content` 仅保留经过脱敏的用户消息、模型可见回答和最终回答。即使显式 opt-in，仍禁止：

- reasoning；
- tool args、stdout/stderr、summary 和文件路径/内容；
- approval command/reason/effects；
- Plan/update/interrupt 原始对象；
- Sub-agent task、tool args、summary、blocked command 和错误正文；
- verification subject；
- API key、token、Authorization header 和 private key。

collector 在 content 路径先按 event type allowlist 拒绝事件，再调用专用 content mapper；不得把
通用 Runtime event serializer 当作 content writer。session 边界不携带 workspace、model、设备
或 thread 标识，content 模式不生成 `summary.json` 或独立 error log。正文进入 mapper 前还必须
取得可信 runtime secret detector 的结构化 `clear` 结论；detector 缺失、返回 unknown/secret
或抛错时拒绝该正文。Regex 脱敏只能作为 clear 结论后的纵深防御，不能作为允许落盘的依据。
CLI/TUI composition 使用当前 Runtime 持有的 API key 与 credential 类环境变量建立 exact-match
secret 集合，并叠加保守 secret shape/protected-path 检测；Core 组合根也提供相同的 fail-closed
默认 detector，确保披露为 content 时 clear 正文实际可写且命中 secret 的整条正文不写。

该模式不是未治理的“全量序列化”。新增 event 字段默认不落盘，必须先更新本规则与安全测试。

## Logger 失败

writer 构造、写入或 finalize 失败时，collector 立即停止继续写入，并向 App 最多报告一次固定、
脱敏诊断。失败不得传播到 Runtime、不得改变 run terminal outcome，也不得写到权限更弱或含
正文的 fallback。
