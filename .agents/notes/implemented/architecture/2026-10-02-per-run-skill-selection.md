# Agent Note: 单次命令保存 Skill 选择与父目录继承

Status: implemented

## Problem

共享 daemon 的多个调用者需要为各自任务选择已配置 Skill。把选择放在进程启动配置中，无法表达同一实例内并发 Run 的不同意图，也不能靠原 Command 查回准确选择。子任务重新按名称发现目录，还可能把新出现的同名项或新增配置带入父 Run 未选择的范围。

产品依据是 [CLI 的明确 Skill 请求](../../../../docs/handbook/cli/commands.md)与 [V1.3 §15.2](../../../../docs/plans/unified-agent-refactor-v1.md#152-skills-决定可加载知识和流程)：Skill 提供按需知识，不能增加执行权限。完整当前契约归 [Service owner](../../../../apps/service/README.md)，此 Note 只说明选择身份和继承边界的原因。

## Decision

`run.start` 与公开 `input.follow_up` 将可选 `selectedSkills` 原数组作为 Command 意图保存，沿用现有请求摘要、幂等回执和 Run 配置封存，不增加表或执行管理器。省略使用该次配置目录中的实际可用项，显式空数组选择零项；CLI 未提供选项时省略字段。名称与 ID 的解析归 Service，Core 只核有限形状。

Runtime 通过显式 `supportsSelectedSkills` 和实际 resolver 共同声明支持，Service 据此发布 `run_skill_selection`。旧固定宿主或未支持的自定义 resolver 明确拒绝选择，Client 在业务 POST 前核能力。私有 startup 的选择路径移除，避免两个同时生效的选择来源。

Service 在根和 child 快照顶层保存 `skillSelection.requested/resolvedIds`。有父 Run 的 child 只继承实际解析出的配置 ID，不重新解释名称；Runtime 提供原执行链上的最近父 Run，检查原 Store、Session、root work 与主体。缺失或损坏父 marker、父目录项已不可用时局部拒绝，不扩大目录。真正无祖先 Run 的可信宿主调用继续按其明确角色和当前配置装配；Action 在原 scope 捕获已注册的能力与权限绑定，后代不能从当前配置扩大父工具集合，所属后台监督保留 Runtime 资源租约。自动 report 与私有 child 续轮沿用原封存绑定；公开新 follow-up 按自身命令选择。

## Alternatives considered

- 保留进程 startup 选择作为请求字段的默认值：会让相同公开意图依赖不可见的进程状态，无法解释共享客户端差异，因此移除。
- 只要存在 resolver 就声明支持：自定义 resolver 可能忽略新字段，所以需要显式 opt-in，HTTP capability 不能单凭任意字符串伪造。
- 子任务重新使用父请求名称：名称不是稳定目录身份，同名或名称与 ID 碰撞可能改变匹配；继承准确解析 ID。
- 保存选择到新的 Session 或 daemon 管理状态：引入额外可变权威，与单次 Command 的取消、回执及并发语义不一致；使用现有持久请求和 Run 快照。

## Consequences

选择只缩小目录、按需查找和对应配置来源，不启用 Tool、不新增可信 root、不执行脚本、不改变权限或信任。新的公开任务可以换选择，旧 Run 的事实不被重写。未知回执只查原 Command；冷读取不重新发现或调用模型。新增字段不提供旧数据兼容分支，未携父 marker 的旧配置不获得默认扩展范围。

验证范围与实际执行结果归[实施证据](../../../../docs/plans/unified-agent-refactor-v1-progress.md)，本决定不代表完整 V1.3、正式入口迁移或三平台发行已完成。

目录与局部可用性现由[同源目录决定](2026-10-02-scoped-skill-catalogue.md)补充：坏项不阻未选任务，但显式选择和继承必须准确失败，不能换成同名项。该补充不改变原Command选择身份与父范围约束。
