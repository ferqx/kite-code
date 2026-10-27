# 模型、工具与后续工作

Service 明确注入模型与工具，Agent 从已核验的原历史、上下文选择、来源与冻结配置构造请求。AI adapter 负责中立消息/流与 SDK 传输，唯一 Loop 消费完整保存的模型结果。

实现与局部验证：[模型上下文](../../../packages/agent/src/model-context.ts)、[AI](../../../packages/ai/README.md)、[模型正文](../../../packages/agent/src/model-body/README.md)、[工具表面](../../../packages/agent/src/model-tools.README.md)。

工具参数只有在完整模型响应保存后才能派发；工具声明、权限检查、最终派发与结果结算各自核准确身份。部分流、取消和未知效果不提交成可重放成功；完整输出及私有 continuation 沿原 Artifact 边界保存，预览不是全文。

共同约束以[当前八 workspace 边界](../../active/unified-agent-boundary.md)及对应 owner 为准。定向测试、真实客户端过程和平台资格分别说明，不从源码存在或最终截图推定完整行为通过。

旧 Host/Kernel/SPI 实现的[历史说明](https://github.com/ferqx/kite-code/blob/d5407cfe4319c5a84d530f63b1d0a0123218ad34/docs/development/flows/model-tool-cycle.md)只供删除前设计与证据追溯，不能恢复为当前 owner 或运行入口。
