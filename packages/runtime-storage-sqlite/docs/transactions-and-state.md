# 数据对象与事务提交

入口：[Session storage owner](../src/kite-session-runtime-storage.ts)、[mutation](../src/kite-session-mutation.ts)、[schema](../src/kite-home-store.ts)、[run store](../src/run-store.ts)。名称含 kite-home 的底层文件仍有当前消费者，不等于旧 single-Service 拓扑仍有效。

## 数据关系

| 数据 | 作用 | 交接 |
| --- | --- | --- |
| Session / revision | 当前会话状态与并发版本 | Host 命令 expectedRevision |
| Event / snapshot | 可重放事实与读取加速状态 | Kernel event/state codec |
| Run | 排队、活动与终态执行索引 | Host storage port，API/查询投影 |
| command receipt | 已提交命令的幂等结果 | Host 重放前验证 digest 与 scope |
| execution authority / effect | writer 身份及外部操作状态 | App 获取，mutation/dispatch 校验 |
| Artifact / checkpoint | 大内容或恢复所需数据 | typed reader 与恢复入口 |

具体表定义以 schema 为准，此处不复制 SQL。目录或 API 返回值不是第二数据库 authority。

## 写入过程

执行期间的 Session mutation 在 BEGIN IMMEDIATE 内重新读取 generation 与 Session revision，再执行变更。检查不能放在事务前，否则其他 SQLite writer 可以在检查后提交。无 Session、旧 revision 或失效 writer 必须失败，不覆盖较新状态。

storage owner 使用 AsyncLocalStorage 传递本次 execution handle。runWithExecution 绑定精确 handle，foreign/stale/缺少 execution scope 的写入拒绝；readSnapshot 不因此获取写权限。

start 对应 Run、command receipt、事件与 State 的关联更新必须在所属事务一致提交；后续 activation、interaction、terminal 同步 Run 索引，不能绕过 Store writer 直接改查询投影。

验证：[mutation](../test/kite-session-mutation.test.ts)、[storage](../test/isolated/kite-session-runtime-storage.test.ts)、[run store](../test/run-store.test.ts)。


## 无执行者的设置事务

冷会话权限设置使用 `commitUnownedDecision`，不取得 execution handle。该入口在同一 BEGIN IMMEDIATE 内要求 authority 为 idle 或 recovery_required，并校验 expected Session revision；active、detached 与旧版本拒绝。必须携带同 Session 的命令回执，禁止 requiredEffectLease、runMutation 与 sessionModelRoute；Service 再限制为权限事件。入口只调用已有 decision 原子提交，不暴露通用无租约写作用域，不修改 authority 或恢复事实。后续执行仍走原有 generation fence，事务失败不会留下可用于任意写入的作用域。验证见 [Session Store 回归](../test/isolated/kite-session-runtime-storage.test.ts)。

## 按会话恢复校验

schema assertion 检查表、列、索引、DDL、marker 与 epoch；SQLite physical/FK 全库检查属于显式 preflight，不是每个 reader 的初始化步骤。普通 Session Store 打开执行无写入的结构 preflight 后打开唯一 writer connection，不解码全部 Session 或 Artifact。

`loadSnapshot`／`loadSnapshotRecord` 在一次 read snapshot 内校验目标 Session 的 Workspace binding、snapshot checksum／identity／revision、事件 schema／连续顺序、Run start receipt 与 active Run 唯一性。已有事务内复用其快照，未开启事务时在本层创建并关闭只读事务；并发 writer 的提交只能在下一次读取观察到。不持久化“已验证”标记，不用校验缓存掩盖后续内容变化。Artifact 的长度、JSON 与业务完整性继续由所属读取边界负责。

[全局 owner 回归](../test/kite-home-runtime-storage.test.ts)覆盖目录读取不解码历史以及损坏 snapshot 在访问时拒绝；[Session 并发回归](../test/isolated/kite-session-runtime-storage.test.ts)在校验中让另一连接提交，核对每次读取只观察一个一致版本。
