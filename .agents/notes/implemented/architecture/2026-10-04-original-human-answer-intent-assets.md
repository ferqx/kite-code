# Agent Note: 原人类答案在首次提交前保存独立私有资产

Status: implemented

## Problem

审批、问题和计划评审的答案可能已被 Service 保存，但 Main 在收到响应之前退出。只在 renderer/controller 保存答案或 commandId，冷 Main 无法核对原正文、主体、Interaction 决定版本与回答展示范围；从当前卡再答一次又会创建另一命令。把人类答案塞进普通五类 caller 或旧备份格式，会扩大已闭合请求与 SQL schema 的合同。

## Decision

[Native answer journal](../../../../apps/desktop/electron/answer-journal.ts)在既有私有 Node SQLite DB5 中增加准确 `answer_intents(command_id TEXT PRIMARY KEY,state TEXT NOT NULL)`，保完整原答案请求、body/request canonical SHA、subject、Store、Workspace、presentation Session、context selection，以及 Interaction 的实际来源 Session、Execution、Run、revision、kind、attempt、definition/input/policy 元数据。展示根与 child Interaction 的实际 Session 分别保留，不能强行将两者改成相同身份。FULL/BEGIN IMMEDIATE 提交原行之后，本次热意图才有一次 POST 权利；保存失败零 POST。

单行最多4MiB，全部128行/16MiB UTF8；容量、未来格式和坏结构明确失败，不裁正文、不驱逐 unknown。热许可仅存在当前 Main 内存，持久 submitting 在冷开时仍为 unknown。冷 journal 没有答案 POST 方法，不由 prepared/phase 或旧观察重新取得发送权。同一原 Store/Interaction/revision 不换新 commandId；冷 UI 只展示有限原身份、摘要与原 GET 操作，不把完整答案或私有路径交 renderer。

原 GET 先核实际 admitted Store/subject、原 presentation Session/Workspace，然后只查原 Command。只有准确 `interaction.answer` 的 applied/`answer_saved`、原 target、decision revision+1、subject 与 canonical request SHA 全部匹配才确认；accepted、错 kind/target/版本或缺事实保 unknown。查询不改绑当前 selection，也不恢复旧附件的完整 EOF/hash 读取证明或授权。新审批仍要当前观察与完整附件 gate。

[维护 owner](../../../../packages/agent/src/maintenance/README.md)以 closed manifest v7 接纳准确 DB5，并沿原私有 SQLite VACUUM INTO 一致副本保存答案表。独立 [validator](../../../../packages/agent/src/maintenance/desktop-answers.ts)只依赖 Agent 自身和 SQLite/Node 端口，逐行核 SQL PK、全部闭合字段、实际 BLOB UTF8、两种原摘要、target 唯一及容量。旧 v2–v6 的字段、表与物理格式不扩大。新 Core Store 恢复保 UI 旧 Store/subject/请求/phase 原字节，不生成热许可、不发送答案、不把本地行当 Service receipt；`coverage.profileComplete:false`、vault 排除与跨介质非瞬时原子保持。

此决定扩展 [普通 caller 的既有取舍](2026-10-03-complete-caller-command-intents.md)，其五类 DTO 与首次热许可理由仍适用；[离线备份](2026-10-02-offline-profile-backup.md)与[独立文件恢复资产](2026-10-04-file-recovery-boundary-and-intent-assets.md)的稳定锁、准确格式及旧身份理由继续保持。

## Alternatives considered

- 只保存 commandId/phase：不能核对完整答案、主体与实际 target，保完整原请求及摘要。
- 冷 Main 根据 submitting 再 POST，或从当前卡生成新 ID：崩溃窗口不能区分未提交与已提交，冷路径只能原 GET。
- 将答案加入现有五类 caller 表或重标旧 manifest：混合不同请求/receipt 合同，采用独立 DB5 表与 v7 准确声明。
- 只核整个 SQLite 文件 SHA：可重新计算外层 proof 掩盖坏内部行，独立重算 canonical 摘要并核全部字段。
- 恢复旧附件已读证明或将旧 Store 改成新 Store：本地资产不具当前观察与授权，保原身份、显式 unavailable。

## Consequences

答案是独立私有 UI 资产，增加一个准确 schema 与有限冷查回面；Core 命令/决策事务和授权没有转移到 UI。容量耗尽会在提交前拒绝，当前格式不静默清理历史行。维护保存一致私有 SQLite，而不是把它与 Core 配置采集宣称为同一跨文件事务。

2026-10-04 macOS 的纯/实际 Node 组合13项164断言、相邻8文件38项358断言通过；真实40卡与双Main组合2项6条Bun断言通过并保 driver 内部断言。冷 Main 专项1项3条Bun断言，实际 Main SIGKILL 后原 GET 两次、cold POST零，原 Run completed、原 Execution 效果账本一行。POST 丢回执 hook 转发真实 SDK 后丢响应，不宣称物理 socket 丢包。维护7文件55项751断言通过，真实三类 unknown 答案包含312022字节 Unicode/CRLF，新 Store 冷 Node 原行完整且零HTTP。源码入口和复现归 [Desktop owner](../../../../apps/desktop/README.md)、维护 owner 与[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。

这些证据只覆盖本机 owned Node/开发 Electron 和离线资产。正式 Windows Main 仍受 [加载根身份提案](../../proposed/architecture/2026-10-04-windows-node-owned-profile-and-artifact-leases.md)的 fail-closed guard；实际 Windows ABI/文件生命周期、Linux/Windows 窗口、发行引擎和完整 §35 尚未取得资格。
