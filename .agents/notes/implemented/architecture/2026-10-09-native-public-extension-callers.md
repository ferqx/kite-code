# Agent Note: Native公共扩展沿原申请权利与显式格式升级

Status: implemented

## Problem

公共扩展的目录、Action、Query和通用结果已经存在，但正式Native用户不能通过原页面完成整条能力。接入后若只保存ID、让冷状态重得POST权利，或把新扩展请求悄悄加入旧私有格式，会破坏原申请查回和旧代码拒绝未知语法的边界。通用结果动作还必须对应实际读到的原结果，目录刷新不能把旧坐标绑定到新的观察。

## Decision

正式Native用同一公共Client、Main观察与共享表单／PublicView。Main冻结完整准入与选择范围，目录或Query完整EOF后才有对应观察资格；原结果动作同时核原坐标和完整input。刷新与切换撤销动作资格，保旧完整结果只读。参考mini-review只在明确测试候选hash前装配，不进入默认产品。

Native局部Caller union增加公共ExtensionCommandRequest，原CLI／TUI五类和固定Auth合同保持。新申请复用原CallerJournal、caller_intents表、完整原文和两个摘要；只有本进程首次成功持久准备的原对象取得一次热POST权利，重复和冷记录只GET原Command。公开受理与实际Execution终态分开，unknown或准备下一attempt不能清除。恢复保原Store／subject，不retag或重放。

仅首次保存这类申请才在同一FULL事务惰性升DB9；原DB1–8的Caller语法不扩大。离线维护仅closed manifest v18接纳DB9，继承原资产白名单而不新建journal；旧manifest不能重标接收新语法。[原完整申请决定](2026-10-03-complete-caller-command-intents.md)的首次／冷权利及正文理由继续适用，[Workspace DB8决定](2026-10-08-workspace-removal-and-orphan-gc.md)仍负责原移除与清理边界。

## Alternatives considered

- 扩大共享五类Caller DTO：普通CLI／TUI没有本次正式扩展消费者，扩大它们的旧文件语法无实际需要；选择Native局部union。
- 保DB8并直接接纳新kind：旧DB8标签会失去原闭合含义；选择惰性DB9和专属v18，不提前升级未使用的Profile。
- 独立扩展journal和重放队列：复制已证明的正文、热权利、容量和冷查回机制；复用原表与inflight，不把journal作为独立能力目标。
- 以新目录观察调用旧结果动作：同一个viewIndex不能证明相同结果；独立保结果观察，刷新后重查才恢复动作。

## Consequences

用户可沿正式页面完成schema动作、准确状态、Query、完整finding、原结果动作和新明确业务身份；任意扩展仍需可信宿主注册与权限分类，目录展示不授予执行权。实际公共HTTP链、原DOM、真实Node DB9备份恢复和源码外安装窗口各证明对应边界，不代证旧writer运行DB9或全部平台。新格式的旧代码运行资格继续属于版本交接缺口；完整PC、资源负载与最终退役保持原阶段门禁。

当前实现与验证分别由[Native owner](../../../../apps/desktop/README.md#native-公共扩展完整能力)、[maintenance owner](../../../../packages/agent/src/maintenance/README.md#desktop-db9-与-manifest-v18)和[本轮进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09正式-native-公共扩展完整能力)维护。
