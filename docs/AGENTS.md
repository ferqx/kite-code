# 文档维护入口

遵循[根 Agent 规则](../AGENTS.md)的预期与证据关系、授权边界和同步触发时机。

1. 按任务从[产品手册](handbook/README.md)、[开发入口](development/README.md)或[有效计划](plans/README.md)定位负责专题，不要求通读客户端或全部技术层次。
2. 编写文档按[文档维护规则](development/documentation.md)确定内容归属、当前与目标状态和历史资料生命周期；同一事实只在负责位置完整维护。
3. active 保留一次 `状态：active`、`读取时机：`、`验证：` 元数据；新增局部文档由 workspace README 索引。当前源码和测试引用使用可检查链接。
4. 到达根规则规定的完成或提交边界时，执行[文档同步 Skill](../.agents/skills/document-before-commit/SKILL.md)。已读规则与有效验证的复用条件见 Skill。
