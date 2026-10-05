# 检查一次模型调用的上下文

通用 Agent V1.3 的[新开发入口](../../../../../apps/web/README.md)通过 **Model calls** 按固定上界读完所选会话的调用目录，再选择准确 Execution。确认读取敏感内容后，界面显示该次持久请求的 System、Messages、Tools、原尝试与来源，以及实际 adapter/provider family、支持的 Request settings、能力版本与最后派发策略。大正文完整核对 EOF、字节数和 SHA 后才显示。opaque adapter、未记录或未来格式的字段明确显示 unavailable，不用现在的配置补造历史。`succeeded` 表示有成功回执，其他状态显示请求已准备、Provider 接收未确认。Current selected context 仍只表示当前选中的消息与结果来源。

新入口的 Runtime logs 导航和完整正式客户端迁移仍按[实施进度](../../../../plans/unified-agent-refactor-v1-progress.md)记录。以下从 logs 进入的操作仍是正式产品承诺。

在所选会话的 Runtime logs 中展开可用的 `model.invocation_prepared`，打开 Model Context Inspector。检查目标绑定到这一次调用，不是当前全局模型设置的估算。

可用分区包括 Overview、System prompt、Messages、Tools 和 Request settings。它帮助解释“这次模型看到了什么”，不能证明模型一定正确理解或遵守这些内容。
内容较多时检查器会继续读取后续片段，再显示完整结果；System prompt、消息正文、工具描述和Schema不会因为累计大小或超过200项而静默截断。关闭检查器或切换会话会取消当前读取。

## 范围与敏感性

这是敏感的本机诊断内容。界面不展示凭据、Provider endpoint、内部 Artifact 标识或 Provider 原始响应。关闭后不将正文缓存为持久浏览器状态。

上下文与对话页面不同：上下文可能包含系统指导、工具声明和压缩结果，不能简单按屏幕消息拼接推断。当前调用没有可取得的内容时，按不可用结果处理，不从另一调用补数据。

切换会话、关闭检查器或请求失败时，不应显示旧调用的内容冒充新目标。分享截图前检查项目文本，不仅检查是否有 API key。
