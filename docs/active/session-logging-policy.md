# Session logging policy

状态：active

读取时机：修改 SessionLogCollector、Runtime 日志事件映射、日志字段、日志目录创建或 `sessionLoggingPolicy` 时。

验证：`bun test packages/builtin-runtime/test/model-secret-detector.test.ts tests/session-logger/metadata.test.ts tests/session-logger/recorder.test.ts tests/session-logger/writer.test.ts tests/session-logger/active-session-lease.test.ts tests/session-logger/retention.test.ts tests/session-logger/writer-security.test.ts tests/model-invocation-gateway.test.ts tests/execution/workspace-filesystem-provider.test.ts`、
`bun run scripts/release/session-log-acl-smoke.ts`、`bun run typecheck`。

相关：`model-provider-boundary.md`、`feature-flags.md`、`docs/space/plans/2026-07-29-agent-production-local-data-privacy.md`。

Session Logger 与 remote observability 是独立通道。启用本地 metadata/content logging 不授予 remote
telemetry consent；remote consent 也不改变本地 logger mode、retention 或正文排除规则。Runtime 恢复输入与
日志写入是两个独立域：Session Logger 不能作为 Runtime event source，也不能扩大 content allowlist 或复制
production Artifact。

## 模式与组合

RM-04 将 TUI 的累计 token stats SQLite 访问移入 `@kite/runtime-storage-sqlite` 的显式
`SessionMetadataPort`；SessionManager 只接收注入的 `save/loadAll/close` port，不再持有 raw SQLite handle。
token stats 仍是 App session metadata，不是 Session Logger、Runtime State/Event 或 remote telemetry，既有
`session_stats` 布局、journal 策略和隐私边界均未改变。

RM-05 的 Host mailbox 与 notification projector 不属于 Session Logger，也不新增日志序列化器。它们只处理
Client-safe command/receipt/projection/stream DTO；Runtime 执行仍按既有 resolved logging policy 写入唯一
collector，Host 不复制正文、reasoning、Tool 参数、credential 或 Artifact 内容。

RM-06 的 Host lifecycle、effect supervisor 与 restart recovery 也不成为第二个 Session Logger owner。Host
只管理 execution signal、SQLite Store acknowledgement/lease 与 Client-safe notification；唯一 App execution
bridge 继续把既有 Runtime events 写入原 collector。取消、续租失败和 recovery 不得把正文、reasoning、Tool
参数、credential 或 Artifact 内容复制到 Host receipt/notification。

`SessionLogCollector` 只接受 `off | metadata | content` 三种已解析模式。App 配置加载边界先
合并 artifact policy、用户配置和项目配置，再把 resolved policy 注入 Runtime；Runtime 不从
展示层配置重新推导 mode。`sessionLoggingPolicy` 默认开启，artifact policy 未放宽时为
`metadata`；用户显式设置为 `false` 时强制为 `off`。

`off` 不创建 writer、目录或正文缓存，也不能回退到旧 content serializer。`content` 必须同时
满足 artifact policy 允许和用户/管理员在用户配置中显式设置 `mode: content`；artifact 单独
允许不能代表用户同意。项目配置不得开启 `content`，也不得把 artifact/用户限制放宽。TUI
对 `off` 与 `metadata` 不显示状态提示；TUI 不把 session logger 的内部 diagnostic 注入正常
对话渲染；CLI 每次运行仍把 mode 写到 stderr。进入 `content` 时两端都显示独立披露。

## Metadata allowlist

Metadata 记录由 `metadata-mapper.ts` 直接从结构化 RuntimeEvent 构造，禁止先序列化完整事件再
删除字段。允许字段限于：

- event type、status、duration；
- 低基数 tool/capability kind 与 `FailureKind`；
- `ToolOutcome` 的固定 status/detail、dispatch/effect certainty、recovery disposition 与
  Runtime-boundary queue/execution/approval/total timing，以及 unknown-field 的 has/count/tool class；
- token、cache、retry 计数；
- approval/verification 类型与结果；
- compaction before/after/failure kind；
- release version/profile/cohort。

