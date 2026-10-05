# Agent Note: Original MCP source entry mutation intents

Status: implemented

## Problem

正式MCP目录、来源批准与连接各有准确原申请，但启停不能创建或删除原mcp.json条目。增删跨文件与SQL，缺回执可能已改变未来目录；project移除还会显露同名user。简单用当前列表、Command.applied或cold重新提交，会覆盖原意图、复活未知效果或误报整个Server及credential已移除。

当前需求沿[MCP手册](../../../../docs/handbook/clients/tui/guides/mcp-and-skills.md)、[V1.3](../../../../docs/plans/unified-agent-refactor-v1.md)及[MCP来源发布边界](../../../../docs/active/mcp-config-management.md#来源条目增删的发布与原结果边界)。[Source owner](../../../../packages/agent/src/config/README.md)、[Service](../../../../apps/service/README.md)、[CLI](../../../../apps/cli/README.md)和[共享TUI](../../../../packages/ui/src/tui/README.md)说明当前已交付边界。本记录只说明已交付的来源条目切片；完整产品能力与V1.3资格仍按当前负责文档和[总体进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)核对，不能由局部通过推导整体完成。

## Decision

使用独立普通mcp.source.add/remove Actions、current entry preview及原mutation result Query。closed基本声明只收当前TUI的name、HTTP URL/绝对STDIO command与来源层，不收secret/args/env/header/auth/Tool policy。private leaf仍保原advanced字段和完整字节；generic configuration writer不放宽。实际producer核原Action/Command/subject、完整input、Store/S/W/root-work及HostMutation，安全preview把source identity/raw digest和user fallback分开。

Source writer同时持固定排序四canonical短锁，重读完整六字段read-set，临时文件fsync/rename/directory sync；published后的错误优先unknown。所有取得的锁均尝试释放，release异常不能覆盖rename后的unknown；发布前原有限错误保留。尝试释放不保证操作系统关闭成功。Add只创建同层不存在的名称，写入可信实际Execution的闭合_kiteSourceCreation marker，使新raw digest不等旧批准，保旧metadata与原proof。marker只参与原始字节身份，不授Source/transport/Tool许可。手工还原旧完整声明仍按既有exact approval事实核验，此标记不承诺全局撤销过去批准。

Remove只删除准确effective来源项，project user显露在独立确认前显示，不把文件删除当owned transport或remote Tool停止证明。原Run与原connection历史不重标。manual opaque Bearer引用没有server-owned secret创建证明，必须保独立Vault引用。后续[owned OAuth与原认证Action](2026-10-05-owned-mcp-oauth-and-original-auth-actions.md)已接入准确owned域的preflight与发布后本地清理；本记录的四锁/CAS、原声明回执和共享凭据保留理由继续适用。saved仍只表示source-entry发布，credentialCleanup独立报告，清理未知可保E unknown/M applied。下列来源增删基线的零Vault证据保原范围，不承接为后续OAuth清理证明。

Caller独立原intent与closed文件，在同一tui_private短锁内与Source approval核实际共享来源依赖。增删同source文件跨S阻挡，user跨W；原Store/source identity比较不使用绑定Session的整个scopeDigest。selection的配置介质及ordinary/forced transport的原未知guard继续独立，raw edit不修复或重放其效果。只有本次完整durable prepare取得首次POST权，cold/duplicate只原GET；原ID选择零GET、明确Check才查，foreign任何HTTP前拒绝。

独立条件维护资产及新版本保旧物理白名单、UTF8/完整SHA/private entity/capacity，A→B保原request/subject/Store/S/bytes/phase，无retag/hot permit。历史Query只核原持久证明，移除Source或physical Workspace不依赖当前文件；晚回复只更新原intent。

[原来源批准理由](../../implemented/architecture/2026-10-05-original-mcp-source-approval-intent-assets.md)、[原选择理由](../../implemented/architecture/2026-10-04-original-mcp-selection-intent-assets.md)、[普通连接](../../implemented/architecture/2026-10-05-original-mcp-connection-intent-assets.md)、[强制重连](../../implemented/architecture/2026-10-05-forced-mcp-reconnection-and-original-outcomes.md)与[scoped来源提案](../../proposed/architecture/2026-10-03-scoped-default-mcp-sources.md)仍各负已交付或尚待交付的范围；本记录不整篇替代它们。

## Alternatives considered

- 直接复用generic config.patch：缺准确原Source/read-set与declared transport检查，不能为了新增而放宽通用env/secret规则；采用固定Source writer。
- 任意raw entry编辑表单：会把当前advanced私有字段和认证/Tool策略带入新交互，当前产品Add仅要求有限字段；采用闭合基本声明，保手工高级配置。
- 只用name/serverId删除当前列表：同名两层与同ID指向不同来源时，不能证明原删除对象及fallback；采用原source/raw digest与read-set绑定preview。
- Add前物理删除旧approval/binding记录：需要多文件发布、改变历史决定，半完成窗口也可能丢解释；采用新原执行marker变更raw fingerprint，旧原proof继续保存。
- 把UI Confirm当Source批准或Tool grant：混淆配置、项目批准与执行许可；分别沿普通Action和独立原批准/Job/Tool合同。
- 删除所有配置credentialRef：引用和binding不证明底层Vault所有权，可能删除共享用户secret；保manual引用；后续OAuth只清有准确owned身份的本地材料，完整边界见上述认证决定。
- 对所有selection/transport unknown一律建立新全局锁：原介质与实际效果不同，旧intent没有完整source身份也不能证明这种全局精确域；Source修改与Source批准只核真实共享来源，原transport guard与freshness继续保护其未知效果。

## Verification

真实Source leaf原new+neighbor27项280断言；release故障修复前11pass/3fail保留。实际default Service原producer17项622断言及独立目录fsync+lock-close故障1项32断言证明rename后E/M unknown、effectAttempted:true、duplicate原C只一rename，零Model/vault/transport。真实Caller物理毁POST及首GET回复2项71断言，原lookup恢复saved、总POST1及cursor不变；52Source三页/101Workspace真实完整目录与准确非首页target分别核验。

Root冻结正常八workspace types/build与原28任务图实际233pass/4328assert/0fail；含当前Source外80×24 Add/Remove/cold removed/foreign restored全例1项255断言。当前动态完整默认554个唯一文件/447个主任务全部通过，runner0、765.161s正常排空，3816个regular冻结输入及真实Git前后保持；raw2611pass/3expected nestedfail/17skip/0error/38737assert。完整默认completion SHA f99c82d65a39c513c680eca258a1664fa0e55b124b298c8987e5c548596561de，原红和有限窗口按总体进度记录；原计划七项各由所列实际Source/Service/Caller/UI/maintenance/制品与集成证据支持，未测范围不标不适用。

## Consequences


SQL、source file和credential介质不原子；创建marker改变JSONC原始声明并增加持久字段，手工删除或复原仍按真实raw digest处理。非合作编辑者最后检查至rename的race不称OS原子。Source完整read-set使同文件不同name也共享conflict，unknown可能长期阻挡；不能截断记录或淘汰换空间。

当前Source-entry saved不证明完整管理remove的owned OAuth cleanup；该产品差异必须在手册和owner持续明确，并在OAuth接入时扩展真实partial/unknown原结果，不能削弱引用所有权安全。正常本机资格不证明异常收尾、全部T/E或三平台。
