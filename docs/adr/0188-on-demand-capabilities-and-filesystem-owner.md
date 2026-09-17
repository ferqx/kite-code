# ADR-0188：可选能力按需检查与文件工具独立归属

**Status**: accepted  
**Date**: 2026-09-16  
**Decision makers**: @chenchao

## 背景

required MCP 的全局就绪检查在用户消息已接收、模型尚未调用时创建持久等待，导致无关 Provider 故障阻止正常回答。普通文件工具注册在 Git module，掩盖文件能力与专用 Git Broker 的真实依赖。工作区信任还绑定 Git 外部 metadata，使 Git 路径变化阻止无关会话。

## 决策

删除模型前的 required Provider 全量门禁。真实工具使用继续受绑定、认证、项目批准和执行权限检查。保留实际 Provider Action，不把继续普通对话记录为用户豁免。旧 required 配置仅作为已有协议中的配置事实保留，不产生执行前置条件。

五个文件工具迁至既有 filesystem owner，保留操作与持久身份；删除专用 Git inspect、Broker、schema/SPI、功能开关及发布资格链。Git 命令沿既有 Shell 权限与沙箱执行。Seatbelt 不再通过 Broker revision 隐式开放用户 Git config。Kernel 支持的历史恢复事实继续可读，当前 registry 不再产生专用 Git 调用。

普通 Workspace Trust 只授权 canonical workspace，不解析或授予 Git 外部路径。历史明确批准的外部只读 scope 摘要保留，实际 sandbox preparation 重新解析并精确核验；路径漂移、解析失败或无 grant 返回零外部 roots。新信任或重复信任不扩大授权。没有历史 grant 的 linked worktree 隐式 Git 读取会被沙箱拒绝；显式外部 Git 路径继续走现有 Shell scope expansion，不新增专用 Git 授权框架。

旧全局等待只在已授权的继续入口按完整 journal、支持的历史写入路径和执行事实判断。匹配的 waiting Run 沿既有 State/Run/receipt 事务结算，再继续原任务；使用 cancellation，不写 waiver、不标记 Provider ready。只读历史不修复，未知外部结果不重放。

对结算提交后、模型派发前的崩溃，只在合法 session execution owner 下重建原 Run continuation。要求同一任务与 Turn、完整 journal 和 revision 一致、无真实审批/清理/未知 effect、无模型或工具派发事实。模型网关在出站前持久确认 invocation prepared 与 attempt started；出现任一相关事实就不推测重试。已有回执继续幂等返回，不重新创建消息或 Run。

## 替代方案与影响

不全量清空旧 pending，不重新发送原用户消息，不创建第二队列、数据库或启动扫描器。文件持久身份保持稳定，避免仅因 owner 改名迁移历史数据。普通工作区信任与外部能力授权分开；已拒绝的能力不会被转换成成功或不受限执行。

## 验证与回退

Builtin catalog、Service 回归、DesktopClient/stdio Service 与真实 TUI 故障场景覆盖客户端路径。macOS 原生沙箱验证未授权 linked metadata 拒绝、已授权 exact root 只读、父目录和写入拒绝。Host/Store8 故障测试验证原 Run 恢复与不重复模型请求；其他平台与真实用户故障样本不由本机 fixture 代替。

回退应回退代码变更并保留已经写入的真实结算事实，不伪造用户决定或重放未知操作。实际恢复规则与测试入口见 [Service owner](../../apps/kite-service/docs/runtime-application.md) 和 [Host mailbox](../../packages/runtime-host/docs/commands-mailbox.md)。
