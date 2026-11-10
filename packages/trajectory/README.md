# Trajectory

`@kite-ai/trajectory` 负责共享 V1 执行事实协议、运行时校验与 JSON Schema、原始身份、Decimal64 顺序和确定性的 as-of 投影。它不依赖 Agent、Store、Provider、React、Electron、文件系统或网络。运行时校验使用 Zod；workspace 的 `build` 保留外部依赖，由发行闭包复制声明的依赖与 notices。它是明确选中的 workspace，不恢复旧 Kernel／Host 包。

产品范围见[会话手册](../../docs/handbook/features/sessions.md#执行轨迹与只读重放)，持久取舍见[事实与消费者决定](../../.agents/notes/implemented/architecture/2026-11-08-trajectory-facts-and-trace-consumers.md)。本包提供纯协议、确定性 Projector 和离线 manifest；本包测试不代替实际 Reader／Evidence、Desktop、隔离、可靠投递或 OTel 的产品资格。

## 事实与身份

一个持久来源 cursor 至多对应一个规范 `TrajectoryEvent`。`kind` 选择闭合 attributes，不接受任意 payload、完整模型／工具正文、自由错误或私有材料 binding；第一方明确允许下述有界公开消息摘录。`recordedStatus` 保留原状态，`phase` 是展示分类；派发、等待、取消中和结果未知都不等于完成。无 Run 的观察不补造 Run，也不补造开始／结束。

`message` 事实保留原 messageId、user／assistant 角色、消息序号、观察修订和 complete／incomplete 状态；可核实的 `messageOriginStoreId` 与当前提交出处分别保留。Projector 按原出处／Session／messageId 聚合同一消息的流式版本，并保留全部来源事件。完整消息正文使用独立 `message` Evidence；第一方事件另可有不超过 160 字符的公开 `display.summary` 摘录，不开放 reasoning、附件编码或私有检查点。原 Model 的执行生命周期和模型材料保持独立。后续消息版本没有唯一 Model 关联时不会继承旧父链；缺少新版本摘录时也不借用旧版本文本。此前未封存消息身份的旧事实不派生新消息；事实格式、API及Projector版本保持原值。

`trajectoryIdentityPayload` 返回带固定域的 canonical JSON；`createTrajectoryEventId` 使用 WebCrypto 对同一 UTF-8 内容计算 SHA-256。同步写入 owner 可用其运行时的 SHA-256 计算相同 payload。事件身份由已封存的原 Store／cursor 决定，不随当前读 Store 或 Projector 版本变化。无法证明原来源的旧记录使用独立 legacy-local 域及 `identityConfidence=legacy_local`，不能据此跨副本去重。`canonicalSerialize` 排序对象键、保留数组顺序，并拒绝 JSON 会省略或改变的值。

原 Execution、Run、Operation 及父 Execution 的来源可由对应 `*OriginStoreId` 独立封存；Model 重试前驱另有 `previousExecutionOriginStoreId`。它们与本条事件的 `origin.storeId` 不必相同，缺少原来源时不能按当前读 Store 或事件来源猜测。Model 原 `retryReason`、`retryAttempt`、`maxAttempts` 与 `resultRevision` 保留各自来源语义，不以当前 Execution attempt 或事件 cursor 代替。

Decimal64 是不超过 `9223372036854775807` 的规范非负十进制字符串；运行时与生成的 JSON Schema 使用相同精确范围。不得转换为 JavaScript Number 或按字典序排序，使用 `parseDecimal64`、`compareDecimal64` 比较。

未知来源类型使用明确的 `unknown` 事件。`decodeTrajectoryEvent` 对未知 major version 只返回安全身份 envelope，排除未知 attributes／Evidence 并拒绝语义投影；损坏记录返回 `corrupt_fact`，不合成成功事实。

## 读取与材料

`TrajectorySnapshot` 只描述准确来源、scope、filter、固定 upper、格式与历史覆盖。`TrajectoryReadRequest`／`TrajectoryPage` 定义无状态且每页独立授权的读取。`verifyTrajectoryPage` 核对范围、顺序和扫描推进；筛选后为空的页仍可前进。全 Store 顺序稀疏是正常过滤结果。`exhausted` 只说明扫描到 upper，不证明历史完整或执行完成；通知 replay floor 不进入历史读取协议。

公共 Evidence ref 是 opaque 且带准确版本，并区分 available／partial／truncated／missing／unavailable／redacted／empty。私有 owner binding 决定原历史材料。只有分片 Evidence 读取持有 lease；open、read、close 使用同源 DTO，descriptor／chunk 绑定授权 epoch、policy revision、转换后视图长度及 digest，不公开源 hash 或私有路径。本协议包不读取材料，也不授予访问权。

`tool_input` 只描述原 Tool 已公开的执行请求 JSON，实际值由原请求事务封存和 typed reader 返回，不进入事件 attributes；Model 请求、Job 程序和恢复清单不能借此公开。`tool_result` 可包含按原定义／版本验证的闭合 `ToolResultPresentation`，覆盖 Files、Shell、网页／浏览器、协作、计划、Git、技能、MCP 与正式媒体的有限只读展示；未验证类型使用公开文本／JSON 回退，不透传任意 `details`、执行句柄或 transport。闭合材料定义见[presentation](src/presentation.ts)。

本轮保持事件、Evidence 接口、Projector 与 bundle 的原版本号。现读端继续接纳缺少新增可选字段的旧 V1 事实，旧事件未封存的参数保持缺失；新增材料种类不表示所有旧闭合 schema 读端自动理解。Trace manifest／grant 仍逐项声明种类，既有授权数组不会因 `tool_input` 新成员扩大，重新授权与 epoch 由独立消费者 owner 核验。未知 major 的 canonical 事件只提供安全 envelope，未知 V1 字段／材料种类按闭合校验拒绝，不解释未知正文。

## 投影与投递

`TrajectoryProjector` 按顺序增量处理已验证事实，不持有源日志 payload、私有 binding 或完整材料正文；`projectTrajectory` 复用同一实现，仅应用 `atCursor` 及之前的事实。Model／Tool／Job 按原 Store、Session 和真实 Execution 聚合，同名但不同来源的对象保持独立，重试仍是独立 Execution。Interaction、Verification、Context、Recovery 和 unknown 保留各自对象／事件身份，与 Execution 的关联不接管其生命周期。每步保留原 event／Evidence ID、原身份及父执行来源、定义、子会话／轮次、重试关系、attempt 和 `projectorVersion`，供 UI 在无需完整材料正文的索引上构树；这些纯索引字段不增加事件协议版本或执行权。原失败、开放／未知结果、缺前缀与 legacy 身份不被后续事实改写成成功。播放、传输、文件读取和材料获取由各自 owner 实施。

投影另保留原 `sourceEventType` 和 `identityConfidence` 标量，供 UI 区分旧格式与现行未知来源；这些名称不改变原 `unknown` kind，不补造缺失字段，事件协议及 Projector 版本保持。

Model 的可选 `compressionId/compressionTrigger`、Context 的可选 `compressionTrigger` 和 Interaction 的可选 `interactionKind` 只封存原 owner 已确认的有限分类；Projector 将其作为轻量标量保留，供默认执行树区分自动压缩、审批与普通问答。缺字段的旧事实继续合法，不从后来状态或材料猜测分类，仍可在全量模式查看。事件、Projector 和 API 版本均保持原值。

完整前缀投影另提供可选 `eventIndex`，保留当前 cursor 内完整的规范安全事件、原时间与准确 Evidence refs，供首屏元数据、分域时间轴和按需原始内容定位；只索引安全 envelope／闭合 attributes（含第一方有界公开摘录），不保存私有 binding 或完整材料正文。`completePrefix` 明确是否覆盖完整前缀；旧索引缺字段时不推算时间、材料或主调用资格。每步同时保留原 `definitionVersion`、Decimal64 `usage` 和有限 `compression` metadata，调用用量不转换为压缩前后上下文容量。`project()` 返回的事件、usage 与压缩 accounting 不与内部可变状态共享。

Model／Tool／Job 可带第一方专用的闭合 [display](src/display.ts) 元数据；Projector 按原观察位置保留到 `step.display`，返回值不共享其内部可变对象。有限字段包括原 owner 的有界标题／目标摘要、可确认的实际模型名、请求准备计数、明确操作分类及准确目标 Execution／原 Store／Session／Run，供列表在不预读 Evidence 正文时识别逻辑工作。`observedStatus` 描述被查询目标在该次回执中的状态，`accepted/terminal/cancelRequested/timedOut/exitCode` 各保原含义，不用读取工具成功推断目标完成。字段存在不改变原 Tool／Job 的身份、父关系、来源事件或材料所有权；未知定义／版本不从自由 JSON 猜分类，缺字段的旧事实不从当前业务行或后来的材料补齐。具体封存与目标核验归[Agent writer](../agent/src/trajectory/README.md)。事件、Projector、Evidence 与工具版本均保持。

Message 的 `display` 另收窄为 `kind:message`、角色标题及可选的单行公开 `summary`，摘要上限 160 字符，超长明确以省略号收尾；仅允许原 owner 已核实的当时内联 `body.content`。没有内联公开正文时不展开 checkpoint／Artifact 来补摘要。未包含材料的默认轨迹导出仍可含这些有界公开摘录，不能称为“绝无正文”；它不等于导出完整消息材料，完整正文与长内容仍由显式材料范围和原 Evidence owner 负责。

Model 与已核实 assistant Message 的第一方 `display` 可另带闭合 `outputPresence`：`hasText/toolCallCount/complete/evidenceId/contentVersion`。它只说明该事件准确公开输出是否含正文、原工具调用数量及完整性；必须绑定同一事件自己的 `model_output` 或 `message` 引用，不是正文读取完成标志。正文存在性不 trim 空白，安全非负整数计数不从有界预览推测。缺字段、缺绑定或不完整状态不等于空输出；as-of 投影不向前继承旧值，旧事实不回填。该字段不含正文、思考或私有描述符，随整个 `display` 排除于第三方 Trace；协议版本保持。

压缩 `compression` 只包含已封存采用状态、触发计数和同口径 accounting 等闭合值。`accounting` 使用 `local-context-estimate-v1` 的本次 before／after；没有同口径原值或原发布事实不能计算已采用效果，也不能用当前预测或 Provider outputTokens 补齐。UI 的全局首次出现排序、AND 组合过滤、结构祖先、分型 Tab 和准确材料目标属于[UI workbench](../ui/src/desktop/trajectory/workbench.ts)，不进入本包的 I/O 或权限边界。

`TraceEventView` 是单独授权的第三方视图，scope 和关系使用 opaque `*Ref`；原始身份只可出现在独立授予的 `originalIdentity`。Host 仍应用 metadata allowlist，并在扫描、回调、Evidence、ACK 和网络发送时重新核准权限。Schema 通过本身不授予访问，也不自动脱敏任意来源对象。

第一方 `display` 明确从 [Trace attributes schema](src/delivery.ts) 排除，Message 也只 pick 原有身份／角色／修订字段，Service 的独立字段白名单不复制摘录；不能因已允许 timing、usage、原身份或某种 Evidence，就将公开消息摘录、路径、模型展示名、原 Shell 展示描述或目标关联摘要自动外发。完整材料仍经原 typed owner 与当前 grant 读取，第一方索引不是新增的第三方授权通道。

投递 partition 绑定安装、来源、Session、订阅 epoch 及 live／history lane，history 另绑定 export ID。batch 的 `source` 必须与 lane 一致。`validateDeliveryResult` 只接受本批已发送成员，拒绝重复及 ACK／reject 重叠，并核对准确 batch／lease／generation／epoch。Host 在事务中重查当前 grant 和原 lease 后才提交 ACK；后项 ACK 不跳过前项 pending／dead-letter，也不确认整个扫描区间。重投保留事件身份，可以回到更早 sequence。扫描位置、待处理成员及连续 ACK 是 Host 的不同持久事实。通用 SDK 不提供 state patch、CAS 或 outbox；OTel 状态与 spool 属于其适配器。

## 验证与归属

2026-11-09输出存在性补充：`bun test packages/trajectory/test`全4文件37项267断言通过，覆盖Model／Message可选闭合值、错误绑定字段、非法计数与as-of不继承；Trajectory18文件类型检查通过。同源生成一致性由`bun run check:unified-api`核对，正文与原事务实际计数仍归Agent，传输／离线保留归Client。

`trajectorySchemas` 为同源 HTTP 生成导出运行时 schema，`trajectoryJsonSchemas()` 从同一校验器生成 JSON Schema 2020-12。[公共设计 fixtures](fixtures/protocol.json)展示恢复后身份、空筛选页推进、非终态派发和部分 ACK；该文件不是 runtime export，不要求发行时保留源码目录。

在仓库根运行 `bun run --cwd packages/trajectory test`、`bun run --cwd packages/trajectory typecheck`、`bun run --cwd packages/trajectory build`。owner 测试核精度、身份、canonical、闭合 attributes、未知版本、安全视图、无状态分页、部分 ACK 和确定性 provenance。六类独立 cursor oracle 覆盖正常完成、失败／重试、审批、并行子任务、中断恢复及缺失／未知事实，并有真实关联 Interaction／Verification 不替换 Execution 生命周期的反例。

[display 反例](test/display.test.ts)覆盖可选旧字段、有界闭合值、原位置投影、调用者改写隔离、消息新版本缺摘录不借用旧文，以及第三方 Trace schema 拒绝第一方摘要。2026-11-09，`e8a483d65` 加本轮工作树，macOS arm64／Bun 1.4.4：`bun test packages/trajectory/test` 为 35 项、242 断言通过；受影响包类型检查通过。实际原事务与 Shell／直接子 Agent 回执关联的验证归[Agent owner](../agent/src/trajectory/README.md)，本包纯测试不授予 Native 或外发运行资格。

离线 manifest 使用闭合、带版本的目录／section 格式；[Client](../client/README.md)负责明确导出、本地加载及有界 section cache。本包不拥有来源写入、权限、材料 I/O 或消费者状态。本机协议与纯投影测试不代表安装版或其他平台资格。
