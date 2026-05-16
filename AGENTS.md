# AGENTS.md

> 本文件是协议入口。完整的行为规范、技术栈、命令和约束以 [CLAUDE.md](./CLAUDE.md) 为准。
> 以下仅补充 CLAUDE.md 未覆盖或面向多 agent 协作的说明。

## 对后续 Agent 的提醒

- 不要把 `tests/.tmp-*` 下的文件当成正式源码或稳定夹具。
- 仓库的很多「真实约束」写在测试里；遇到不确定行为时，优先读测试。
- 执行计划优先留在对话或任务计划里。
- `docs/space/` 是仓库内记录系统，不是聊天记录归档。进入 `docs/space` 后先读 `index.md`，再按任务范围读取被索引的 active / understanding / reference 记录。
- 当某类知识反复出现、跨模块扩散，或 `docs/space` 记录开始难以导航时，应主动参考 `docs/space/understanding/space-system-design.md` 的文档晋升规则，提议或创建合适的顶层入口文档。
