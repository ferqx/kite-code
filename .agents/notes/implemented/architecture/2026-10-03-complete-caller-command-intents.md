# Agent Note: 普通业务申请在首次 POST 前保存完整原意图

Status: implemented

## Problem

普通 Work、steer、follow-up 和取消申请同样可能在 Service 已提交之后丢失响应。只保 command ID 无法核对原主体、完整正文和准确目标；冷进程也无法证明自己仍有首次 POST 的资格。草稿恢复与业务恢复若混用，还会把后来编辑的文字误认为旧申请。

## Decision

CLI/TUI host 在 selected Profile 的私人 `ui/caller-intents.json` 中发布闭合 v1 申请。五种 DTO 分别保原 Store、Workspace、Session、subject、完整请求与原 request digest，取消申请保准确原 Command 或 Execution，TUI 另保实际草稿 ID、revision 和正文 proof。普通 CLI 可以没有草稿，因为其 argv 请求本身就是完整原意图。共享 UI 不读取私人路径、token 或 owner。

文件沿既有 profile-use、私人锁和本地发布约束：单硬链、当前用户、无跟随、0600、etag CAS、fsync、原子 rename 与目录 fsync；最多128条、16 MiB UTF-8 字节。容量与发布失败在首次网络提交前拒绝，不能驱逐 unresolved 申请，也不能将已有 unknown 降为未提交。

首次 POST 权利只属于当前进程刚成功持久准备的完整实际对象。CLI/TUI 用不持久化的 WeakSet，Native main 用 commandId 到冻结完整 intent 的 Map；Map 比较原 body/target/scope/draft 全部字段，不能退化为 IDs-only 集合。任何冷读、重复 prepare 或已存在的 prepared/submitting 记录均只能查原 Command；不能由文件 phase 重新取得 POST 权利。GET 只核原 scope、五种原 kind、subject、完整 request digest、准确原目标和必要 Run/source 关系。缺回执、连接失败或旧 SDK 缺强证明均保 unknown，不猜未提交，不自动换 ID 重发。首回执表示受理事实，不能表示 Run 或 Job 已完成。

Native Node 私人 SQLite v3 增加准确 `caller_intents(command_id,state)` 表，FULL/BEGIN IMMEDIATE 在首次 POST 前保存同一完整五类 intent；v1/v2 迁移保原行，main/preload/renderer 只通过有限 IPC 观察。最多128行、16MiB实际 UTF-8 state，总量或坏行在网络前拒绝。任何 lookup 都撤销尚未使用的热提交权；冷记录不因此重新获准。

strict manifest v5 保存 callerIntents.v1 的完整原字节与 Desktop v3 一致副本；v5 的 DB3 reader 逐行核完整真实 UTF-8、closed fields、原 PK/body/request digest、精确 target/draft/phase 和容量。该校验只证明私人 journal 的结构与字节，不证明 Service receipt 或 POST authority。旧 v2/v3/v4 保各自字段、物理路径和 Desktop 版本白名单，DB3 不能重标为旧 manifest。restore 生成新 Store 时保旧申请身份，原旧 scope 不能变成新 Store 的 POST 权限。这个决定扩展普通申请范围；[有限恢复 journal 的既有理由](2026-10-03-durable-caller-recovery-intents.md)及其 Native v2 表继续适用。

原人类答案不混入上述五类 DTO；后续准确 DB5 的独立 answer_intents 与 manifest v7，由[原答案资产决定](2026-10-04-original-human-answer-intent-assets.md)说明。原五类 caller、热提交权与旧格式边界继续适用，新的离线答案行不扩大查询或审批权。

## Alternatives considered

- 只存原 ID 和 phase：不能证明正文、主体与目标相同，拒绝。
- 将 prepared 持久状态当可重发凭证：崩溃窗口无法区分未提交和已提交，改为当前进程一次性权利。
- 让 renderer 或 UI 直接保私人文件、恢复 token：扩大宿主边界，改为有限 host port。
- 只存正文摘要或重用当前草稿：丢失原申请全文并混入后来编辑，保完整 body 和独立草稿版本。
- 满槽驱逐 unknown 或在恢复后重标 Store：会丢失唯一旧申请及旧效果关系，拒绝。

## Consequences

实际默认 Service 与 SDK 的真实 80×24 TUI、编译 paired/shared driver 已验证首准备、响应物理丢失、caller/service SIGKILL、首 GET 丢失与冷原查询：原 ID 和完整 UTF-8/CRLF 请求保留，冷路径零 POST，重复读取零新 Model。steer、follow-up、准确 Command cancel 与独立 Job stop 另有原 scope 断言。完整原稿不因后来草稿 Plan 切换而变化。维护组合验证完整 caller 资产、坏结构/硬链/权限/容量拒绝和新 Store 上的旧身份保留。

TUI 当前增量真实五文件11/223、纯库十五文件117/789，原二十七文件153/1358是各自冻结范围。普通 CLI 原完整 argv/JSON 与真实 Work 等待已另通过九文件30/589，并用实际 main 三例83断言核审批、唯一文件效果、最终 JSON 和正确配对关闭。Native ordinary caller 与输入/恢复/profile/模型设置/压缩邻接是十一文件37/296；随后真实五 DTO Electron 窗口新增五例20断言，核物理 POST/首 GET 丢失、main/所属 Service SIGKILL、冷 GET 前后原 Core Run/Execution ID 集合不增加和后来草稿保留。超过1MiB的合法 Workflow envelope 在未配置 Skill 时实际被拒绝，只证明完整申请与查回，不证明 Workflow 成功。维护 v5 五文件47/605含原七个真实 restore SIGKILL，DB3 专项五例60断言没有另冒称 caller 专项强杀。各范围不能相加为当前完整资格；正式 installed、完整 Workflow 冷窗口及 Linux/Windows 仍需实际证据。

原实现和日志归 [CLI owner](../../../../apps/cli/README.md)、[TUI owner](../../../../packages/ui/src/tui/README.md)、[维护 owner](../../../../packages/agent/src/maintenance/README.md)与[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。
