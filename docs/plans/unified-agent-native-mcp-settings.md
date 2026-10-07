# 通用 Native MCP 完整设置与原操作

状态：已确认设计，实施中。

本方案承接 [V1.3 主线](unified-agent-refactor-v1.md)和[当前进度](unified-agent-refactor-v1-progress.md)。产品预期由[桌面手册](../handbook/clients/desktop/README.md)与[扩展专题](../handbook/features/extensions.md)定义；现行 Source/Auth/连接安全语义由 [Service owner](../../apps/service/README.md)、[MCP owner](../../packages/agent/src/mcp/README.md)和[认证边界](../active/mcp-authentication.md)维护。

## 当前差异与目标

基线 `2902c581` 的正式 `apps/desktop` 设置只提供 Provider/Model，尚没有 MCP 阅读和管理入口。既有 Service/SDK 已提供安全目录、有限来源增删、范围选择、项目来源批准、既有手工凭据引用绑定、四个 OAuth Action、连接/目录刷新/强制重连和不可变工具 metadata。旧 `apps/kite-desktop` 的 MCP 页面不是当前正式消费者，也不能恢复其 AppControl/State/Host 路径。

本片交付一个完整 Native MCP 设置页及其实际操作流程：完整安全目录和来源/选择/认证/连接事实；用户或项目范围的选择与有限来源增删；独立 Source Review；Login/Refresh/Clear/Revoke 与准确业务取消；独立连接、目录刷新、强制重连；原工具 snapshot 分页与完整 descriptor；已提交原操作的明确查询和冷恢复。离线、未登录、未批准或坏源保局部原因，无关普通对话继续可用。

## 产品行为与接口交接

- 阅读以当前真实 Session/Workspace 为范围，没有当前 Session 时说明所需选择，不隐式创建会话。设置页关闭、换 Session/Store 或迟到响应只撤销自己的 reader，不取消业务 Execution。
- Main 冻结实际 Store/subject/Session/Workspace identity、观察代次与完整 read-set。renderer 只提交观察 ID、来源 ID、有限操作参数和明确范围；不能提供路径权威、subject、任意 extension/request、原 read-set 或秘密。
- Source Add 沿现行正式合同只接受 HTTP URL 或绝对 stdio command，Remove 保准确 raw-entry digest/preview；选择不批准项目来源。手工 binding 只批准或撤销配置中的既有 opaque Ref，不创建 secret 输入或 raw source editor。
- 普通 Action、Source Review、连接 Job 和实际 remote Tool 各自授权。Source approve/bind 问题使用准确原定义、版本、kind、read-set 与闭合 decision；现有答案 journal 只保存这一非秘密决定。
- Auth 成功只说明原认证结果；随后独立新连接。Cancel 只取消准确原 Execution，关闭面板不产生 Cancel。Refresh 不升级 Login，401 不自动打开浏览器或重放 RPC。
- 每次写操作先 FULL 保存完整非秘密原 body、两个不同 canonical SHA、原 scope/subject/key 和阶段，再持有本次首次 POST 权。冷启动/列表/选择零自动 GET/POST；明确查询只查原 IDs。未知不重建 ID、不回滚、不重发。
- Select/Refresh/既有手工 binding 沿原 C/E/Interaction/HostMutation 的闭合证明核原结果；Source/Auth/Connection/Reconnection 沿各自正式历史 Query。Command applied、当前目录 bound/presence 或当前连接就绪不能单独证明原操作成功。foreign Store 记录保原字节和身份，在 HTTP 前拒绝，不能重标为当前 Store。
- 工具详情沿不可变 snapshot/origin/indexDigest/Artifact 与现有 Client 全文 hash/EOF 读取；Main 分块交付完整内容，renderer 不接触文件路径或 Artifact 读取权威。阅读零连接/授权/远端 Tool RPC。

## 模块与持久格式

