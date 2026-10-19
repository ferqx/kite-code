# Windows 工作树清理

本仓库在 Windows 隔离工作树中独立安装依赖，禁止用 junction／symlink 共享主仓库或其他工作树的依赖、源码和缓存。Bun 安装的 workspace 联接也必须在删除前检查；独立安装并不等于目录内没有联接。

## 清理前检查

1. 结束对待清理工作树的写入，保存所需未提交改动和未跟踪文件，记录主仓库当前 Git 状态。归档快照不包含全部忽略文件，也不能阻止目录联接造成的越界删除。
2. 从主仓库运行只读检查，使用工具返回的准确绝对路径：

   ```powershell
   bun scripts/check-worktree-cleanup.ts --worktree=C:/Users/example/.codex/worktrees/task/project
   ```

3. 检查拒绝主工作树、未登记目录、相对路径、指向其他目录的祖先，以及遍历中遇到的任何文件／目录联接；遇到联接只报告入口和目标，不进入目标。错误和非零退出均表示停止清理。检查有意同时拒绝内部联接、循环和已断开的联接，避免间接跨界及不同删除器的差异。
4. 发现临时依赖联接时，核对原创建记录、入口绝对路径及 `LinkType/Target`；只对确认属于本任务的联接本身执行非递归删除，例如 PowerShell 的 `[IO.Directory]::Delete($verifiedLink.FullName)`。不得给该调用添加递归参数。不明联接先保留，不能直接递归删除整个 `node_modules`。全部入口断开后重新检查；只有退出码 0 才可沿原工具归档。
5. 归档后重新核对主仓库跟踪文件及原未提交改动。`git worktree remove` 的非零退出必须核实，不能根据上层“清理成功”文本推断文件安全；出现缺失立即停止后续清理并保留快照和日志。

[检查器](../../scripts/check-worktree-cleanup.ts)不修改文件、不移除联接、不调用归档或删除 API。它是本仓库 Agent 的清理前门禁，不是 Codex 桌面应用的拦截器，也不能把检查后重新出现的并发目录替换变成安全操作。检查至归档之间必须保持工作树静止。通过应用界面归档聊天也会触发托管工作树清理，应先完成上述检查；自动删除的开关按 [OpenAI 官方工作树文档](https://learn.chatgpt.com/docs/environments/git-worktrees#worktree-cleanup)在应用设置中管理。

## 2026-10-19 事故与验证

当地时间 00:03:47，Codex 日志记录 `questionnaire-ui` 的 `archive-cleanup`；00:03:49 保存快照 `2c740891` 后执行 `git worktree remove --force`，00:04:19 以 255 失败，上层随后仍记 `worker-success`。此前的会话记录显示该工作树为复用依赖创建了指向主仓库的目录联接；主仓库 `agent/ai/client/ui/service` 的源码在同一时段消失。

在 Windows／Git `2.53.0.windows.1`／Node `24.15.0` 的全新合成仓库中，建立 `checkout/node_modules → primary/node_modules → @kite-ai/* → primary/{packages,apps}` 后，执行同一 Git 删除命令，5 个模拟主仓库源码文件全部消失；未连接任何真实源码目录。由本机日志、原创建记录和相同机制复现确认：归档调用触发的 Git 工作树删除沿 junction 链越界。应用随后如何处理非零退出不影响这一已复现的原因。归档前遗漏联接检查是本次操作失误，不应归因于产品业务代码。

同日对照夹具先非递归移除工作树的两处联接入口，再从模拟主仓库执行删除，Git 退出 0，5 个原源码文件的 SHA-256 及主仓库依赖入口均保持。只读扫描当时残留的 19 个托管工作树目录，未发现联接或读取错误；该结果不代表未来新增的工作树自动安全。

[回归测试](../../tests/isolated/scripts/worktree-cleanup.test.ts)覆盖实际目录联接链、祖先联接、内部循环、断开联接、主工作树／未登记目录拒绝与正常次级工作树；它只验证只读检查和原文件保全，不把故障行为变成未来 Git 版本必须保持的测试断言。持久取舍见[清理门禁决定](../../.agents/notes/implemented/process/2026-10-19-windows-worktree-cleanup.md)。
