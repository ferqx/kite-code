# Agent Note: Windows Worktree Git 使用原 Job 的文件句柄

Status: implemented

## Problem

2026-11-06 的真实 Windows Desktop 验收中，用户批准后，Git Worktree 的只读 prepare 和 list 仍返回 git_operation_failed，mutation:not_started。原正式 Windows 宿主对照确认：Bun1.4.4 的子进程只要创建 stdio pipe，在 workspace_write 的受限 token 下就因 uv_spawn EPERM 失败；相同 Git、仓库和 token 使用继承的普通文件句柄可成功。Full 下管道可用，不能因此把正常只读工作升级为 Full。

## Decision

仅在 [Windows Git 叶实现](../../../../packages/agent/src/tools/git-worktree/windows-process.ts)将 stdin/stdout/stderr 交给本 Job 私有 TEMP 内的独占普通文件 FD，Git argv、环境允许集合、受管 worker、权限与取消域保持。输出分块读取，保留原 stdout/stderr 预算、精确哈希字节数、UTF-8 解码及最终 EOF／文件身份核验；仅关闭自己拥有的 FD，清理按原身份定点执行，清理未核实不报告成功。其他平台继续使用原管道路径，工具与协议版本不变。
新观察到的失败按实际阶段携带有限分类：子进程未启动、明确访问拒绝、Git 已启动后非零退出及核验失败；旧稳定回执不追溯猜测。选择在失败发生处记录分类，而非解析 stderr，是因为 spawn EPERM 不证明用户拒绝，Git 输出还可能包含路径、URL 或凭据。新增有限字段保留原协议版本和业务 code；清理未确认保留主因及原 mutation，不将已有或未知效果改写为未执行。回执、模型指导与 Native 提示共同要求核对原 key／Job，不以扩权或换 key、参数、Shell 反复重试；模型指导本身不提供模型永不重试的技术保证。

## Alternatives considered

- 扩大为 Full 或放宽 Git safe.directory：不能解决正常范围下的兼容性，且会改变原请求授权或仓库安全检查，未采用。
- 直接继承外层 stdout/stderr：Git 原始字节会混入 worker 唯一机器回执，无法沿原完整结果边界验证，未采用。
- 继续在受限 token 内使用管道：原正式宿主已经稳定复现启动失败，不能以普通进程下成功代替。

## Consequences

Windows 每次 Git 子调用增加所属 Job TEMP 内的短期文件 I/O；没有新增工作树数据库、权限入口或全局缓存。借用的 inputFd 不转移所有权。相关有界读取、原进程取消与资源收口继续由 Job 和本叶共同核验；不是操作系统沙箱或完整发行资格的补证。

[Worktree owner](../../../../packages/agent/src/tools/git-worktree/README.md)维护当前实现与验证范围，[Native owner](../../../../apps/desktop/README.md#native-项目会话目录)维护真实客户端创建、图标和目录恢复过程。未来若更换运行时，仍须用相同受限宿主核对管道与当前 FD 路径，不能只凭普通 Git 命令退出0移除此边界。
