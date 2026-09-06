# 检查一次模型调用的上下文

在所选会话的 Runtime logs 中展开可用的 `model.invocation_prepared`，打开 Model Context Inspector。检查目标绑定到这一次调用，不是当前全局模型设置的估算。

可用分区包括 Overview、System prompt、Messages、Tools 和 Request settings。它帮助解释“这次模型看到了什么”，不能证明模型一定正确理解或遵守这些内容。

## 范围与敏感性

这是敏感的本机诊断内容。界面不展示凭据、Provider endpoint、内部 Artifact 标识或 Provider 原始响应。关闭后不将正文缓存为持久浏览器状态。

上下文与对话页面不同：上下文可能包含系统指导、工具声明和压缩结果，不能简单按屏幕消息拼接推断。当前调用没有可取得的内容时，按不可用结果处理，不从另一调用补数据。

切换会话、关闭检查器或请求失败时，不应显示旧调用的内容冒充新目标。分享截图前检查项目文本，不仅检查是否有 API key。
