# 模型输入、上下文与响应

入口：[context](../src/model/context.ts)、[projection](../src/model/context-projection.ts)、[surface compiler](../src/model/surface-compiler.ts)、[invocation gateway](../src/model/invocation-gateway.ts)、[response source](../src/model/response-source.ts)。

## 构造请求

Service 在运行准入时解析模型配置，Builtin 从 State view、项目指令、历史/压缩点、工具声明和当前阶段构造上下文。上下文预算与屏幕消息长度不同；不能从 TUI viewport 重建请求。

[项目指令快照](../src/model/project-instructions.ts)按目标路径读取 workspace 内适用的 `CLAUDE.md`／`AGENTS.md`，保留真实路径、普通文件、UTF-8 文本和 digest 校验；不再按单文件字节、合计字节或 token 数遗漏仍适用的指令。副作用前的 freshness guard 同时识别新增、内容变化和相关作用域内的删除，要求刷新模型上下文后重试；不相关路径的指令不触发误报。[指令回归测试](../test/project-instruction-guard.test.ts)与 [Service 投影测试](../../../apps/kite-service/test/project-instructions.test.ts)覆盖大文件、多个作用域和删除。

重复读取同一指令文件时按当前原始字节逐字节比较后复用解码文本与摘要；新增、删除和同尺寸改写仍由每次路径遍历和真实字节检查发现。压缩安全边界对工具调用和结果建立一次索引，逐项验证唯一配对与终态，避免长历史中反复扫描全部已覆盖消息。

历史中已持久化的子任务调用只保存私有 Artifact 引用。Service 在准确原模型 invocation 与工具调用身份下读取请求 Artifact，将公开 `{name, subagent_type, task}` 参数作为纯数据交给统一上下文投影；普通模型请求、预算预检和压缩摘要使用同一恢复结果，缺失或身份不符则拒绝投影。持久 State 与客户端历史仍只保留私有引用，不在公开工具 schema 中暴露 `taskArtifact`。

系统提示词从当前 Run 已持久化的资源预算读取 `maxConcurrentSubagents`，向主 Agent 和子 Agent 分别说明各自实际并发上限及超限立即拒绝的行为；不从可在运行期间变化的期望配置推断旧 Run 的额度。

compiled model surface 确定 messages、tools 和请求设置，以 digest 绑定 invocation。模型状态、Provider route 与当前 Run identity 一致；运行中修改期望配置只影响后续准入，不能让已发请求换成另一模型。
主 Agent 的 reasoning effort 由 Provider 类型编译为 provider-owned options，并进入同一冻结 surface 与 digest；显式关闭 reasoning 时不发送该选项。

## 调用与证据

Gateway 组织 model invocation identity、resource preparation、attempt 与 response record。Host 完成所需 acknowledgement 后才调用 Provider；attempt 结果、私有证据与 terminal facts 按原 identity 关联。`durationOnlyChildRun` 与 `unboundedCumulativeUsage` 的模型请求在未显式指定单次硬超时时，以各自 Run 的持久截止时间和取消信号管理临时 Provider 错误重试；旧的默认 5 次／60 秒尝试额度不截断这些 Run。无 Provider 或配置给出的输出 token 上限时，也不注入过去任意的本地 4096 token 默认值；Provider 声明的输出上限仍生效。已明确指定的单次硬超时和 Provider 自身的上下文／输出能力仍生效。历史有限 Run 沿原有模型重试界限执行。

阶段 D 的 [Agent 邮箱输入](../src/model/invocation-gateway.ts)使用可选的 `prepareSurface(invocationId)`：Gateway 先分配准确 invocation ID，可信 Service 在当前执行 scope 内读取私有邮件并构造低权限帧，然后以包含邮件的冻结 Surface 计算模型预算。QueueOnly 邮件的 `persistAdmission` 在同一 Host/Store 事务内提交模型准备、预算准入和 `agent.mail_input_prepared` 水位；`followup_task` 的 `new_turn` 由新 grant 与新 Run 准入，受限 `current_turn` 则在准确旧 call_model lease 下把已准备旧 Run Surface 与路由、水位绑定，并待来源后备释放 ACK 后才派发。缺少对应持久事务端口会拒绝调用；普通无邮件调用保持原有 Surface 与持久化路径。默认独立父子 Session 的完整 Host Agent 通信 Port 已开放 `followup_task` 与 `interrupt_agent`，QueueOnly 端口仍只披露列表、等待和发送。无 checkpoint 的新 v2 续轮若 grant 签有 `priorOutcomeUnknown`，Service 在首个冻结模型 Surface 加入执行状态观察提示：旧外部调用可能已生效，须检查持久记录和外部现状；这不把旧 attempt 重新派发。

