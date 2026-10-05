# 普通 ask_user Tool

公开 `@kite-ai/agent/ask-user` 的 `createAskUserExtension()` 纯工厂登记 `builtin.ask-user@1` 与 `ask_user@1`，import 和工厂不打开资源。执行只调用当前普通 `ToolContext.requestInput`，没有旧 Runtime 依赖、专用 Loop、数据库迁移或回答端口。

模型输入是闭合 `{questions}`：1–3 题，每题闭合 `{question,options}`，2–3 个闭合 `{label,description,recommended?}` 选项。题文和文案 trim 后须非空，每题至多一项 `recommended:true`；模型不能指定内部 ID、自由输入开关或旧单题顶层字段。自有解析失败在发出信息请求前返回已知失败，不把未发生的效果记为未知。

每题生成原 `q1…q3`、`qN-oM` ID，并通过有限原 JSON Schema 的平坦 `anyOf` 请求答案：选项是带原文案的 const ID，自由回答是闭合 `{text:string}`。`text` 的 `minLength:1` 和准确 `pattern:'\\S'` 在 Core 保存前拒绝空白；不 trim 或截短合格答案。该对象分支使自由输入 `q3-o1` 与同文选项 ID 保持区别。显式推荐项或缺省首项显示推荐标记，客户端仍须明确作答。

原问题答案仅提供信息。选项 ID 映射为原 label，自由回答保留原空格、Unicode 和多行；结果 `{answer,answers}` 同时用于 Tool content 与 details。单题 `answer` 是文案或自由原文，多题逐行保存 `问题: 答案`；持久 Interaction 仍保存原 ID／自由对象，不以语义摘要替换恢复身份。

本 leaf 没有外部效果。原 `requestInput` 抛出准确 `cancel_requested`，且异常与已取消 signal 的原 reason 同对象时，返回 cancelled；其他异常保持 Core 的原分类，不自动重问或合成答案。通用恢复、未知回执和接纳边界由 [Interaction owner](../../storage/sqlite/interactions/README.md)负责。

[Service 默认装配](../../../../../apps/service/README.md)负责实际注册、根默认选择、版本与 options 校验、可信零效果权限分类，以及 child ToolSet 排除；leaf 不取得当前 Session 的父子管理权。JSONC 禁用或移除只影响后续选择，已准入 Run 的定义与问题保持原绑定。

[leaf 测试](../../../test/isolated/tools/ask-user.test.ts)核纯工厂、canonical 解析、真实 Core/SQLite 的 ID／文案、自由 ID 碰撞、空白拒绝、原取消及冷读取。实际默认 compatible Provider、Client 与源码外 TUI 资格归 [Service](../../../../../apps/service/test/isolated/ask-user-configuration.test.ts)和[CLI PTY](../../../../../apps/cli/test/isolated/tui-question-pty.test.ts)，日志与未验证范围见[实施进度](../../../../../docs/plans/unified-agent-refactor-v1-progress.md)。
