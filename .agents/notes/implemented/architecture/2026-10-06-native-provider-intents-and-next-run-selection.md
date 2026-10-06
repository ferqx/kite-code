# Agent Note: Native Provider 原意图与下一次模型选择

Status: implemented

## Problem

Native 的 Provider 配置与下一次模型选择需要沿统一 Service/Client 边界完成实际请求，而系统凭据库、JSONC 和桌面私有库是三个独立介质。回执丢失、保存后刷新失败、活动运行中的下一次选择以及冷启动不能通过当前 UI 状态推导原效果。新增私有格式也不能使既有离线备份失效，或扩大旧格式的请求语法。

## Decision

协议 family、endpoint 与模型名称明确绑定。四类 Provider 共用公开设置入口；手动名称不发现，空名称只在显式保存时请求完整列表。新模型 disabled，保留其他连接。模型名称不决定 family，列表响应不授予实际模型执行资格。

vault 保存和 JSONC CAS 分别记录结果。Core 的原 provider marker 绑定完整非秘密 readSet/operation 与原身份，秘密只用于一次热传输和 Service 私有 HMAC。已存而未发布保留准确凭据引用供认证 SDK 明确 revoke；未确认介质结果保留 unknown，不自动回滚或重发。Main 在首次 POST 前 FULL 保存原非秘密申请，冷行只允许原命令 GET，renderer 不获得 opaque revoke authority。

每个 Store/Session 仅保存下一次模型偏好；新 Session 在首次原输入落库前不绑定模型。临时 effort 只在页面会话状态中，切换模型或刷新后清除。start/follow-up 原请求冻结选择，经真实 HTTP 投影进入 root 的配置快照与实际 SDK wire；普通 active steer 保持文本语义，child 按自己的角色 preset。全局默认与活动 Run 不随页面选择修改。

Desktop DB6 保留原六表，新增配置原意图与模型路由。离线 manifest v14 专属真实 DB6；独立 Agent codec 核全部闭合字段、严格字符串 enum、原 UTF8/PK/身份/摘要。旧 v2–v13/DB1–5 grammar 不扩大，冷恢复不将原元数据转为 POST authority。当前负责合同见[Native owner](../../../../apps/desktop/README.md#native-provider-与下一次模型选择)、[Service owner](../../../../apps/service/README.md#native-provider-与下一次模型绑定)与[维护 owner](../../../../packages/agent/src/maintenance/README.md#desktop-db6-与-manifest-v14)。

## Alternatives considered

- 依靠模型名称或静态模型目录选择协议：名称和自定义 endpoint 不提供该身份，不能保证原实际请求，采用明确 family。
- vault 或配置失败时自动撤销另一介质：未确认写入可能已产生效果，补偿还会产生独立未知结果；采用两介质原事实及显式准确 revoke。
- 将页面 effort 写入全局配置：会改变其他会话和后续默认行为，不符合临时选择生命周期；采用原输入语义和本次冻结快照。
- 给现有 manifest v13 增加 DB6/effort：扩大已发布闭合格式，削弱旧版本反例；采用新 v14，并分别保留历史格式和当前 DB6 的实际 owner 验证。

## Consequences

非秘密 journal 保留核对身份而不保存密钥；冷打开无法自动完成未知 Provider POST。Session 模型偏好可跨进程保留，临时档位仍只在页面中；原 Command 中的 effort 属于真实原请求和历史证明。Provider 远端拒绝按单次实际请求失败处理，不切换或重试。

[默认 Native 窗口](../../../../apps/desktop/test/isolated/native-provider-bundle.test.ts)已核 macOS 源码外搬迁制品、默认 OS vault、四 family、7根Run/8请求、活动冻结、首次绑定、冷原GET与正常所属 PID 退出；[实际 HTTP](../../../../apps/service/test/isolated/run-model-selection.test.ts)核原请求、wire、配置摘要、恢复与 child preset。[DB6 离线测试](../../../../packages/agent/test/isolated/maintenance/desktop-configurations.test.ts)核真实 Node 保存、create/inspect/新Store restore、原路由/完整 effort 请求与零HTTP，以及秘密/错误类型/坏UTF8拒绝。历史 fixtures 只在新增两表为空时物理保留 DB5，不丢弃当前数据。证据不外推付费模型、系统 modal 点击、签名安装、MCP完整窗口或其他平台。
