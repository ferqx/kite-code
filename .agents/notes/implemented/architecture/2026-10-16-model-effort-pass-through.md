# Agent Note: 思考程度作为所有模型的请求参数

Status: implemented

## Problem

桌面为 DeepSeek 显示“当前模型不支持思考程度调节”，Service 又按 Provider family 与旧 `reasoningSupported:false` 拒绝合法 effort。四类生产绑定实际都使用可编码该参数的 compatible transport。用户明确要求任何模型都能调整，Kite 只负责传递参数，支持与否由模型服务处理。

## Decision

所有配置可用的模型统一提供「轻度、中、高、极高、Max、Ultar」六档，请求值依次为 `low/medium/high/xhigh/max/ultar`。用户明确保留 Ultar 拼写并发送 ultar，不纠正为 ultra、不降档为 max。Service 移除 family 和能力标记门禁；用户源的 provider effort 不再因 `reasoning:false` 被丢弃。桌面共享浮层按选中路由与变更回调提供调节，不再接收模型能力开关，并按用户要求移除配置默认/关闭思考按钮；TUI 消费同一六档目录。

合法值随原 start/follow-up 冻结到本次配置快照、ModelInput 与实际 `reasoning_effort`。未临时选择时沿用配置，模型切换时清临时值；活动 Run 与 child 的独立 preset 继续遵守[原下一次模型选择决定](2026-10-06-native-provider-intents-and-next-run-selection.md)。none/minimal 留在完整请求/配置枚举和支持 effort 的离线格式中，保留既有记录；原本不允许 effort 字段的历史格式不放宽。非法值、配置不完整、可信宿主覆盖及原读取集 CAS 的门禁保持。远端可接受、忽略或拒绝；拒绝如实失败，不因不支持而切换模型或去参数重发。

## Provider evidence

2026-10-16 核对官方文档：[OpenAI](https://developers.openai.com/api/docs/guides/reasoning)列出的词汇包括 none/minimal/low/medium/high/xhigh/max，具体模型子集不同；[DeepSeek](https://api-docs.deepseek.com/guides/thinking_mode/)声明 low/high/max 并在服务端处理兼容别名；[阿里云 Qwen Chat](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions)声明 qwen3.8 的 low/medium/xhigh 及其他值的服务端映射；[Ollama](https://docs.ollama.com/api/openai-compatibility)按模型元数据与兼容别名处理。文档中的 ultra 与本任务指定的 ultar 不同；Kite 的六档是统一请求选择，不宣称所有服务商原生提供同样六种推理行为。

## Alternatives considered

- 只打开桌面滑块：Service 仍会拒绝 DeepSeek/Ollama，且 TUI 与保存配置的路径继续不一致，因此同时移除服务端门禁。
- 扩充静态支持表或按模型名判断：自定义 endpoint 与后续模型无法由名称保证能力，仍会阻止用户显式参数，因此不做能力推断。
- 远端拒绝后去参数重试：会改变用户原意图与实际请求，无法区分服务拒绝和正常采纳，因此保留该次真实失败。
- 将 Ultar 纠正为 ultra 或映射到服务商最高原生档：用户明确选择保留名称和值，因此只忠实传递，接受情况由服务端处理。

## Consequences

Kite 的目录只说明适配器能发送这些参数，不承诺模型服务的实际思考行为。AI 层仍需要明确绑定的 transport，任意不透明 SDK 对象不会自动获得可编码或公开 Provider 身份；这不构成生产模型的能力过滤。

[实际 HTTP 测试](../../../../apps/service/test/isolated/run-model-selection.test.ts)核四 family 的配置值/临时 max/ultar/none、旧能力声明、原 ModelInput 与远端400一次失败；[Provider 设置](../../../../apps/service/test/isolated/provider-settings.test.ts)核四 family 的 ultar 保存，[用户源](../../../../apps/service/test/isolated/user-configuration.test.ts)核旧 reasoning:false 不丢 effort。[桌面 DOM](../../../../apps/desktop/test/isolated/native-model-picker-dom.test.tsx)与[共享浮层](../../../../packages/ui/test/isolated/model-effort.test.tsx)核无能力声明的选择、DeepSeek 滑块及原作用域边界；[SQLite caller 测试](../../../../packages/agent/test/isolated/maintenance/caller-effort.test.ts)核六档与旧值原字节及历史 grammar，完整 Node DB6 测试的本次 Windows 夹具限制归[维护 owner](../../../../packages/agent/src/maintenance/README.md#desktop-db6-与-manifest-v14)。当前产品定义归[模型与配置](../../../../docs/handbook/features/models-and-configuration.md)，实际参数装配归[Service owner](../../../../apps/service/README.md#native-provider-与下一次模型绑定)。这些验证不授予生产远端模型的参数效果或跨平台发行资格。
