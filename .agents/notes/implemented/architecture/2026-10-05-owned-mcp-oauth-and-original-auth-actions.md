# Agent Note: Owned MCP OAuth and original authentication actions

Status: implemented

## Problem

默认 MCP 已有准确来源、批准、连接和原申请，但受保护 HTTP Source 无法在新装配中完成认证。旧 Manager 的独立 Store、自动 callback 后连接和持久 PKCE 不能直接承接当前 Profile、Store、physical Workspace 与普通 Execution 的身份。删除配置、取消登录或丢失回执也不能证明 Token 没有写入、远端没有撤销或本地已经删除。

已确认需求见 [TUI MCP 手册](../../../../docs/handbook/clients/tui/guides/mcp-and-skills.md)和 [V1.3](../../../../docs/plans/unified-agent-refactor-v1.md)。当前行为由[认证边界](../../../../docs/active/mcp-authentication.md)、[Service](../../../../apps/service/README.md)、[Agent config](../../../../packages/agent/src/config/README.md)、[Agent MCP](../../../../packages/agent/src/mcp/README.md)、[CLI](../../../../apps/cli/README.md)与[共享 TUI](../../../../packages/ui/src/tui/README.md)负责；本记录保存本轮取舍，不把局部认证资格当作完整 V1.3。

## Decision

沿默认 Service 的同一个 CredentialVault、native backend 和 Broker，增加闭合 `mcp.oauth` owned scope。真实 Profile access key、Store、canonical physical Workspace、Source、Server、raw/transport digest 与 auth profile 共同派生 account；Session 不加入材料域，但每次执行仍核原 Session/Execution 和当前准入。同 Workspace 后续 Session 可复用准确材料，恢复新 Store 或换根不自动继承。手工 `credential:<uuid>` 接口不能访问 owned account，也不能从配置引用推断共享 secret 的所有权。

Provider 的 private v1 材料保 tokens、client information、discovery、时间与随机 tokenRevision；state/verifier 仅在当前 flow 内存。完整材料限 64KiB，保存和读取共同接受实际 Broker 可消费的 ASCII Bearer 文法与 8000 字符边界。Broker 只发 opaque handle，每次 materialization 重读原 scope/revision；clear 后重新 Login 不会让旧连接借用新 Token。Vault 的每 key epoch 与串行 mutation 拒绝迟到 read。原生 put/remove 已开始后的取消不承诺零 publication；删除失败保本 Vault 的阻挡，不能宣称其他实例没有实际残留。

四种固定 `mcp.auth.login/refresh/clear/revoke@1` 是普通 runless Action，复用 C/E、许可、取消和原最终回执，没有 Auth journal、HostMutation 或第二套执行状态机。输入只收 `serverId/expectedReadSet`；实际 producer 核完整原 Command/Execution/subject/Store/Session/input/root-work。当前 status 读安全 policy/availability/presence；原 result 只读原 SQL 身份及完整 finalization，不读当前 Source、physical Workspace、Vault、transport，也不补写。applied、Token 保存、connection ready 和 Tool 许可分别证明。

原 Caller 复用 `ui/caller-intents.json`。首次完整 durable prepare 才有一次 POST 权，冷列表、重复和原 ID 查询不取得新写权；四个固定 Auth 请求才扩大该文件的闭合语法。实际资产含 Auth 时选择条件 backup v13，保 v12 物理资产和字段；旧 v2–v12 请求语法不扩大，没有另建认证备份资产。公开恢复保原字节、主体、Store/Session 和 phase，不 retag、不恢复热 permit。

所有 Auth 和已有材料恢复使用实际 Service 的同一个 WorkspaceSerialLocks coordinator，Source factory 在 Runtime 创建前绑定它；不同 Service/Session 共享同一 Workspace coordinator 的测试也使用该真实依赖。lease 持到原 owned operation 实际结算，deadline 先 abort，再 await 原 promise；不能用 race timeout 让仍可能写 Vault 的操作脱离所有权。

HTTP 普通 401 仅记录当前进程、准确 owned 域的有限 challenge，零 browser、callback、DCR 和旧 RPC 重发。省略 auth 才是 auto 候选；显式 none/manual 不升级。显式 oauth 需 enabled/admitted 后新普通 Login。使用低层 SDK discovery/PKCE/exchange，网络沿完整 DNS 公网判断、实际地址 pin 与 TLS 校验，拒绝 proxy、redirect 和秘密 query；网络或 policy throw 锁住失败，不能经 SDK fallback 绕过它。已有 Token 恢复只允许 proactive refresh，无 browser 或 DCR fallback。

