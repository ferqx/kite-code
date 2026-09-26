# 模型输入、上下文与响应

入口：[context](../src/model/context.ts)、[projection](../src/model/context-projection.ts)、[surface compiler](../src/model/surface-compiler.ts)、[invocation gateway](../src/model/invocation-gateway.ts)、[response source](../src/model/response-source.ts)。

## 构造请求

Service 在运行准入时解析模型配置，Builtin 从 State view、项目指令、历史/压缩点、工具声明和当前阶段构造上下文。上下文预算与屏幕消息长度不同；不能从 TUI viewport 重建请求。

compiled model surface 确定 messages、tools 和请求设置，以 digest 绑定 invocation。模型状态、Provider route 与当前 Run identity 一致；运行中修改期望配置只影响后续准入，不能让已发请求换成另一模型。
主 Agent 的 reasoning effort 由 Provider 类型编译为 provider-owned options，并进入同一冻结 surface 与 digest；显式关闭 reasoning 时不发送该选项。

## 调用与证据

Gateway 组织 model invocation identity、resource preparation、attempt 与 response record。Host 完成所需 acknowledgement 后才调用 Provider；attempt 结果、私有证据与 terminal facts 按原 identity 关联。具体超时和重试参数以 gateway 当前代码为准，不从历史文档恢复旧的 per-attempt 定时机制。

阶段 D 的 [Agent 邮箱输入](../src/model/invocation-gateway.ts)使用可选的 `prepareSurface(invocationId)`：Gateway 先分配准确 invocation ID，可信 Service 在当前执行 scope 内读取私有邮件并构造低权限帧，然后以包含邮件的冻结 Surface 计算模型预算。QueueOnly 邮件的 `persistAdmission` 在同一 Host/Store 事务内提交模型准备、预算准入和 `agent.mail_input_prepared` 水位；`followup_task` 的 `new_turn` 由新 grant 与新 Run 准入，受限 `current_turn` 则在准确旧 call_model lease 下把已准备旧 Run Surface 与路由、水位绑定，并待来源后备释放 ACK 后才派发。缺少对应持久事务端口会拒绝调用；普通无邮件调用保持原有 Surface 与持久化路径。默认独立父子 Session 的完整 Host Agent 通信 Port 已开放 `followup_task` 与 `interrupt_agent`，QueueOnly 端口仍只披露列表、等待和发送。

已持久准备但尚未尝试的目标模型请求可由 `resumePrepared` 使用原 invocation ID、原 Surface Artifact 与原预算 reservation 续派发。Gateway 核对准确 Turn／State revision、Surface ref／digest、prepared status／零 attempts、单次硬超时及持久 `estimatedInputTokens`，再调用目标 owner 提供的路由与来源资金 ACK 门禁；门禁确认后才提交同一 invocation 的 dispatch／attempt 事实。该入口不生成新 ID、Surface 或 prepared 事件，已有 attempt、unknown、缺失 Artifact／预算或旧格式缺少准确输入估计时失败封闭。`executeBuiltinPrimaryModelEffect` 的普通路径不改变；D3 的 route-only 与来源已释放两种 SIGKILL 窗口已验证同 ID、单次 Provider 派发。

模型流是累计 reasoning/text 与完成边界。partial tool call 不作为完整工具调用执行，完整响应再交给工具解析。取消、Provider 错误、surface 改变或持久化不可用分别形成明确结果，不用猜测填补缺失证据。

## 压缩

context compaction 通过独立的预算、预检、摘要和验证机制生成后续输入；手动/自动入口和开关分开。reset 先检查完整上下文是否安全，再清 active checkpoint，不删除历史。实现见[manual compaction](../src/model/context-compaction-manual.ts)及 Service 的[compaction service](../../../apps/kite-service/src/runtime/session/context-compaction-service.ts)。

验证入口：[模型测试](../test/)、[Host context compilation](../../runtime-host/test/context-compilation.test.ts)。更精确的 Provider 和证据规则见[模型边界](../../../docs/active/model-provider-boundary.md)、[私有 Artifact](../../../docs/active/private-artifact-storage.md)。

[token counter](../src/model/token-counter.ts)保留同步 cl100k_base 计数语义，但通过可被 standalone bundler 收录的 literal require 在首次计数时加载词表；应用只浏览目录时不支付模型词表初始化成本，不引入另一份计数缓存或近似算法。
