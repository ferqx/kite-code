# ADR-0183：启动只做结构检查，按会话读取做恢复校验

状态：accepted
日期：2026-09-11

## 背景

用户要求本地服务连接与首屏目录在 300ms 预算内完成。实际隔离副本测量发现，约 269MB 的数据库在每个 reader 构造时重复运行全库 physical/FK 检查，之后又统一解码全部 Session 和 Artifact；这使纯目录启动随全库历史体积增长。

## 决定

普通 Session Store 打开仍核对文件权限、路径、精确 DDL、marker 与 epoch，沿用唯一 connection／writer。完整 physical/FK 检查保留在显式文件 preflight。恢复目标 Session 时，在同一 read snapshot 内核对其绑定、snapshot、事件、Run 与 receipt；其他 Session 的正文不成为目录读取的前置条件。Artifact 在其 typed reader 访问时验证。

不建立数据库健康缓存、后台全库验证任务、迁移状态或第二 reader 进程。读取成功只证明实际访问的范围，不能宣称未读内容健康。并发写入按 SQLite snapshot 隔离，下一次读取重新校验当前事实。

Service 程序仍逐次完整校验 SHA-256，使用现有算法支持的加速实现。Tokenizer 的词表初始化推迟到第一次真实计数，计数结果与授权语义不变。

## 影响与证据

损坏内容在对应读取／恢复边界报错，不要求整个应用先拒绝启动。当前机制与并发回归见[存储 owner](../../packages/runtime-storage-sqlite/docs/transactions-and-state.md#按会话恢复校验)，性能样本与窗口验证限制见[Desktop 启动](../../apps/kite-desktop/docs/history-and-recovery.md#启动预算与验证边界)。
