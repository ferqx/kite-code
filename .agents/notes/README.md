# Agent Notes

Agent Note 保存影响本仓库的持久决定或提案的原因、真实备选、代价与必要验证。产品手册定义预期行为，workspace 与 active 文档记录当前实现；Agent Note 解释为何选择该边界，不替代它们。历史决策记录已迁入本目录，统一按下述生命周期维护。

## 路径与生命周期

每篇记录使用 `.agents/notes/{lifecycle}/{class}/yyyy-mm-dd-topic.md`。日期是主题首次提出的可核对日期；迁移旧记录时优先使用原记录日期，未记载时使用 Git 最早加入日期。生命周期由目录和文件 `Status:` 同时表达：

- `proposed/`：尚未完整交付的提案，包括只完成一部分的决定；可保留迁移步骤和待验证问题。
- `implemented/`：已交付的决定；正文描述已交付事实，路径、名称和默认值随实现同步。
- `rejected/`：经过考虑而放弃的提案；仅在拒绝理由仍可防止重要误判时保留。
- `archived/`：曾已实施、现已结束且不再指导当前工作，但仍有历史决策价值的冻结记录。其 `Status:` 仍为 `implemented`，下一行标 `Archived: YYYY-MM-DD`。归档内容不作为当前依据。

`class` 只能是 `feature`、`bug-fix`、`simplification`、`architecture`、`process`、`testing`。生命周期与类别目录就是工作清单，不另建集中索引。记录之间用相对 Markdown 链接，不依赖裸编号。

## 文件格式

首行是 `# Agent Note: <title>`，空一行后为 `Status: proposed`、`Status: implemented` 或 `Status: rejected — <一行原因>`，再空一行开始正文。归档记录在状态行后紧接 `Archived: YYYY-MM-DD`。

正文先写 `## Problem`，使问题本身脱离解决方案仍可理解；所有新记录必须写 `## Alternatives considered`，逐项说明真实考虑过的方案及淘汰原因，不得补造历史。旧记录 若没有留下可重建的备选证据，保留 `<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->` 明示缺口。迁移标记只适用于旧记录，新记录不得用它代替取舍。

- `proposed/` 使用 `## Proposal`、`## Alternatives considered`、`## Acceptance criteria`、`## Risks`。
- `implemented/` 使用 `## Decision`、`## Alternatives considered`、`## Consequences`；可以补充当前验证与限制，但不以提案语气宣称尚未交付的能力。
- `rejected/` 保留提案时的正文形态，状态行写明拒绝理由。

可在这些必需章节之间增加技术专题章节。旧记录中的证据不足处如实标记；测试、手册和源码分别证明各自能证明的范围。

## 新建、变更与归档

只为代码、测试和当前负责文档无法表达的长期取舍写 Agent Note。新记录先搜索已有决定，更新同一决定的事实，避免重复。改变决定本身时写新记录并交叉链接；部分取代的旧记录仍留在活动目录，并明确尚适用的范围。完整取代只在当前记录保存旧记录独有的理由、备选、代价和验证之后才能整合删除，同时修复入站链接。

实施一个提案时，将其移至 `implemented/`，把提案、验收和风险改写成实际决定、后果及已取得的验证。放弃提案时移至 `rejected/` 并写原因。只有已实施且未来指导价值低的记录可归档；归档后冻结正文，当前行为始终回到产品手册及负责文档核对。
