# ADR-0185：会话权限设置按目标工作区准入

状态：accepted
日期：2026-09-14

## 背景

桌面允许通过同一连接读取不同项目的会话，但本机 App Server 将所有会话写命令绑定到进程启动时的 Workspace。已有会话权限选择因此在跨项目或未选择执行项目时返回 Unauthorized，与产品承诺冲突。

## 决定

`set_interaction_mode` 使用 Service 已持有的 Storage owner 读取目标会话身份，核对真实工作区、项目标识、持久摘要和最新 Trust 后，复用现有 Session Runtime 路由与命令事务。权限修改不要求重启服务或切换执行项目，也不停止其他任务。创建与启动任务继续遵循已有执行项目边界。

不删除工作区校验，不用客户端历史 membership 授权，不引入第二个会话索引、Store 或 Runtime。授权不足与 admission 不可用通过已有协议错误及 detailCode 分开表达，不新增协议方法或自动重放。

## 影响与证据

设置权限仍需要目标工作区及 Runtime 可用，继续保留 Session execution authority、revision 校验和持久回执。当前实现与验证入口见 [Service owner](../../apps/kite-service/docs/runtime-application.md#app-controlhistory-与-mutation)；[进程回归](../../apps/kite-service/test/isolated/app-server-process.test.ts)核对另一项目的活动任务不受影响、旧 revision 冲突及重启后权限持久保留。