动态 MCP 工具名统一收敛为 `mcp_tool`，未知工具名收敛为 `other`，不得形成高基数或内容旁路。
Tool outcome 的 `failureInstanceId`、`recoveryOf`、内部 canonical digest fingerprint、schema
revision、未知字段名/值和 classifier/provider 正文永不进入 Session Logger；unknown-field 只保留
布尔值、0–255 计数与固定 tool class。
`totalActiveMs` 由 Runtime queue boundary 到 terminal 计算；人工审批等待使用持久化
`approval.requested.createdAt`，auto-review 成功使用 review duration 累加 approval wait；风险判定升级
人工审批后继续累计真实 approval wait，而不是
UI wall clock；成功 terminal 同样保留 approval wait 与 `totalActiveMs`。reducer、模型恢复 guidance、
Session metadata、`tool_duration_ms` metric 与 TUI 都从同一 outcome status/recovery/timing 投影。持久
event 必须通过当前 epoch 的 strict payload decoder 与 SQLite Store checksum/metadata 校验；未知、退役或身份不完整
的事件直接把恢复标记为 corrupted，不进入 reducer、TUI replay 或 logger。在线路径不存在
旧 decoder，也不能用旧字段覆盖 canonical outcome；TUI 不得把所有 approval/auto-review/cancel
terminal 硬编码为 `cancelled`。
`approval.rejected` 与没有 `escalatedToUser` 标记的历史拒绝型 `auto_review.completed` 是 canonical tool
terminal observation；当前自动审批风险判定携带 `escalatedToUser`，属于人工审批前的非终态，不生成
ToolOutcome 或 tool terminal metric。terminal metrics 各自恰好生成一组
`tool_total + tool_duration_ms`，不得重复合成。
Provider admission 状态只记录固定 capability kind 与结构化 reason，不记录 route、endpoint 或 payload。
revision/cohort 使用最多 64 字符的小写标识格式，digest 只接受
`sha256:` 加 64 位小写十六进制，release version 最多 32 字符且只接受版本字符；不合法值直接
省略。release profile 是 `limited | internal | canary | ga` 封闭枚举。

`model.invocation_prepared/attempt_started/completed/interrupted/evidence_unavailable` 只允许记录 event
type 与结构化 status；metadata mapper 不复制 invocation id、Surface/Response Artifact ref、keyed
integrity identifier、route fingerprint、admission digest/policy revision、reservation identity、parent
link、attempt ordinal 或 finish reason。`dispatchCertainty=unknown` 的 interrupted invocation 及 evidence
unavailable 映射为 `unknown`，显式取消映射为 `cancelled`，其余 interrupted failure 映射为 `error`。
Artifact 正文和 locator 同样永久禁止进入 content logger。生产代码不存在接受任意 RuntimeEvent 的
全事件/OTel-compatible serializer；唯一正文 projector 只在类型层接受用户消息与模型可见回答。

`capability.invocation_recorded/execution_started/execution_result_recorded/execution_succeeded/
execution_failed/execution_unknown/reconciliation_resolved` 同样只映射为固定
`capabilityKind=runtime_capability` 与封闭 status。metadata/content logger 和 remote observability 都不得复制
invocation/tool call identity、arguments/authorization/admission/effect digest、attempt ordinal、idempotency key、
result/evidence digest、Capability Artifact ref/locator、external reference、error/reconciliation 文本或时间戳。
Capability Artifact 正文永不进入 logger；新增 receipt 字段默认不记录。

`capability.filesystem_mutation_ready` 是私有 commit barrier，不生成 Session Logger 记录。
filesystem terminal 即使携带 `filesystemObservation`，metadata/content mapper 也不得复制 actor/target/content
digest、opaque preimage ref、operation/identity/preimage digest、path、grant、approval summary 或 Provider
message。preimage Artifact 正文永久禁止进入 logger 和 remote observability；filesystem capability 最多沿
既有低基数 capability status/outcome allowlist 记录。新增 filesystem receipt 字段默认不记录。

