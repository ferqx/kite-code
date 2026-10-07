# Agent Note: Native MCP 设置与原操作记录

Status: proposed

## Problem

正式 Native 需要在一个设置入口完成 MCP 来源、选择、认证、连接和原工具阅读。既有 Service 已将这些效果分开；renderer 的当前目录与 Command applied 不能替代原执行证明。直接复用旧 AppControl、扩大普通 caller grammar 或保存不完整原 body 都会丢失身份与恢复边界。

## Proposal

Native Main 拥有真实 Store/subject/Session/Workspace identity、观察 read-set、固定 Command、完整原申请和原结果验证。renderer 只提交有限编辑、观察 ID 与明确操作；Source Review 与普通 Action、连接 Job、Tool 授权保持独立。Auth 成功不隐式连接，关闭页面只撤销自己的 reader。完整设计与验收归[当前方案](../../../../docs/plans/unified-agent-native-mcp-settings.md)，产品与实施事实分别归[桌面手册](../../../../docs/handbook/clients/desktop/README.md)和[Native owner](../../../../apps/desktop/README.md)。

独立 DB7 mcp_intents 保存完整非秘密 request、两种 canonical SHA、准确原 scope/subject 和状态；首次 POST 前 FULL 落库，本次热提交权不序列化。冷行只能显式查原 IDs，foreign Store 在 HTTP 前拒绝。reconnect 保存上一 carrier 的准确 request，不递归嵌套历史。manifest15 专属 DB7，Agent 使用独立 codec；旧 manifest/DB 白名单不扩大，坏字节与未知记录不清理。

Select、Refresh 与手工绑定按各自原 C/E/Interaction/HostMutation 的闭合证明显示结果；其他操作沿现行正式历史 Query。绑定只管理已有 opaque Ref 的批准/撤销，不把秘密引入普通问卷。不可变工具 descriptor 由 Main 使用公共 Client 验全文 hash/EOF 后分块传递，renderer 不获得任意 Artifact authority。 Main两槽容量在异步读取前预留，关闭/替换撤销准确reader；原确认终态单调，晚到pending/unknown只保本次查询失败，不写坏原终态。Source声明发表与凭据cleanup分别证明，cleanup未知不能把整体标成可清除的成功。

可信本机资格网络在构建前选固定ProcessHost，并将loopback与受限公开X509证书纳入制品摘要；没有环境/来源配置或post-build改字节的授权入口，默认browser/backend/permissions保持。IP HTTPS不发送IP-valued SNI，仍核原URL证书；浏览器生成的证书提示由用户操作，准备页与原120秒Login期限分开。

资格Host的OS引用准备沿正式paired Service的有限PATH/LANG环境，而非原测试父进程的隔离HOME；后者没有默认keychain。候选packaged runtime/config在shared lease内仅put/remove/resolve预选且先保存的准确owned ID，fresh独立backend核absence之后再释放shared与取exclusive proof。父调度/Native HOME保持，默认backend与原来源许可不替换，不发现用户Kite配置、枚举其他Ref或修改系统keychain设置。

## Alternatives considered

- 恢复旧桌面 AppControl/Host 管理页：会重新引入已切换的应用生命周期与权威边界，采用当前 Main 加公共 Client。
- 扩大 caller_intents 为任意 extension.invoke：会扩大已发布离线格式和普通输入语法；采用独立 MCP table 和 manifest15。
- 只保存 commandId 或成功摘要：无法核原 body、read-set、subject 与 reconnect carrier，采用完整非秘密原申请和独立摘要。
- 冷启动自动重发或凭当前连接/presence推断成功：跨介质与远端效果可能已发生，采用明确原查询和 unknown。
- Native Add 提供任意 raw JSON 或 secret 编辑器：不符合当前有限 Source Action 合同，采用 HTTP URL/绝对 stdio command，既有绑定独立审核。

## Acceptance criteria

正式 Native 页面实现全部有限入口、原工具全文与原操作查询，实际 stdio/HTTP、普通独立许可、四个 Auth Action 与准确取消分别验收。真实 Node DB7 的 create/inspect/restore 保原申请、身份与零重发，旧格式拒绝边界继续有效。源码外 Native 制品使用实际默认系统 opener/backend 完成自有 HTTPS AS、callback/PKCE、fresh Service 重读和准确 cleanup 后再重读 absence；未完成的实际系统资格不能由替代 opener/backend 或直调 callback 宣称。

## Risks

Main 的固定请求与多类原证明需要独立审查，当前新的整片独立Reviewer仍受工具线程额度限制。设置关闭和 scope 变化必须丢弃迟到读取，不能影响原业务。本机HTTPS通信、TLS拒绝和普通OS引用清理已实证；四Auth的实际Chrome/defaultVault组合、准确取消与重启恢复已通过原入口。CUA仍未暴露Chrome控制，真实导航由默认opener发起并由原wire验证；若出现浏览器安全提示仍交给用户。完整平台、持续 Soak、§35 与最终退役不由本片单独证明。


## Current evidence

实际Main HTTP1项61断言、源码外Native Source/transport窗口1项18Bun断言、实际Node DB7/v15公共维护4项32断言已通过。窗口保独立许可、完整Unicode descriptor零额外RPC、下一Model schema/一次效果、冷原GET零POST及准确普通credential fresh absence。TLS8项78断言核不信任/错误DNS/缺IP SAN拒绝与正确IP SAN实际协议；此前独立审查确认固定测试装配没有覆盖生产浏览器、Vault或权限。当前原完整默认615文件/489主作业通过；同一运行输入另在macOS26.7.1 arm64、Chrome154.0.8037.98以实际默认opener/backend完成四Auth、原取消、PKCE/document导航、fresh Service复用和清理后fresh absence，原入口actual0/58.396秒、4089regular/Git保持、最终qualification passed。本机组合缺口已关闭，固定loopback/测试证书不证明生产默认网络、外部AS/账号或其他平台。新的整片独立审查尚未取得，方案仍保proposed，不以root自检替代；原集成失败与当前准确资格分别见[集成进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07native-mcp-完整设置集成与实际窗口实施中)和[Chrome验收](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07native-mcp-chrome-与默认-vault-验收)。
