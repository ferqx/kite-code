# 模型边界

`@kite-ai/ai` 负责可移植的模型请求、流事件、用量和取消类型，不负责 Session、Run、执行权限、持久化或 HTTP。导入这个包不打开资源。完整模型响应是否可以派发工具由 Agent Loop 决定；不完整响应不能作为执行授权。

`createFixedModel` 保存请求副本并消费显式响应序列，不发起网络调用、不重试，也不隐式生成 finish 事件。这个本地适配器用于确定性测试。

可选入口 `@kite-ai/ai/sdk` 通过 `createSdkModelAdapter` 绑定显式 SDK LanguageModels。每次流请求只有一次 Provider 尝试，使用 `maxRetries: 0` 和 `stepCountIs(1)`。工具声明不带执行回调；完整调用在 finish 后交给 Agent Loop 授权。消息正文、assistant 工具调用与配对工具结果映射到 SDK 消息。来源 ID、请求 ID 和定义版本仍作为宿主出处保留在原中立请求中；凭据与 Provider 绑定配置不会成为 ModelRequest 字段或流事件。

`createCompatibleModelBinding` 是接受显式 endpoint、模型和私有凭据的宿主工厂，直到流请求开始才建立连接。兼容用量转换保留缺失测量：未知输入/输出 token 数为 `null`，缺失的可选缓存/推理计数不输出。遇到过滤或未知终态原因、不完整调用、传输错误或缺少 Provider finish 的流时，适配器明确失败；不伪造 stop、不重试，也不执行工具。它抑制 SDK 错误日志，只返回公开错误码，不携带可能包含敏感请求详情的 Provider 原因。真实 AbortSignal 传递到 HTTP 传输。

这个公开工厂名称中的 `Compatible` 表示 OpenAI-compatible 外部协议。[架构命名检查](../../scripts/pre-release-architecture-policy.ts)只按该源码路径与完整符号分类；其他路径的同名实体、历史兼容名和版本化实体仍遵循原门禁。

测试使用带测试凭据的本地模拟 HTTP endpoint，证明传输映射与每次流尝试只发一个网络请求；不建立生产 Provider 兼容性、可用性或付费模型行为资格。

验证：`bun test packages/ai/test/` 和 `bun run --cwd packages/ai typecheck`。

`createSdkModelAdapter` 可选接受按模型划分的 `presets` 映射，字段包括 `temperature`、`topP`、`maxOutputTokens` 和有限的 `reasoningEffort`。绑定时校验、复制并冻结条目；支持的数值传递给那一次实际 SDK Provider 请求。不支持的字段和非法数值在任何尝试前拒绝。这个仅供宿主使用的绑定使中立 ModelRequest 不包含凭据或可变配置，同时保留 Tool 描述。默认 Service 装配为每个新 Run 选择新绑定，并在生效快照中记录同样的受支持非秘密选项。


`ModelAdapter.describeRequest` 是可选同步纯描述端口，只返回实际绑定的非秘密 Adapter、Provider family/model、请求 settings 和转换版本；不进行 I/O，也不引入 Agent 类型。SDK Adapter 使用冻结的实际 presets，记录单次请求的 `maxRetries:0`、`maxSteps:1` 和消息转换设置。只有 `createCompatibleModelBinding` 真实构建的模型提供已知 Provider family/model；任意外部 SDK 对象或不透明 Adapter 明确不可用，不猜对象属性或以当前配置补齐历史。不记录 endpoint、凭据、header、credentialRef 或宿主路径。[纯描述与真实 SDK 请求测试](test/request-snapshot.test.ts)用注入的本地传输核对设置一致、零描述请求和 caller 修改不影响绑定。

推理强度使用中立有限值 `none/minimal/low/medium/high/xhigh/max`。只有本厂构建的兼容模型绑定接受这项 preset；不透明 SDK Model 在任何 I/O 前返回 `model_reasoning_effort_unsupported`。SDK 通过 `providerOptions.openaiCompatible.reasoningEffort` 传为实际 `reasoning_effort`，纯描述和原 Execution settings 保存相同冻结值；未配置时不发送该字段。这些值表示适配器的编码范围，不是远端模型发现或支持保证，远端拒绝按实际单次请求失败处理，不切换模型、不重试。

[SDK 请求](test/sdk.test.ts)逐值核对真实本机 HTTP、绑定后 caller 改值不影响请求、未知值/不透明绑定拒绝；[配套 Service](../../apps/service/test/isolated/configuration.test.ts)核对活动旧 Run 与后续新 Run 的实际 low/high 请求和公开历史 ModelInput。2026-10-02 与 Core metadata/Native-Browser inspector 组合29项、239断言通过；不证明生产 Provider 或设置面板资格。