Runtime 的 deadline、budget admission 等 `run.error` producer 可以携带结构化
`RunTerminalOutcome` 供 Runtime Store、恢复与前端投影使用；session metadata mapper 仍只记录
allowlist 中的稳定 `FailureKind`，不得把 terminal outcome 对象或用户可见错误文案整体序列化到
session log。

运行中 `/permissions` 产生的 `interaction_mode.changed` 只作为 Runtime Store 的权限审计事实；
SessionLogCollector 不为该 live-control 事件生成 metadata 或 content 记录，避免把用户授权时间或
source 扩散到 session log。

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
唯一 detector owner 是 `@kite/builtin-runtime/model` 的 `createModelSecretDetector`。CLI/TUI
composition 与 App run composition 都使用它，以当前 Runtime 持有的 API key 与 credential 类环境
变量建立 exact-match secret 集合，并叠加保守 secret shape/protected-path 检测；不存在第二 detector
别名、实现或 fallback。这样既确保披露为 content 时 clear 正文实际可写，也确保命中 secret 的整条
正文不写。

该模式不是未治理的“全量序列化”。新增 event 字段默认不落盘，必须先更新本规则与安全测试。

## Logger 失败

writer 构造、写入或 finalize 失败时，collector 立即停止继续写入，并向 App 最多报告一次固定、
脱敏诊断。失败不得传播到 Runtime、不得改变 run terminal outcome，也不得写到权限更弱或含
正文的 fallback。Windows ACL helper 只在内部异常中保留 bounded 原生状态/错误用于 native
smoke 定位；collector 不把该技术细节投影给 App。

## 安全存储、lease 与回收

App/Runtime 把完整 resolved policy 注入 writer。POSIX 上 `.kite-code`、sessions root、
frontend 和 session 目录收紧为 `0700`，日志与 lease/terminal metadata 为 `0600`；Windows
对同一路径应用 owner-only、禁继承 ACL；helper 只调用 `System32` 下的 `whoami.exe` 解析当前用户
SID，并在进程内缓存。Windows 不在 Runtime 热路径调用 `icacls` 或 PowerShell；helper 通过
Advapi32 的同步安全描述符 API 设置 owner、protected DACL 和唯一的当前 SID FullControl ACE；lease
进程起始 identity 通过 Kernel32 `GetProcessTimes` 读取。二者避免会话启动被外部子进程阻塞。路径 segment 使用封闭格式并拒绝 Windows reserved 名称；原生 API
任一步失败即 fail closed，错误会包含被操作目标和 Windows security API 上下文，供本地 native smoke 诊断。任何 user data/session
root、session 目录或目标文件 symlink/reparse point 都 fail
closed。JSON metadata 使用同目录 exclusive temp、fsync、rename 和目录 fsync；JSONL append
在 writer 构造期以 no-follow descriptor 立即打开并固定，不延迟到首批事件。所有受管文件必须
是 `nlink=1` 的 owner-owned regular file；构造、每批 append 与 retention 都拒绝 symlink、
reparse point 和 hardlink。writer/lease 同时固定 `.kite-code`、sessions root、frontend、
session 的 dev/inode 与 canonical realpath，并在 append、heartbeat、terminal/release 前重验；
任一祖先被移动、替换或 link-back 时停止写入，也不沿替换后的路径执行空文件清理。

每个活动 session 持有 durable lease，绑定 PID、process start identity、OS owner、session
directory identity、nonce、创建时间和 heartbeat。正常/失败/容量终止先原子写
`terminal.json`，再释放匹配 nonce 的 lease。另一个 TUI/CLI 进程不能取得同一 session；
heartbeat 未过期、进程 identity 仍匹配、wall-clock 回拨、PID identity 不可确认或 lease
损坏时，cleanup 都保守保护目录。只有 heartbeat 超过 stale window 且 PID/start identity
不匹配时才可回收；如果持久化的 dev/inode 因 macOS volume remount 或恢复而漂移，仍要求
owner identity 匹配且记录 PID 已确认死亡，才允许在 session operation lock 内回收该 lease，
随后使用当前目录身份创建新 lease。macOS writer 为当前进程使用带 `darwin:fallback` 标签的稳定
`performance.timeOrigin` identity，
不得把能否启动 `ps` 作为建立本进程 lease 的前置条件；检查其他 PID 时仍使用系统进程信息，
`darwin:fallback` 与 `darwin:ps` 明确不可比较：只要记录 PID 仍存活，身份不同或无法读取都必须
返回 `unknown`，不能据此回收；只有已知 PID 死亡，或双方使用可比较 identity 且确认 PID reuse，
才能把过期 lease 判为 stale。

