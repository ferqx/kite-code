# 模型边界

构建使用 Bun splitting 内联[明确声明的 SDK 普通 JS 依赖](bundled-dependencies.ts)，中立入口与 SDK 入口仍独立导出。Terminal 打包扫描全部生成模块，拒绝声明已内联的残余 bare import，并保存安装声明图的原 package manifest 摘要与许可全文；不改变实际 Provider 尝试、取消或用量合同。跨包打包取舍归[Windows 闭包成本决定](../../.agents/notes/implemented/bug-fix/2026-10-17-windows-bundle-admission-cost.md)。

`@kite-ai/ai` 负责可移植的模型请求、流事件、用量和取消类型，不负责 Session、Run、执行权限、持久化或 HTTP。导入这个包不打开资源。完整模型响应是否可以派发工具由 Agent Loop 决定；不完整响应不能作为执行授权。

`createFixedModel` 保存请求副本并消费显式响应序列，不发起网络调用、不重试，也不隐式生成 finish 事件。这个本地适配器用于确定性测试。

可选入口 `@kite-ai/ai/sdk` 通过 `createSdkModelAdapter` 绑定显式 SDK LanguageModels。每次流请求只有一次 Provider 尝试，使用 `maxRetries: 0` 和 `stepCountIs(1)`。工具声明不带执行回调；完整调用在 finish 后交给 Agent Loop 授权。消息正文、assistant 工具调用与配对工具结果映射到 SDK 消息。来源 ID、请求 ID 和定义版本仍作为宿主出处保留在原中立请求中；凭据与 Provider 绑定配置不会成为 ModelRequest 字段或流事件。

`createCompatibleModelBinding` 是接受显式 endpoint、模型和私有凭据的宿主工厂，直到流请求开始才建立连接。兼容用量转换保留缺失测量：未知输入/输出 token 数为 `null`，缺失的可选计数不输出。遇到过滤或未知终态原因、不完整调用、传输错误或缺少 Provider finish 的流时，适配器明确失败；不伪造 stop、不重试，也不执行工具。它抑制 SDK 错误日志，只返回公开错误码，不携带可能包含敏感请求详情的 Provider 原因。真实 AbortSignal 传递到 HTTP 传输。

[用量转换](src/usage.ts)接收非负安全整数，缓存优先取 `prompt_tokens_details.cached_tokens`，缺失时兼容 `prompt_cache_hit_tokens`；明确的 0 不被别名覆盖。`totalTokens` 保留服务端 `total_tokens`，不取 SDK 重新求和的替代值；完整原 `usage` 存于 `raw`，包含缓存写入、cache miss、多模态等额外字段。SDK raw chunk 仅提取这一叶子，避免 SDK 的嵌套 schema 丢字段；请求、headers、凭据和其他响应字段不进入该统计。任意外部 SDK Model 只沿 SDK 明确提供的 normalized usage／raw，不猜其协议。

中立 `usage` 事件是单次请求的最新统计快照，与 `finish` 独立。Agent 可在失败／取消时保留已经收到的快照；重复快照不累计为多次请求，工具仍须完整合法 `finish` 才能进入原授权流程。未收到的最终统计无法补造，也不承诺账单完整性。[SDK 本机 HTTP](test/sdk.test.ts)、[数值反例](test/usage.test.ts)及[真实 SQLite／冷读取](../agent/test/isolated/execution/model-usage.test.ts)分别核末尾空 choices、原始明细／总数、旧别名、未知与 0、取消／失败后的已收用量及零额外派发。持久取舍见[用量记录决定](../../.agents/notes/implemented/bug-fix/2026-10-16-provider-token-accounting.md)。

这个公开工厂名称中的 `Compatible` 表示 OpenAI-compatible 外部协议。[架构命名检查](../../scripts/pre-release-architecture-policy.ts)只按该源码路径与完整符号分类；其他路径的同名实体、历史兼容名和版本化实体仍遵循原门禁。

测试使用带测试凭据的本地模拟 HTTP endpoint，证明传输映射与每次流尝试只发一个网络请求；不建立生产 Provider 兼容性、可用性或付费模型行为资格。

SDK 的 `kite.sdk.messages` 转换版本为2：内部 `files.read` 等 Tool ID 在发送前转为最多64字符的 ASCII 函数名，只含字母、数字、下划线与连字符。合法原名保持；其他名称替换非法字符并在截短后分配不碰撞的后缀，先保留当前声明及完整历史中的合法名称。声明、assistant 历史调用与配对结果使用同一请求内映射，完成的 Provider 调用还原原 ID 后才交给 Core；不改写原请求、ModelInput 或持久历史。转换由 [sdk.ts](src/sdk.ts)负责，不依赖模型名称推测能力。范围及不重命名 Core ID 的取舍见[工具名决定](../../.agents/notes/implemented/bug-fix/2026-10-16-compatible-tool-names.md)。