1. Client 新纯 leaf 提供当前 MCP DTO、闭合 Query decoder 和固定 Command canonical；无 Node/UI/CLI/Agent runtime 依赖，旧 caller grammar 不扩大。
2. Native Main 新 manager 拥有观察、有限 IPC、提交/原 GET、结果证明、准确取消和 descriptor reader；renderer 增加 MCP 设置页与 Source 专用 Review。
3. Desktop 私有库升级 DB7，在保留原八表和 DB0–6 迁移的基础上新增 `mcp_intents(command_id,state)`。原非秘密申请有独立 128 行/16MiB 上界，坏行保字节并拒绝写，未知不淘汰。原 caller/配置/答案表语法保持。
4. Agent maintenance 增加独立 Native MCP codec 与专属 manifest15/DB7 采集、校验、inspect/restore；旧 v2–v14/DB1–6 白名单和语法保持。历史 fixture 只在新增表为空且当前 owner 关闭后降成它要证明的历史物理格式，不能丢弃真实新资产。
5. 产品/Native/Client/Service/maintenance owner、认证与当前通用边界同步实际已交付事实；长期 Main/renderer/原申请取舍用对应 Agent Note 维护。

## 实施与验收

按共同协议→Main/持久与维护→renderer/Review→实际窗口整合推进，公共接口确定后可把不重叠文件交给独立 Agent。Root 唯一 Git owner，独立非参与者审查当前 diff/需求/证据。

必要验收覆盖：全目录/空与坏源/完整 descriptor；换 scope/关闭/迟到隔离与阅读零业务 I/O；user/project 选择及来源 Add/Remove/approve/bind 的原 CAS/注释/独立结果；真实 stdio/HTTP 连接 Job、目录刷新和强制重连旧 stop fence；四个 Auth Action 与准确取消；下一真实 Model schema/独立 Tool Ask/一次效果；丢回执后原 GET、重开与 foreign 零重发；实际 Node DB7 公共维护 v15 与历史拒绝边界。

实际系统浏览器/default OS vault 组合单独取得本机资格：自有 HTTPS AS/MCP、真实默认 opener 与默认 backend，浏览器导航到原 callback、PKCE/code exchange、fresh Service 读取已有材料且 browser/DCR 不增长，准确 cleanup 后再 fresh reopen 验证 absence。可信 fixture 网络组合必须在构建前固定并计入制品身份，不改正式网络策略、不注入 opener/backend，也不把直调 callback 当浏览器证据。当前本机默认Chrome；CUA未暴露该浏览器控制，若浏览器生成证书警告，必须由用户处理。自有HTTPS准备页到达后再启动保持原120秒callback的正式Login；没有opener/backend替身、fetch callback或系统信任修改。原入口已经取得本机组合passed，准确证据归[进度](unified-agent-refactor-v1-progress.md#2026-10-07native-mcp-chrome-与默认-vault-验收)。

代码、数据或接口改变后重新判断旧证据；不扩已闭合 Provider/Plan/普通问卷矩阵。必要有限测试、正常 types/build/API/边界/文档门禁与阶段收束当前原完整默认保持。当前方案不证明外部账号/AS、签名发行、其他平台、正式持续 Soak、完整 §35 或旧源码最终退役。

## 当前状态

公共 Client leaf、有限 Native Main/renderer 与 Source Review、DB7/manifest15 已完成集成。纯合同、DOM、实际 Node 公共维护备份/恢复、真实 Service/HTTP 61条断言与 macOS 源码外 source/transport 窗口18条Bun断言已通过；窗口另核完整Unicode descriptor零额外RPC、独立Ask、下一Model schema/一次效果和冷原GET零POST。最初595文件/474任务的完整默认及前三次真实失败保留于[集成进度](unified-agent-refactor-v1-progress.md#2026-10-07native-mcp-完整设置集成与实际窗口实施中)；当前615文件/489主作业完整默认通过的运行输入未变，本机实际Chrome/default OS vault四Auth、准确取消与重启复用/清理后absence另以原入口passed取得资格。新的整片独立审查仍受工具线程额度限制，root自检不替代；本方案保留至独立审查与阶段收束完成，之后归位并删除。其他平台、外部AS/账号与整个重构不由本机结果关闭。没有需要改变现有产品语义的待决事项。
