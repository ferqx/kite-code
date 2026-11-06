# Agent Note: Worktree 持久默认目录与普通 Shell 路径政策

Status: implemented

## Problem

工作树只要求显式路径时，Agent 容易选择系统临时目录，关机或系统清理会丢失唯一工作副本。默认用户目录又与此前 Shell 对整个用户配置／Profile 根的遮挡冲突。用户确认默认使用 ~/.kite-code/worktrees，并移除普通 Shell 附加路径保护，仅保留非常危险系统级命令兜底；之后明确创建只走 git_worktree 的要求通过模型提示词表达。

## Decision

create 可省略 path，可信 Host 从 homedir() 捕获默认根，按来源／Session／key 稳定派生最终目标；显式路径优先，remove 保持准确路径必填。原意图不回填，resolvedTarget 单独首次冻结；授权从原 Run 的配置核根和路径，包含直接 child 的配置包装。同 key 先查原记录及 ref，默认设置变化不重发。默认父目录只在原获批 mutation Job 中逐级创建，首个 mkdir 后即保存副作用；失败保留原现场。临时目录与真实路径别名在 Tool 和 worker 复核，历史回执／既有临时树的安全删除仍可读取。

普通 Service 不再自动注入 Profile、配置、认证、Browser、controlBase 和整运行目录的路径遮挡，风险材料读取也不按这些位置额外拒绝。已有批准范围、系统危险命令兜底、执行资产身份、Linux 原生启动必要的准确 binary RO、进程监管、取消和 unknown 保持。自定义宿主显式权限和 confined 合同没有由普通默认行为变更覆盖；Files／Native 文件保护不变。

模型合同、Shell 描述与可写子角色指导要求只用 git_worktree 创建，工具不可用时不以 Shell／脚本兜底；不新增 Shell AST 命令拒绝或宣称能拦截任意程序间接调用。当前完整规则归[Worktree owner](../../../../packages/agent/src/tools/git-worktree/README.md)、[Shell owner](../../../../packages/agent/src/tools/shell.README.md)、[Jobs owner](../../../../packages/agent/src/jobs/README.md)和[工具手册](../../../../docs/handbook/features/tools-and-approvals.md)。

该决定部分调整[原 Worktree 决定](2026-11-06-git-worktree-tool.md)的显式创建路径边界，并补充[业务批准与通知决定](2026-11-06-worktree-business-authorization-and-notification.md)的默认目标证明。原重叠拒绝、删除保护、业务批准复用、消息、原 owner 恢复及平台资格继续适用；工具与协议版本没有升级。

## Alternatives considered

- 保留仅显式路径：不能提供一致持久落点，用户已要求默认目录。
- 默认根绕到另一用户目录：能避开旧保护，却不符合用户指定位置；按已确认政策移除普通 Shell 自动遮挡。
- 按新 Execution 或时间分配路径：同 key 重放或配置变化会生成新副本，无法保持原已接纳意图，未采用。
- 在 prepare 或 Host 配置阶段预建根：会在原 mutation 批准和监督之外产生副作用，未采用。
- 以 AST 拦截所有 Shell 间接创建：现有分析不能追踪任意 Python／Node 程序；用户明确选择提示词路线，没有新增这种限制。
- 移除所有沙箱与运行证明：用户调整的是普通附加路径政策，未取消已批准范围或原监管／恢复合同，不采用。

## Consequences

普通 Shell 在现有已批范围内可以访问以前被遮挡的配置和 Profile，文件工具仍保自己的保护。默认工作树在 Workspace 外时仍须足够的原权限；默认选择不自动扩为 full_access。目录创建失败可能留下父目录，不能递归清理；通知与原回执不因默认路径产生额外 authority。

验证归[Worktree 回归](../../../../packages/agent/test/isolated/tools/git-worktree/README.md)、[Service](../../../../apps/service/README.md)和[真实模型入口](../../../../tests/e2e/live/model/README.md)。Bun 会缓存启动 HOME，测试必须在子进程启动时隔离，并在任何 Git 变更前核对 homedir；运行中修改环境不构成隔离证明。所有 live case 均使用启动隔离；在源码 Git 摘要、合成仓库和 Provider 之前，沿原受管 Shell 运行独立只读预检并核完整关闭，避免监管不可用时先产生 Git 变更。预检与收证取消不授予继续执行权，业务和关闭错误分别保留；这只是隔离测试夹具，不新增产品 Runtime、Job 类型或审批。历史中断或缺失原终态保持 unknown，不因新样本通过改写。
