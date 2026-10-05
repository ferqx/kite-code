# Agent Note: 普通问题沿原 schema 呈现并校验完整答案

Status: implemented

## Problem

现有 TUI 的单题选择、自由回答与多题返回流程属于产品承诺。统一终端此前只接受普通 question 的 JSON 文本，不能用选择键完成原问题。仅在 UI 添加带标题的选项也不足：真实 Tool 的 `context.requestInput` 发出 const/title 组合 schema 后，Core 在创建原卡前返回 `question_schema_invalid`。将 fixture 改成裸 enum 虽能完成流程，却没有证明逐选项文案与内部 ID 的区别。

联合核对还发现 Ajv 默认会读取对象继承属性，缺少实际自身 toString 的答案可能满足 required；编译器又排除 properties 的 `__proto__`，使缺字段的答案与真实同名字段得到相反结果。只在 Ink port 上证明发送了一个特殊键，不能证明原 Core 接受了符合 schema 的答案。

## Decision

普通信息问题继续使用原 `request.schema` 和 `interaction.answer`，不引入旧 questions payload、展示 DTO 或新的回答入口。Core 在已有闭合关键字内增加 oneOf/anyOf，每个非空组合分支走同一 256 schema 节点、12 层预算；请求与答案的 32 KiB、2048 节点/16 层上限保持。原 Ajv 执行组合语义，信息答案仍不建立 Tool grant。

Core 使用 `ownProperties:true` 校验实际 JSON 字段。当前 Ajv 无法忠实表达 `__proto__` property，故准入递归拒绝该自身属性及 required 中的同名键。合法自身 constructor/toString 继续保留原值，不借继承属性满足必填。$ref、pattern、format、allOf 和未知关键字仍拒绝。

UI 只生成能完整表达原约束的标量或浅 object 表单；互不重叠的 const/enum 选择显示原 title/description，明确 anyOf string 分支才提供 Custom。复杂、重叠或不支持的输入保留显式 JSON，不以选择组件放宽验证。字符串长度按 codepoint 校验，编辑沿现有 ComposerBuffer 保留字符簇、光标、多行 paste 和用户原文。自有提示使用已有语言目录，原问题与答案不翻译。

每卡步骤草稿绑定完整 interactionKey；返回上题保留后题草稿，revision 变化重新核对，最后一步才提交完整答案。原 controller、附件 reader、unknown 原命令查询与 caller journal 保持各自职责。

## Alternatives considered

- 只保留 JSON 或把带标题 schema 改成裸 enum：能沿原回执提交，但不能交付既有选择、文案和自由回答体验；真实 enum 通过仅作为有限基础证据。
- 新增选项 metadata/答案映射协议，或引入旧 Runtime 的 questions 结构：现有标准 schema 已能表达需要的值与文案，会制造第二套公共合同和迁移依赖，未采用。
- 打开任意 JSON Schema 或为 `__proto__` 制作转换/校验器：超出当前消费者需要，并使原有预算、无外部 I/O 和无正则边界难以核实。保留有限组合与明确拒绝。
- 自动选择首项、将封闭 enum 添加 Custom、trim 或截短文本：会修改用户决定或原答案，未采用。

## Consequences

UI、Core 只扩大有限信息 schema 的可表达范围；没有数据库迁移、HTTP DTO 改动、权限或执行 manager。定义原问题的 Tool 仍负责将接受的内部值解释为业务结果；通用表单不注册默认 ask_user，也不自行编造 Agent 摘要。

实际 SQLite red/回归证明组合准入、重叠语义、自身字段与事务拒绝；Ink 验证步骤、原键值、草稿、语言及回答门禁；源码外 macOS PTY 验证标题/原 ID、多行原文、Custom、唯一原答案和正常退出。当前证据与命令由[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)维护，断言入口为[Storage](../../../../packages/agent/test/isolated/storage/interactions.test.ts)、[UI](../../../../packages/ui/test/tui/questions.test.tsx)和[PTY](../../../../apps/cli/test/isolated/tui-question-pty.test.ts)。默认 ask_user、正式安装、Linux/Windows、异常退出资格及完整 V1.3 仍需各自真实证据。

当前合同归[Interaction owner](../../../../packages/agent/src/storage/sqlite/interactions/README.md)与[TUI owner](../../../../packages/ui/src/tui/README.md)，产品预期见[审批与问题指南](../../../../docs/handbook/clients/tui/guides/approvals-and-questions.md)。此前[原人类答案资产](2026-10-04-original-human-answer-intent-assets.md)的冷回执和恢复身份约束继续适用；本决定不改变它们。
