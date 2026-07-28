# ADR-0046：受管文件 Rewind 使用持久 Journal 保证崩溃一致性

状态：accepted
日期：2026-07-28
决策人：项目所有者（RFC 转实施确认）
替代：ADR-0042 §4 的 best-effort pre-image/Rewind 结论

## 背景

ADR-0042 将文件 pre-image 和 Rewind 作为 write/edit 可逆性兜底，但当前实现吞掉 pre-image 持久化错误，并允许单个文件恢复失败后继续截断 Runtime。SQLite transaction 与文件系统替换不能构成普通跨资源 ACID transaction；只用进程内 try/catch 无法处理 kill -9、断电或重启期间再次崩溃。

## 决策

1. 0.1.0 的 Rewind 保证只覆盖统一 mutation gateway 下的：
   - `write_file`
   - `edit_file`
   - 所有目标均进入 gateway 的 `apply_patch`
2. Shell、MCP、Subagent 内部进程和用户外部修改不在该保证范围，UI 必须称为“回退受管文件修改”。
3. 文件 mutation 前必须：
   - 规范化并验证目标；
   - 持久化 pre-image 与 mutation intent；
   - 确认事务提交；
   - 执行 mutation；
   - 持久化 mutation receipt。
4. pre-image 失败、配额不足或路径身份漂移时，写工具 fail closed。
5. Rewind 使用持久阶段：
   - `prepared`
   - `workspace_applying`
   - `workspace_applied`
   - `store_committed`
   - `cleaned`
6. 每次阶段转换先持久化，再执行对应动作。启动发现未完成 journal 时，Session 在恢复收敛前不可运行新 Effect。
7. `prepared` 清理 staging；`workspace_applying/workspace_applied` 从 backup 恢复原工作区；`store_committed` 只继续 cleanup。
8. 恢复时不信任历史绝对路径，重新执行 realpath、workspace、symlink、protected-path 和 file identity 检查。

## 备选方案

- 保留 best-effort 并显示失败列表：拒绝。会产生会话与文件分裂状态。
- 文件恢复后直接截断 Store，失败时内存回滚：拒绝。不能处理进程崩溃。
- 宣称恢复整个工作区：拒绝。Shell/MCP 等副作用没有统一 pre-image/receipt。
- 依赖 Git reset：拒绝。工作区可能未提交、非 Git 或包含用户并发改动。

## 后果

- ADR-0042 的 edit/write 语义保留，仅其 best-effort 可逆性结论被本 ADR 替代。
- RuntimeStore 增加 mutation receipt、pre-image 配额和 Rewind journal。
- Rewind 失败可能进入 recovery-blocked，而不是继续执行。
- 需要每个 journal phase 的 crash injection。

## 回滚

关闭新 Rewind 路径前必须确认不存在未完成 journal。旧版本不得打开并写入包含新 journal 的 Store。数据回滚使用完整 Store 备份；工作区恢复由写入该 journal 的兼容版本先完成。
