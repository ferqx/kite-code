# 模型输入、上下文与响应

入口：[context](../src/model/context.ts)、[projection](../src/model/context-projection.ts)、[surface compiler](../src/model/surface-compiler.ts)、[invocation gateway](../src/model/invocation-gateway.ts)、[response source](../src/model/response-source.ts)。

## 构造请求

Service 在运行准入时解析模型配置，Builtin 从 State view、项目指令、历史/压缩点、工具声明和当前阶段构造上下文。上下文预算与屏幕消息长度不同；不能从 TUI viewport 重建请求。

compiled model surface 确定 messages、tools 和请求设置，以 digest 绑定 invocation。模型状态、Provider route 与当前 Run identity 一致；运行中修改期望配置只影响后续准入，不能让已发请求换成另一模型。

## 调用与证据

Gateway 组织 model invocation identity、resource preparation、attempt 与 response record。Host 完成所需 acknowledgement 后才调用 Provider；attempt 结果、私有证据与 terminal facts 按原 identity 关联。具体超时和重试参数以 gateway 当前代码为准，不从历史文档恢复旧的 per-attempt 定时机制。

模型流是累计 reasoning/text 与完成边界。partial tool call 不作为完整工具调用执行，完整响应再交给工具解析。取消、Provider 错误、surface 改变或持久化不可用分别形成明确结果，不用猜测填补缺失证据。

## 压缩

context compaction 通过独立的预算、预检、摘要和验证机制生成后续输入；手动/自动入口和开关分开。reset 先检查完整上下文是否安全，再清 active checkpoint，不删除历史。实现见[manual compaction](../src/model/context-compaction-manual.ts)及 Service 的[compaction service](../../../apps/kite-service/src/runtime/session/context-compaction-service.ts)。

验证入口：[模型测试](../test/)、[Host context compilation](../../runtime-host/test/context-compilation.test.ts)。更精确的 Provider 和证据规则见[模型边界](../../../docs/active/model-provider-boundary.md)、[私有 Artifact](../../../docs/active/private-artifact-storage.md)。
