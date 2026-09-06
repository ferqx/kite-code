# 文档语言与当前内容检查

状态：active
读取时机：创建、修改、迁移文档或修改文档检查时。
验证：`bun run check:docs`、`bun run check:docs-impact`、`bun test tests/integration/docs-impact.test.ts tests/integration/docs-structure.test.ts`。

正文以中文为标准。根 README.md 保留英文，README.zh-CN.md 保留中文，命令、事实和入口同步。命令、路径、类型名、配置键和正式产品名称保留原文；不为翻译改产品行为。

详细职责与冲突处理见[文档维护](../development/documentation.md)。产品手册按共享定义和各客户端指南组织；内部文档按实际 owner 组织。不得把 TUI 的渲染规则或 Web 的可用能力默认推广到其他客户端。

结构检查递归覆盖 handbook、development、active、runbooks、workspace 文档和当前入口；检查本地链接、禁止 wiki-link、active 元数据和 V2 映射。历史 ADR 与保留的计划证据不需要旧代码路径仍存在，但当前文档指向它们的链接必须有效。

影响映射只覆盖实际生产源码、manifest 和相关基础设施，普通测试不因路径位于 workspace 内触发架构规则。专业路径与通用 source owner 互斥。映射提供产品与技术文档核对提示，不要求行为不变的改动制造文档 diff。
