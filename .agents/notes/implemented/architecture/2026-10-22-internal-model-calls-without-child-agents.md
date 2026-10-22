# Agent Note: Internal model calls without child Agents

Status: implemented

## Problem

自动审核和标题生成曾复用 child Session／Run／Job carrier。内部材料因此成为普通子会话正文，进入子 Agent 目录、状态和配额模型；同名 review 又混淆代码审查类别与权限审核。用户确认只有通用子 Agent 机制，类别不建立独立 Agent 实现；自动审核和标题生成均不属于子 Agent。

## Decision

自动审核统一使用 authorization.check／authorizationCheck。权限系统保存原 Session 中准确 Command 与唯一无 Run Model Execution；标题生成由原命名 Action 创建 session.title 和同范围内部 Model。两者复用共享 Model 槽、输出链、取消与 owner 资源登记，不创建 Session／Run／carrier／聊天 Message，不触发普通子 Agent 的额度、目录、通知或完成义务。

普通 planExecution 继续拒绝任意 runless Model。两个内部入口分别核准确来源、父执行、Store／subject／owner／root work；权限检查继续核 target/attempt/定义/input/source/policy/controlReads、准确准备请求与完整完成结果。Model 元数据只接独立深拷贝，Provider 前复核实际输入与封存请求 hash；准备失败也结算原检查。大输出保持完整链和有限答案凭据，检查成功与真实人工 ceiling 分别证明，模型文字不能自报授权。

标题仍由原生命周期 Action 负责单次 marker、10秒取消、32KiB限制与 rename CAS；内部 Model 保留当前宿主与选定模型的权限 ceiling，申请共享 Model 槽前和等待后分别复核，最终派发原子核输入、定义及 controlReads；内部 Model 不复用主对话 Step checkpoint。无法确认停止时保存原 partial 与 outcome_unknown，晚结果不能改写未知或标题。权限检查从首次准备前登记并保留原配置，命名 Action 保有标题准备期；内部实际 Provider 退出后才释放 Model 槽和配置；标题配置 disposer 只执行一次。Runtime drain 等待真实调用及清理，不因外层超时／取消竞争已结束而提前关闭 Store；Provider 前最后复核取消。代码审查 review 只作为通用子 Agent 类别，主／子消息渲染保持统一。

旧 authorization.review child 历史不删除、转换或重跑。原 proof、Inspector、附件及冷接管保留准确只读验证；旧生产入口关闭。DB5 迁移只调整允许准确内部 runless Model 的约束，事务内保存原行与索引／触发器，提交前核外键，失败回滚。

## Alternatives considered

- 只在 Desktop 隐藏内部 child：拒绝，仍保留错误的子会话创建、调度与生命周期。
- 为权限审核另建专用 Agent 或独立 Loop：拒绝，违背通用子 Agent 边界，并复制执行与权限合同。
- 直接在权限分类器里调用 Provider：拒绝，会绕过持久记录、共享模型槽、准确取消与最终派发证明。
- 将内部 Model 塞入主 Run／Message 以复用普通接口：拒绝，会污染聊天、业务上下文与恢复 checkpoint。内部入口独立认证，Model Inspector 显式支持已核用途的 nullable runId。
- 迁移或清除旧审核子会话：拒绝，会失去原请求、结果、人工卡附件与授权溯源。

## Consequences

新自动审核和命名不增加子会话或子 Agent 数量，实际输入输出与检查决定仍可追溯。原权限、取消、未知、完整正文和历史只读边界继续生效。新源码、公共生成契约及真实 SQLite／Service／Electron 验证归对应 owner；本机资格不外推远端 Provider、其他平台或完整发布。

本决定部分替代[完整正文与审核 proof](2026-10-01-immutable-model-body-and-review-proof.md)中的专用 child 承载方式，以及[生命周期 Action](2026-10-18-run-lifecycle-extension-actions.md)中的标题 child 隔离方式；原完整 Artifact、准确授权、生命周期 Action、标题 CAS 与历史不可重跑理由仍适用。
