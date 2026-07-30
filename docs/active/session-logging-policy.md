# Session logging policy

状态：active

读取时机：修改 SessionLogCollector、Runtime 日志事件映射、日志字段、日志目录创建或 `sessionLoggingPolicyV1` 时。

验证：`bun test tests/session-logger/metadata.test.ts tests/session-logger/recorder.test.ts tests/session-logger/writer.test.ts`、`bun run typecheck`。

相关：`model-provider-boundary.md`、`feature-flags.md`、`docs/space/plans/2026-07-29-agent-production-local-data-privacy.md`。

## 模式与组合

`SessionLogCollector` 只接受 `off | metadata | content` 三种已解析模式。当前 Runtime 组合根按
`sessionLoggingPolicyV1` 选择：关闭为 `off`，开启为 `metadata`。`off` 不创建 writer、目录或
正文缓存，也不能回退到旧 content serializer。`content` 是兼容能力，不是 production 默认，
后续 composition/profile/opt-in 门禁完成前不得由 project config 打开。

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
