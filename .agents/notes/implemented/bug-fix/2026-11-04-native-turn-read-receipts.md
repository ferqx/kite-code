# Agent Note: 桌面完成提醒使用私有 SQLite 保存已读记录

Status: implemented

## Problem

用户确认已打开阅读的会话在完整退出后再次出现蓝点。原实现把记录放在 renderer localStorage，开发客户端每次随机端口改变 origin，原记录因而不可读；在同一 DOM 重挂载的测试没有覆盖此边界。用户要求优先使用数据库。当前产品行为归[桌面手册](../../../../docs/handbook/clients/desktop/README.md)，实现归[Native owner](../../../../apps/desktop/README.md#native-项目会话目录)。

## Decision

沿既有 desktop-private/data.sqlite 增加 DB12 的 session_read_turns，以 Store／Session 为主键保存最后已读 Run ID 和终态。Main 核原选择、准确 Store、Run 终态与目录后原子提交，renderer 等提交成功才消点。未知读取不假造未读，失败写入保留提醒；不把本机阅读偏好写成业务事件。

## Alternatives considered

- renderer localStorage：简单，但随机启动端口和制品地址变化不能保证读到同一份记录；本次实际故障已证实此限制。
- 单独的本机 JSON 文件：可避开 origin，但重复私有路径、原子写入和格式核验，而现有 SQLite 已承担这些职责。
- Service 业务数据库：适用于未来明确的跨客户端已读同步需求，目前会扩大主体、同步和公共写接口范围；用户本次确认的是本机重启保持。

## Consequences

记录随原 Profile 保存，不受 renderer 地址改变影响，不产生业务操作、更新时间或执行权限。DB12 惰性迁移保留既有草稿、队列及 journal，未知私有格式继续按原规则拒绝；业务 Store 和工具协议不升级。没有可读旧 origin 的记录无法凭空重建，用户再次打开核实后写入新记录。

[SQLite 进程回归](../../../../apps/desktop/test/isolated/native-turn-read-store.test.ts)、[页面回归](../../../../apps/desktop/test/isolated/native-session-shell-dom.test.tsx)与[主进程回归](../../../../apps/desktop/test/native-caller.test.ts)分别覆盖真实冷保存、跨 origin 页面恢复及保存门禁。实际窗口与平台验收范围沿 Native owner 记录，不由测试文件存在推导。
