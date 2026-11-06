# Agent Note: Worktree 退出只导航，Auto 准确调用免审批

Status: implemented

## Problem

真实 Native 会话把“退出工作树”交给模型后，模型将它解释为 remove，随后 Auto 拒绝了未经明确授权的删除，并回复“无法退出”。创建本身从未迁移原 Session cwd，独立添加的 linked 项目又没有可核实的来源导航关系。用户要求明确区分退出与删除，并明确指定 Auto 下工作树组件不走审批。

## Decision

退出属于客户端导航。Native 的独立无附件退出命令和明确按钮只消费原目录可选 worktreeSource，刷新目录并核当前 Store／选择代次后复用 select；未核实唯一来源时保草稿并说明，不退回模型猜测。普通长句、解释、引用、代码及带附件内容仍走聊天；默认模型合同禁止以 remove、Shell 清理或改 refs 代替退出，只有明确具体目标的删除意图才可删除。原创建会话 cwd 未变时仅说明事实。

来源关系由同一目录只读快照核真实原生稳定 create、完整 owner Tool／Job／Run、主体可见来源 Session／Workspace、冻结 sourceCwd 和目标路径；重复同关系去重，歧义或缺证据省略。不建立工作树管理数据库，不探测实时目录，也不授予执行权。Windows 显式请求路径按原 worker 的 resolve 规则等值比较，不能用前缀或父目录猜来源。

Auto 仅让准确 builtin.shell/git.worktree@1 Tool 免审；内部 Job 继续由 Store 核原免审决策、封存父链、冻结步骤和最终派发读集。普通 Shell 不能凭相同 worker 命令取得免审，手动、父子／Planning 上限、申请范围、硬限制及删除保护保持。没有新增工具 action、协议版本或权限模式。

该决定仅替代[原业务批准决定](../feature/2026-11-06-worktree-business-authorization-and-notification.md)中 Auto 每个业务动作审核一次的部分；手动批准复用、完整派发与恢复证明、创建通知及其余理由仍适用。

## Alternatives considered

- 只修改提示词：可纠正模型意图，但模型没有现成的会话切换工具，不能完成真实客户端导航；同时增加有限本地命令与按钮。
- 用 remove 模拟退出：改变数据与 Git 登记，违背退出的导航语义，不采用。
- 依据聊天路径、分支、父目录或历史布尔猜来源：不能证明准确 Session／Workspace，采用原稳定记录关系及缺省回退。
- 对整个 Shell Job 或可解析 worker 命令标免审：普通 Shell 可伪造相同命令，不采用；仅复用准确原 Tool 的免审来源。
- 让任意包含“退出工作树”的正文触发导航：会吞掉解释、引用、复合要求和附件，采用独立命令集合，普通文本仍交给模型。

## Consequences

退出保留工作树、原任务、会话草稿和阅读状态；没有新的模型调用或 Git 变更。来源不可见或证据不足时不能自动返回，用户仍可在侧栏选择项目／会话。关系是创建历史，不保证路径始终存在或已恢复信任。Auto 免审批不替代用户任务授权，也不扩大任何 scope。

当前行为和验证分别由[Native owner](../../../../apps/desktop/README.md)、[权限 owner](../../../../packages/agent/src/permissions/README.md#git-worktree-的准确权限)、[Store 目录](../../../../packages/agent/src/storage/README.md#目录分页)及[Worktree tests](../../../../packages/agent/test/isolated/tools/git-worktree/README.md)维护；本机和受控验证不代替任意模型或三平台发行资格。