retention/migration 使用逐条 directory iterator，在固定时间与条目预算内扫描；root、
frontend、session 内的每个观察条目都计入预算，不先把任意目录整体载入内存。只有完整扫描后
才按 `(mtime, path)` 稳定最旧优先删除超过 retention/总容量的非活动 session；部分扫描不会
基于局部候选执行删除。每次删除前在 session operation lock 内重验 lease 与目录 identity。
含未知文件/link/hardlink 的 session 原子移入 sessions root 之外的 owner-only
`sessions-quarantine` 恢复区；迁移本身不遍历、不删除隔离内容，完整扫描仍可证明受管 root 容量时
允许新 writer 建立。旧版 root 内 `_quarantine` 首次 maintenance 整体原子迁出，避免隔离数据
超过扫描预算后永久自锁；macOS 自动生成在 root 或 frontend 层的 `.DS_Store` 同样移入恢复区。
其他未知 root/frontend 条目、扫描超预算、容量不可证明或隔离迁移失败仍 fail closed，新 writer 不建立。恢复区不属于
session retention 自动删除范围，需要人工审计或清理。
POSIX maintenance 默认时间预算为 50ms；Windows 因 owner-only ACL 需要运行原生身份与权限工具，
默认使用 30 秒预算。两者都保留 512 个观察条目的独立硬上限，显式配置可进一步收紧预算。

不同 session 的 maintenance 与 lease 创建还由 sessions root 的跨进程 admission record
串行化，避免两个 writer 同时通过总容量检查。operation/admission record 使用 exclusive create
与 PID/start identity/nonce 绑定释放；由于当前跨平台文件 API 没有安全的 unlink-CAS，进程
持有 operation/admission record 时 crash 后不自动抢占该 record，而是 fail closed 并要求人工
隔离/恢复，不能用有双 reclaimer 竞态的 stale unlink 冒充恢复。

归档的 `2026-06-18-session-logger.md` 只记录旧实现历史，其中“全量本地日志”的结论不再代表
当前行为。Phase 1A 迁移先收紧可识别旧目录和文件的 owner-only 权限，再按本节 lease、容量与
retention 规则接管；session 内未知条目、link/hardlink 只做可恢复隔离，不读取或复制旧正文；
损坏 lease、未知 root 条目或无法证明完整扫描时拒绝建立新 writer，也不把旧全量 serializer
作为兼容 fallback。

默认测试 runner 同时隔离 `HOME` 与 `KITE_CODE_HOME`。直接执行 session writer 定向测试时，
测试文件自身也必须创建并清理临时 `KITE_CODE_HOME`，不得依赖 runner 包装层，避免开发者的真实
`~/.kite-code/sessions` 被测试 session 污染。

单 session 使用 UTF-8 byte 计数；达到 `maxSessionBytes` 时最多写一条无正文
`session.logging_limited` metadata，停止后续记录，并为 bounded terminal marker 预留空间。
总容量 maintenance 为新 session 预留其完整上限。原生 ACL smoke 在 macOS、Ubuntu 和 Windows
runner 验证权限、link/reparse rejection 与 terminal 原子落盘，并分别上传带 OS/Bun
身份的 `session-log-acl-<runner>` JSON 证据。Windows smoke 的独立只读验证固定调用 `System32` 下的
Windows PowerShell 5.1，并把 `PSModulePath` 固定到同一系统目录；它不复用生产 ACL API，因此能独立
验证实际写入的 owner 和 DACL。
> 路径同步：session logging 使用当前无版本命名的 runtime state/store 路径。
