# 仓库 Agent 规则

## 理解与读取

1. 用户确认的需求与[产品手册](docs/handbook/README.md)定义预期；源码和运行证据说明实际，测试只证明其断言。冲突必须明确预期、实际、客户端和证据，不能自动以实现覆盖产品承诺。
2. 修改 TUI/Web 功能先读对应手册专题，再读所属 workspace 文档和测试；共享语义变化再读相关跨包契约。内部重构按 owner 读取，不要求通读手册。
3. [开发入口](docs/development/README.md)负责定位；文档修改先读 [docs/AGENTS.md](docs/AGENTS.md)。ADR 是历史取舍，计划不是当前实现依据，不通过替代链推导产品功能。

## 自主推进与授权

已授权目标内的文件组织、局部实现、排查、必要验证和文档同步由 Agent 自主完成。已确认设计按阶段继续推进，阶段核对不产生新的用户审批。明确要求实施的任务应交付实现、必要验证、受影响文档同步和剩余问题说明。

只有现有需求与证据无法解决、且会实质改变产品行为、范围或授权边界的问题，才请求用户决定；其他已明确工作继续推进。Skills 不扩大原任务授权，也不从一般性建议推导额外审批。真实权限或规则限制应指出具体来源；已有授权在其范围内持续有效。

## 工程约束

- `packages/agent-kernel/` 不得依赖其他 workspace、I/O runtime 或 TUI 展示类型。
- 用户行为变化同步对应手册；实现边界变化同步 owner 文档；跨包、安全、恢复、发布或运维变化同步相关 active。行为不变时核对并说明，不制造无意义文档 diff。
- 重要架构取舍新增 ADR；已接受历史结论不改写。失效记录提炼有效知识后可从当前树删除，历史由 Git 保存。
- 不覆盖或清理无关用户改动，不使用 `git add -A` 吸收其他任务文件。

## 工作树与协作

当前工作树仅有本任务改动、唯一 Git owner 且无并发 authority 冲突时可直接使用。只有无关 dirty、并发写入、用户要求或长期独立分支需要时才建立 worktree。

只有主 Agent 可以 stage、commit、push 或创建 PR。同一 current authority 的并发任务必须串行，先合并再 rebase 和复验。临时 worktree 验证后默认 fast-forward 合回原分支并清理；需要独立 PR、用户要求保留或无法安全合并时再确认方向。

## 阶段与提交门禁

每阶段完成及最终交付前，显式执行[overengineering-check](.agents/skills/overengineering-check/SKILL.md)。未清除无需求机制时保持 in_progress，不以文档或自身测试为新增抽象辩护。

已确认且需留作后续实施依据的设计执行 `design_complete`；每个显式实施阶段和迭代完成执行 `iteration_complete`，即使不提交也核对产品、技术及其他受影响文档。工具调用和进度更新不单独构成阶段；普通小修复不强制新建计划或设计标记。

stage、commit、push、PR 前显式执行[document-before-commit](.agents/skills/document-before-commit/SKILL.md)。作用域、证据复用及阻塞范围由该 Skill 定义，现有 hook 和 CI 独立执行强制检查。不得使用 --no-verify 绕过检查。
