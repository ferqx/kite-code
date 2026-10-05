# Agent Note: Skill Workflow 的业务扩展与原执行证据

Status: implemented

## Problem

既有 Skill Workflow 具有双特性开关、显式与隐式激活、inline/fork、结构化输出和独立验证。知识目录与 `selectedSkills` 不能表达这些行为。迁移必须保留这些已有行为，同时遵守 [V1.3](../../../../docs/plans/unified-agent-refactor-v1.md) 的唯一 Loop、普通权限与受控子操作，不能把未来 WorkflowEngine 作为已有能力的替代。

动态激活和完成会写业务记录；如果把这些内部状态变化直接作为原 Model 决策的 source 内容，工具在创建 fork 或 verification Job 时就会因自身写入触发 `context_refresh_required`。取消来源新鲜度检查又会放过权限等待期间的真实文件变化。

## Decision

在 Agent 的显式 `skill-workflow` 业务 leaf 编译与注册原契约。Core 仅保存具版本的通用 `extensionInputs` 原始意图与摘要，不解释 Skill；默认 Service 在凭据和 Provider 前验证实际可信配置、开关及输入，再由纯 Run initializer 创建不可变 activation 与必要约束。

初始化 anchor 只保存原 revision、输入摘要和激活身份，不把完整契约与输入塞入受限 metadata record。原 Command 与配置快照保存完整事实，可信宿主在冷绑定时从原请求重建输入并核 anchor 摘要；缓存缺失或内容不符不能获得执行资格。大正文沿既有 Artifact 路径完整交付。完整可信配置在 root start、follow-up 和 child 使用一致保存语义，保留完整请求摘要和子激活全等；Worker 背压、公开正文和 metadata 限制仍分别有效。

目录和用户初始化意图提供稳定的上下文内容；动态 inline 的完整指令由原 ToolResult 交给同一个 Loop。capture 仍重核活动和待核验 activation 的原文件、物理身份与依赖，内部状态更新不改变 source 字节。已完成且已有准确 proof 的契约保存原事实，不因为后续无关文件变化重新成为活动约束。

fork 使用普通 Agent operation 和原 carrier 的完整结果，能力范围由真实 parent Execution 与封存 parent Run 在子配置中缩小。输出必须是符合原 Ajv schema 的完整 JSON 对象；失败记录 invalidated，模型随后提交一个相似对象不能代替原 fork。verification 使用普通受监督 Job 或准确 schema proof，完成条件核原 Store、Session、Run/parent、定义版本、输入摘要、结果 revision 与原 operation。脚本 Job 的输入不能带任意命令或路径，超时必须等待 guardian 的真实停止事实。

## Alternatives considered

- 把旧动态命令转换为 `selectedSkills`：知识选择没有 activation、输出和完成义务，会遗漏已存在的产品行为。
- 在 Core 增加 Skill 状态机或特殊成功规则：会使后续业务继续修改通用执行核心，因此使用 namespace records、普通 Tools/Jobs 和必要条件。
- 对 nested operation 跳过 freshness，或重新捕获并接受全部 sources：会把审批等待期间的外部变化一起接受，无法证明原决定仍有效。
- 建立通用内部状态 rebasing 协议：需要额外识别合法记录转换与原外部来源，并处理每个冻结 closure；当前稳定业务来源可以解决已证实冲突，无须扩大 Core 协议。
- 仅把 Skill 能力范围写入 child prompt：不能限制真实 Tool/Job，故必须在可信 child resolver 和权限交集实施。
- 把完整指令和输入复制进 initializer record：实际大正文在首次 Model 前触发 metadata 大小拒绝；保留 metadata 边界并用原完整事实的摘要绑定，不能截断正文。
- 为 Workflow 另造 child/follow-up 快照裁剪协议：完整可信配置在 root 已被允许，另两条路径的配置1MiB守卫没有产品依据；两种非业务Store消费者证明去除该不一致仍保完整摘要、配置冲突和冷读。
- 共用 Ajv 全局注册表：真实重复 `$id` 冲突且可能借用另一Skill的定义；逐schema编译保局部 `$ref`，拒绝 `$async` 防止Promise被同步路径当作通过。
- verifier 通过内部相对路径导入 Shell 实现：实际完整包把带资产相对路径的函数移入共享chunk；使用既有公开leaf保留运行资产归属，不增加源码或系统目录fallback。

## Verification and scope

真实 SQLite 与固定模型验证显式/隐式激活、严格输入/输出、双开关、动态完整指令、原 fork 结果与失败失效、普通权限与准确验证 proof。compiler 独立 Ajv 注册表与异步 schema 反例已修复；Runtime 29项172断言包含真实业务实例冷重建。默认 Service 12项覆盖原公开意图、零凭据/Provider拒绝、最低审批、真实 child 能力缩小、脚本 Job、来源/资产漂移及大正文 fork/follow-up。普通非 Workflow Store 两文件14项179断言核大配置的原摘要冲突、幂等与冷读。冷业务实例测试不冒称操作系统崩溃后的整条恢复资格。

源码树外完整包按21个公开入口构建，1项54断言通过真实 Worker、guardian、Service/Client、Workflow compiler及完整备份恢复。首次打包因 verifier 内部相对 Shell import 导致共享 chunk 的资产定位漂移而失败；改用公开 jobs/shell leaf 后，完整包与真实 verifier 8项90断言通过。冻结统一回归268个作业通过；完整26workspace build/typecheck通过，随后受影响Agent重建和类型检查通过。实际环境为macOS arm64、Bun1.4.2、临时profile、固定模型；详细首失败与修复证据见[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。

本决定交付业务 leaf、普通核验及可信 Service 接线。终端动态命令、自动修复/补偿、准确 waiver、其余冷恢复和平台资格仍须按原产品行为继续迁移；不是完整 Workflow 或 V1.3 完成声明。

## Consequences

来源复核不构成与外部写者的文件系统原子事务。可信进程内实现仍是宿主代码，Skill 文本不能赋予能力。脚本需要当前已核准的进程监督装配，不能把 POSIX guardian 冒称沙箱或其他平台资格。原未知执行结果不自动重试，持久 operation 查回不建立第二次效果。