Login 在 Vault available 后创建 127.0.0.1 随机端口 listener；callback 核精确 GET/host/path、唯一 code/state、constant-time state 与当前 Source。freshness 抛错需转有限 callback 回复和原 flow 结算，不能让 Bun server 未处理异常。listener 先 graceful stop 以 flush 有限响应，仍未停止才按 owned deadline 强关并 await 原 stop；network 和 opener helper 均实际等待。Revoke 保远端请求与本地删除的已开始阶段，取消或丢回应不会把已可能发生的效果写成 known cancelled。helper/lock/network 清理未确认保 unknown。Login 成功只证明 tokens 已保存，新 connect/reconnect 仍独立确认和许可，不重放旧 Task/Tool。

Remove 先在原 owned 域预检 availability 和实际 presence，声明发布后才清本地材料；没有当前 RAM challenge 也需检查 cold owned 材料。文件和 Vault 非原子，E 可 unknown、M 保 applied、Source phase 保 saved，但 credentialCleanup 必须独立报告。完整原声明回执及闭合 partial cleanup 同时验证才允许该历史投影；不回滚文件、不默认 remote revoke，manual shared Bearer 保留。disable/shadow/raw edit 不自动删除材料。相关[来源增删决定](2026-10-05-original-mcp-source-entry-mutation-intents.md)的四锁/CAS/历史理由继续有效。

普通 connect 的 failed opening 只在原 parent/Job 全身份、实际 terminal stopped/unopened 与同一 local owned transport 已结束后释放准确隔离 ticket。原子提交尚未完成、已损坏原身份、live transport 或 reconnect stop/publication unknown 均继续阻挡；不得借认证成功清除未知 fence。

## Alternatives considered

- 继续导入旧 McpCredentialStore/Manager：会承接旧身份、独立材料介质和自动连接语义；沿已有 Vault/Broker 与普通 Action，由当前 owner 明确派生 owned 域。
- 用 URL、Server name 或 Session 单独作为 account：不能区分同名来源、原 Store 和换根，或阻止同 Workspace 后续 Session 的准确复用；采用完整 owned identity，并保执行的独立 Session 核验。
- 直接调用 SDK 高层 auth/finishAuth：会把失败 RPC、browser 和恢复重试合成隐式流程；采用低层 protocol 与受控网络，普通 401 只产生新的 Login 资格。
- 为 Auth 新建 journal/backup 资产或扩大所有旧 manifest：会重复现有 Caller 原意图和改变旧语法；复用实际 Caller，只有含 Auth 的资产选择 v13。
- 独立 Auth mutex 或 timeout 后脱离原 promise：无法覆盖两个实际 Service 与仍可 publication 的原操作；注入现有 coordinator 并等待实际结算。
- callback freshness 异常交 Bun server 处理、finally 立即 stop(true)：前者实际出现未处理异常，后者实际使有限回复变成502；将异常归有限 flow 结果，先 flush 再按 owned deadline 收尾。
- Remove 删除所有 credentialRef 或只检查当前 auto challenge：前者会删除共享手工 secret，后者忽略冷保存的 owned 材料；仅按准确 owned account 预检和清理，声明发布与清理分开。
- 一律清普通 connect quarantine：会放过仍活动或未知 publication；只在原 terminal proof 和已停止 local entry 同时成立时释放准确 failed-opening ticket。

## Consequences

OAuth 增加原生材料、受控协议网络和短期 listener/helper 的生命周期成本。多介质效果不可原子，取消和清理故障可能长期保原 unknown；历史 GET 没有重新执行或修补权。私人 Source read-set 和 owned 域较严格，手工编辑、恢复换 Store 或同路径换根都可能要求新的批准/认证，不自动迁移旧材料。

[Session](../../../../apps/service/test/isolated/mcp-oauth-session.test.ts)、[Auth Actions](../../../../apps/service/test/isolated/mcp-oauth-actions.test.ts)、[HTTP ownership](../../../../apps/service/test/isolated/mcp-http-oauth-ownership.test.ts)、[默认 Source 集成](../../../../apps/service/test/isolated/mcp-source-oauth-integration.test.ts)、[实际生命周期](../../../../packages/agent/test/isolated/mcp/lifecycle.test.ts)与 [Auth Ink](../../../../packages/ui/test/tui/mcp-auth.test.tsx)负责有限断言。真实 AS/MCP loopback、SQLite、临时 backend、回复丢失和 owned 屏障的精确输入、红绿与正常排空见[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。实际 macOS synthetic native owned CRUD 只证明该命名空间的 write/read/remove/fresh absence；真实外部 AS、系统浏览器、OAuth PTY、Windows/Linux owned Vault 和持续 Soak 尚未取得资格。

本记录部分替代[旧凭据与 OAuth 决定](../../implemented/feature/2026-07-16-mcp-credential-store-and-oauth-session.md)的 Manager/独立 Store、持久 verifier 和 callback 自动连接路径；其 native/no-fallback、秘密隔离、loopback/state 与不重放旧 Tool 的理由继续适用。[scoped 默认来源提案](../../proposed/architecture/2026-10-03-scoped-default-mcp-sources.md)保留整体未完成范围，不由本切片改标整体完成。
