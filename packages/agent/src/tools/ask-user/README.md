# 普通 ask_user Tool

模型工具名保持 `ask_user`，可信 model 元信息启用声明属性的 snake_case 投影。题目、选项和答案正文保留原值。单选沿用原校验 schema 和答案形状，多选沿同一个 question 和回答端口保存。

整份请求的原 schema 是 `oneOf`：闭合题目 object 或明确的 `const:null` 取消选项。客户端可在未填完问题时提交这个原 null 值；Core 仍保存普通 question answer，公开 `answer_saved.cancelled:false`，不取消 Run。leaf 将 null 解释为成功取得的取消信息 `{cancelled:true}`，交给同一 Run 的后续 Model 请求，不自动重问。该信息取消与原工作 signal 取消分别保留，不增加专用 DTO、Interaction kind 或恢复入口。

公开 `@kite-ai/agent/ask-user` 的 `createAskUserExtension()` 纯工厂登记 `builtin.ask-user@1` 与 `ask_user@1`，import 和工厂不打开资源。执行只调用当前普通 `ToolContext.requestInput`，没有旧 Runtime 依赖、专用 Loop、数据库迁移或回答端口。

模型输入是闭合 `{questions}`，包含 1–3 题。每题使用闭合 `{question,options,multiple?}`，包含 3–4 个闭合 `{label,description,recommended?}` 选项。`multiple` 是可选布尔值，仅 `true` 启用多选，缺省或 `false` 为单选。题文和文案 trim 后须非空。`recommended` 是可选布尔值，每题至多一项为 `true`，推荐项可位于任意位置。模型不能指定内部 ID、自由输入开关或旧单题顶层字段。自有解析失败在发出信息请求前返回已知失败，不把未发生的效果记为未知。

每题生成原 `q1…q3`、`qN-oM` ID，通过有限原 JSON Schema 的 `anyOf` 请求答案。单选提交原选项 ID，多选提交至少一个且互不重复的原选项 ID，数组上界为该题选项数。只填写自定义答案时，两种题型都提交闭合 `{text:string}`。多选也可提交 `{text:string,choices:string[]}`，其中 `choices` 复用无重复的 ID 数组约束。`text` 的 `minLength:1` 和准确 `pattern:'\\S'` 在 Core 保存前拒绝空白；不 trim 或截短合格答案。已保存的问题按原 schema 作答。`request.recommendedOptions` 单独保存由题目 ID 到明确推荐选项 ID 的映射，没有推荐时记录空映射。客户端仍须明确作答。

原问题答案仅提供信息。单选 ID 映射为原 label，多选 ID 数组映射为原 label 数组。组合回答将自定义原文附在所选文案数组末尾，自由回答保留原空格、Unicode 和多行。结果 `{answer,answers}` 同时用于 Tool content 与 details，`answers` 保留每题的字符串或列表，`answer` 使用原文案并将多选文案连成摘要。多题摘要格式化题目时使用一个冒号，原题文与自由回答保留原文。持久 Interaction 保留原 ID、ID 数组或含原文的原答案对象。

本 leaf 没有外部效果。原 `requestInput` 抛出准确 `cancel_requested`，且异常与已取消 signal 的原 reason 同对象时，返回 cancelled。未取消的问答执行可将已确认的 `question_schema_invalid`、`interaction_answer_invalid` 和 `interaction_not_found` 作为原 Tool 的失败结果返回。其他异常继续由 Core 分类。客户端答复命令的未知回执继续查询原身份。通用恢复与接纳边界由 [Interaction owner](../../storage/sqlite/interactions/README.md)负责。

[Service 默认装配](../../../../../apps/service/README.md)负责实际注册、根默认选择、版本与 options 校验、可信零效果权限分类，以及 child ToolSet 排除；leaf 不取得当前 Session 的父子管理权。JSONC 禁用或移除只影响后续选择，已准入 Run 的定义与问题保持原绑定。

[leaf 测试](../../../test/isolated/tools/ask-user.test.ts)核纯工厂、canonical 解析、真实 Core/SQLite 的 ID／文案、自由 ID 碰撞、空白拒绝、原取消及冷读取。实际默认 compatible Provider、Client 与源码外 TUI 资格归 [Service](../../../../../apps/service/test/isolated/ask-user-configuration.test.ts)和[CLI PTY](../../../../../apps/cli/test/isolated/tui-question-pty.test.ts)，日志与未验证范围见[实施进度](../../../../../docs/plans/unified-agent-refactor-v1-progress.md)。
