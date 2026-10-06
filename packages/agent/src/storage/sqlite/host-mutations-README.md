# 有限宿主外部操作 Journal

`beginHostMutation/finishHostMutation/getHostMutation` 仅供宿主配置/凭据管理审计，不关联 Session owner，不授予执行能力，也不替代配置文件 CAS 或 vault 权威。新增 host_mutation 表是十六张 core 表之外的有限外部操作日志。

begin 核原 Store、commandId、subject、闭合 kind/scope 与 requestDigest。只有 created=true 的首次 pending 登记可由宿主实际执行一次外部 I/O；同 ID 同绑定重试 created=false，pending 只能诊断，不自动重做。finish 是 pending→applied/failed/outcome_unknown 的短事务 CAS，相同终态/receipt 幂等，不同结算冲突；原终态不能被普通失败覆盖。跨原 Store/subject 查询拒绝，readonly get 不写。

支持 config.user.write/config.workspace.write/config.repair/credential.put/credential.revoke。配置 safeRequest 只有 scope/workspaceId?/ifMatch 与 write 的 operationCount；workspace scope 必须准确等于真实 Workspace ID。凭据只留 user scope、os/temporary persistence、revoke 的 vault 规范 opaqueRef。完整操作内容和 credential plaintext 不入数据库；requestDigest 由 Service 的私有 profile HMAC key 对完整语义生成，Store 保存 64hex，不能伪称验证外部文件 CAS。

receipt 为闭合集：config 仅 status/code/etag；credential 仅 status/code/opaqueRef/persistence/revoked。opaqueRef 复用 vault 的 credential:UUID 格式，code 是有限原因标识；没有 raw error、secret、配置值或 arbitrary 文件路径字段。所有查询与终态仍属于唯一 Store Worker，不增加自动恢复或后台重试服务。

真实测试 `test/isolated/storage/host-mutations.test.ts` 使用两个 Worker、新临时 profile 与无害 ledger：并发只有一个 created；外部效果后真实 terminal SQL 触发器失败留下 pending，重试不增 ledger；终态不可改写；错误 Store/主体、明文、非法字段与不准确 Workspace scope 拒绝；readonly 重开保持原事实。实际 Config/vault adapter 及 HTTP 管理验证由 Service/config owner 执行。


`permission.mode` 与 `workspace.trust` 是有限宿主控制记录；`readHostControl` 返回原主体/范围下最新 applied 控制与 Decimal64 revision，不接入执行 owner。`PermissionDecision.controlReads` 最多封存三个准确 kind/scope/revision，不含调用者可自报的主体或 parent。最终 [host-control-dispatch.ts](host-control-dispatch.ts) 从实际 Execution→原 Command/root Session/Workspace 派生范围，核实当前 Store 和准确 applied revision；旧 proof 抛出 `permission_control_changed`，与业务必要条件和 human/reviewer proof 同处派发事务。审批接纳后的返回不得删除原控制 read set。真实[SQL/Host 测试](../../../test/isolated/storage/host-control-dispatch.test.ts)覆盖批准后更新、child scope、原 Store 与未知 scope，零未授权 adapter 效果；控制管理的外部请求/HMAC/receipt 与配置权限策略由 Service owner 装配。


config.user.write / config.workspace.write 可携封闭 `modelSettings` 安全 marker，仅 `{expectedReadSet:{userEtag,workspaceEtag,explicitDigest,effectiveDigest},operation:{kind:"enabled",modelId,enabled}|{kind:"default",modelId}|{kind:"effort",modelId,reasoningEffort}}`，其中 effort 为有限枚举或 null。原 scope 对应的 ETag 必须与 ifMatch 一致；用户读取集合的 workspaceEtag 为 null，Workspace 集合为真实 ETag。未知 purpose/字段、隐藏主体和坏 hash 被接纳前拒绝。同 ID 下 marker 任一事实改变都冲突。Core只验证这些普通配置审计数据和原身份，不判断模型有效性、不新增调度或业务表；完整候选/default 规则属于 Service Settings。回执继续只保存 status/etag 或有限失败码。 [host-mutations tests](../../../test/isolated/storage/host-mutations.test.ts) 验证恶意 marker 零接纳、原事实不可替换。


config.user.write 的 user scope 可携封闭 providerSettings，与 modelSettings 互斥且 operationCount:1。marker 恰含原四字段 readSet（workspaceEtag 必须 null、userEtag 等于 ifMatch）和 {provider,connectionId,baseURL,modelNames,credential}；协议为四个明确字符串值、connectionId 为 null/64hex、URL 无 userinfo/query/hash，credential 为 keep/replace/none。Core 不接受秘密、路径、主体或隐藏 Workspace。原 Store/subject/command/kind/scope/完整 marker 与 HMAC digest 绑定不变。

receipt grammar 由持久原 marker 决定，分开核 credentialState:unchanged|stored|outcome_unknown 与 configurationState:not_attempted|published|outcome_unknown。opaqueRef 当且仅当 stored；applied 必须 published/已知凭据/etag，failed 两介质必须已知且无etag，unknown 至少一个介质未知。普通 config/credential receipt 不接受该复合格式。Core 只记录结果，不核 vault I/O、不回滚、不自动重发；实际配置合法性与两个介质发布属于 Service owner。[真实 Worker 测试](../../../test/isolated/storage/host-mutations.test.ts)核原 marker、身份冲突、秘密/authority拒绝和对应终态。