已持久准备但尚未尝试的目标模型请求可由 `resumePrepared` 使用原 invocation ID、原 Surface Artifact 与原预算 reservation 续派发。Gateway 核对准确 Turn／State revision、Surface ref／digest、prepared status／零 attempts、单次硬超时及持久 `estimatedInputTokens`，再调用目标 owner 提供的路由与来源资金 ACK 门禁；门禁确认后才提交同一 invocation 的 dispatch／attempt 事实。该入口不生成新 ID、Surface 或 prepared 事件，已有 attempt、unknown、缺失 Artifact／预算或旧格式缺少准确输入估计时失败封闭。`executeBuiltinPrimaryModelEffect` 的普通路径不改变；D3 的 route-only 与来源已释放两种 SIGKILL 窗口已验证同 ID、单次 Provider 派发。

Model Surface／Response 私有 Artifact 不再使用默认 16 MiB 单件字节上限；写入和读取仍核对 canonical 内容、ref 字节长度与摘要。Provider 自身的上下文窗口和输出能力仍分别裁决请求与响应。

模型流是累计 reasoning/text 与完成边界。partial tool call 不作为完整工具调用执行，完整响应再交给工具解析。取消、Provider 错误、surface 改变或持久化不可用分别形成明确结果，不用猜测填补缺失证据。

MCP Resource 读取和动态 MCP Tool 的有效结果在[模型 Runtime module](../src/model/runtime-module.ts)进入模型可见上下文时，不再因旧 128 KiB 字符额度被改写为 partial 摘要；完整结果仍按原身份进入执行记录，后续模型请求由真实 Provider 上下文窗口裁决。外部结果依旧是低信任数据，不能扩大工具授权。

持久 attempt acknowledgement 后、真正进入 Provider transport 前再检查一次取消信号；信号已取消就不发起 HTTP 请求。请求已经发出时，服务商仍可能继续处理并产生用量；本地取消后 Gateway 忽略迟到的文本和 reasoning 流回调，已关闭的 Runtime 事件通道不接收迟到的持久事实。

## 子 Agent 私有产物与生命周期

Builtin 的子任务请求、结果、checkpoint、continuation 与 lifecycle 私有 Artifact 不再在单件写入处施加固定字节上限；canonical JSON、owner 身份、摘要和读取完整性仍逐项校验。Provider 观察结果不再因摘要 100 万字符或私有 payload 4 MiB 固定阈值返回容量失败，但结构及 JSON 有效性仍须成立。子任务待注册记录、Provider 清理墓碑和已消费 grant 的内存表不再分别以 256／1024／4096 个固定数量提前拒绝；过期时间、grant 防重放和执行权核验仍生效。物理存储及 Provider 自身的能力边界独立于这些 Runtime 人为额度。

## 压缩

context compaction 通过独立的预算、预检、摘要和验证机制生成后续输入；手动/自动入口和开关分开。reset 先检查完整上下文是否安全，再清 active checkpoint，不删除历史。实现见[manual compaction](../src/model/context-compaction-manual.ts)及 Service 的[compaction service](../../../apps/kite-service/src/runtime/session/context-compaction-service.ts)。

[摘要生成](../src/model/compaction-summary.ts)保留完整的用户压缩说明与待压缩历史；旧 `maxSummaryTokens`、`maxSummaryInputTokens`、`maxNarrativeTokens` 配置仍可解析，但不再限制新摘要。只有真实 Provider 输出能力、单次请求输出设置和已知上下文窗口限制请求；未知输出能力时不注入任意 6000 token 上限。有效 checkpoint 只需真实减少上下文，且摘要非空、未被 Provider 截断、source digest 和安全边界正确；不要求至少减少 1024 token。[自动决策](../src/model/context-compaction-decision.ts)不再因固定次数、cooldown 或连续低收益永久禁用压缩。自动压缩失败时保留原上下文并继续正常模型调用；同一 source digest 的失败不立即重复请求，新增上下文或明确手动请求可再次尝试。历史无 digest 的失败按当前 turn 防止即时重试。验证见 [Builtin 压缩测试](../test/context-compaction-effect.test.ts)、[Service 自动压缩测试](../../../apps/kite-service/test/runtime/context-compaction-auto.test.ts)与 [跨层恢复测试](../../../apps/kite-service/test/runtime/context-compaction-e2e.test.ts)。

验证入口：[模型测试](../test/)、[Host context compilation](../../runtime-host/test/context-compilation.test.ts)。更精确的 Provider 和证据规则见[模型边界](../../../docs/active/model-provider-boundary.md)、[私有 Artifact](../../../docs/active/private-artifact-storage.md)。

[token counter](../src/model/token-counter.ts)保留同步 cl100k_base 计数语义，但通过可被 standalone bundler 收录的 literal require 在首次计数时加载词表；应用只浏览目录时不支付模型词表初始化成本，不引入另一份计数缓存或近似算法。