[SDK 严格端点测试](test/sdk.test.ts)拒绝非法声明及历史函数名，核带点、中文、超长、名称碰撞、原 ID 回传与输入不变；[普通 paired 宿主测试](../../apps/service/test/isolated/configuration.test.ts)使用真实八个默认工具，严格校验请求名称、执行真实文件读取，再带原工具历史完成第二次请求。修复前两项均实际复现失败；原先宽松模拟端点允许带点名称，不能证明真实 Provider 请求合同成立。

2026-10-16 在 Windows x64／Bun 1.4.2 的本次修复工作树，经用户明确授权向 DeepSeek 官方 deepseek-v4-flash 发送两次对照，均仅“你好”及原失败请求中的八个工具定义，不含原系统／项目上下文或 reasoning_effort。两份实际请求只有函数名不同：六个旧名称不合语法时返回400／invalid_request_error，转换后返回200且完整流结束；不执行工具，不改用户配置。该有限实测确认工具名缺陷和修复效果，不证明真实文件工具执行、其他模型或全部 Provider 兼容性；详细计数和证据限制见上述决定。

[ModelAttemptError](src/model-attempt.ts)仅归一化已知传输中断、SDK 明确标记可重试的 HTTP 故障（含 408／429／5xx）和流不完整的有限公开原因；不按远端正文猜失败或重试资格。SDK 每次仍是零内部重试；Agent 在真实原 Execution 已失败、关闭及来源资格保持时决定下一尝试，不设本地次数上限，记录新的执行与实际前驱。部分工具调用不派发，取消、未知结果及无法证明关闭的尝试不成为自动重试边界。Provider 的 `length` 原样交付 Core，由 Core 区分纯文本续接、截断工具批次和不可发布的截断摘要；AI 包不自行续轮。

验证：`bun test packages/ai/test/` 和 `bun run --cwd packages/ai typecheck`。

`createSdkModelAdapter` 可选接受按模型划分的 `presets` 映射，字段包括 `temperature`、`topP`、`maxOutputTokens` 和有限的 `reasoningEffort`。绑定时校验、复制并冻结条目；支持的数值传递给那一次实际 SDK Provider 请求。不支持的字段和非法数值在任何尝试前拒绝。这个仅供宿主使用的绑定使中立 ModelRequest 不包含凭据或可变配置，同时保留 Tool 描述。默认 Service 装配为每个新 Run 选择新绑定，并在生效快照中记录同样的受支持非秘密选项。


`ModelAdapter.describeRequest` 是可选同步纯描述端口，只返回实际绑定的非秘密 Adapter、Provider family/model、请求 settings 和转换版本；不进行 I/O，也不引入 Agent 类型。SDK Adapter 使用冻结的实际 presets，记录单次请求的 `maxRetries:0`、`maxSteps:1` 和消息转换设置。只有 `createCompatibleModelBinding` 真实构建的模型提供已知 Provider family/model；任意外部 SDK 对象或不透明 Adapter 明确不可用，不猜对象属性或以当前配置补齐历史。不记录 endpoint、凭据、header、credentialRef 或宿主路径。[纯描述与真实 SDK 请求测试](test/request-snapshot.test.ts)用注入的本地传输核对设置一致、零描述请求和 caller 修改不影响绑定。

推理强度的 `reasoningEffortLevels` 为 `low/medium/high/xhigh/max/ultar` 六档；完整 `reasoningEfforts` 另保留 none/minimal，供已有配置、历史与显式 API 请求使用。Ultar/ultar 是用户明确指定的名称和值，不自动改写为 ultra 或 max。只有本厂构建的兼容模型绑定接受这项 preset；不透明 SDK Model 在任何 I/O 前返回 `model_reasoning_effort_unsupported`。SDK 通过 `providerOptions.openaiCompatible.reasoningEffort` 传为实际 `reasoning_effort`，纯描述和原 Execution settings 保存相同冻结值；未配置时不发送该字段。这些值表示适配器的编码范围，不是远端模型发现或支持保证，远端拒绝按实际单次请求失败处理，不切换模型、不去参数重发。

[SDK 请求](test/sdk.test.ts)逐值核对真实本机 HTTP、绑定后 caller 改值不影响请求、未知值/不透明绑定拒绝；[配套 Service](../../apps/service/test/isolated/configuration.test.ts)核对活动旧 Run 与后续新 Run 的实际 low/high 请求和公开历史 ModelInput。2026-10-02 与 Core metadata/Native-Browser inspector 组合29项、239断言通过；不证明生产 Provider 或设置面板资格。


默认宿主显式传入 `provider` 时，绑定的公开 family 为 `openai`、`deepseek`、`ollama` 或兼容默认 `openai-compatible`，与实际 endpoint/model 同时冻结；不会从模型名称猜 family。四类仍走同一明确单次 SDK compatible transport，凭据和 endpoint 不进入公开 metadata。Service 的[真实 HTTP 四路请求](../../apps/service/test/isolated/run-model-selection.test.ts)与 [Native 原 ModelInput/wire 验收](../../apps/desktop/test/isolated/native-provider-bundle.test.ts)核对绑定、临时 effort 和 child preset；不据此宣称生产 Provider 全部语义兼容。
