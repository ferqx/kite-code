# Agent Note: Native MCP 设置与原操作记录

Status: implemented

## Problem

正式 Native 需要在一个设置入口完成 MCP 来源、选择、认证、连接和原工具阅读。既有 Service 已将这些效果分开；renderer 的当前目录与 Command applied 不能替代原执行证明。直接复用旧 AppControl、扩大普通 caller grammar 或保存不完整原 body 都会丢失身份与恢复边界。

## Decision

Native Main 拥有真实 Store/subject/Session/Workspace identity、观察 read-set、固定 Command、完整原申请和原结果验证。renderer 只提交有限编辑、观察 ID 与明确操作；Source Review 与普通 Action、连接 Job、Tool 授权保持独立。Auth 成功不隐式连接，关闭页面只撤销自己的 reader。macOS本机完整设置方案已收束并删除，产品、完整用户旅程与实施事实分别归[桌面手册](../../../../docs/handbook/clients/desktop/README.md)和[Native owner](../../../../apps/desktop/README.md#native-mcp-完整设置)，跨包认证／恢复合同归[active](../../../../docs/active/mcp-authentication.md)。完整平台与整体V1.3仍按[主线](../../../../docs/plans/unified-agent-refactor-v1.md)实施。

自DB7起的独立 mcp_intents 保存完整非秘密 request、两种 canonical SHA、准确原 scope/subject 和状态；首次 POST 前 FULL 落库，本次热提交权不序列化。冷行只能显式查原 IDs，foreign Store 在 HTTP 前拒绝。reconnect 保存上一 carrier 的准确 request，不递归嵌套历史。manifest15 专属 DB7，Agent 使用独立 codec；含raw配置的v16及后续DB／资产版本由[维护owner](../../../../packages/agent/src/maintenance/README.md)按真实资产选择，旧 manifest/DB 白名单不扩大，坏字节与未知记录不清理。

Select、Refresh 与手工绑定按各自原 C/E/Interaction/HostMutation 的闭合证明显示结果；其他操作沿现行正式历史 Query。绑定只管理已有 opaque Ref 的批准/撤销，不把秘密引入普通问卷。不可变工具 descriptor 由 Main 使用公共 Client 验全文 hash/EOF 后分块传递，renderer 不获得任意 Artifact authority。 Main两槽容量在异步读取前预留，关闭/替换撤销准确reader；原确认终态单调，晚到pending/unknown只保本次查询失败，不写坏原终态。Source声明发表与凭据cleanup分别证明，cleanup未知不能把整体标成可清除的成功。

可信本机资格网络在构建前选固定ProcessHost，并将loopback与受限公开X509证书纳入制品摘要；没有环境/来源配置或post-build改字节的授权入口，默认browser/backend/permissions保持。IP HTTPS不发送IP-valued SNI，仍核原URL证书；浏览器生成的证书提示由用户操作，准备页与原120秒Login期限分开。

资格Host的OS引用准备沿正式paired Service的有限PATH/LANG环境，而非原测试父进程的隔离HOME；后者没有默认keychain。候选packaged runtime/config在shared lease内仅put/remove/resolve预选且先保存的准确owned ID，fresh独立backend核absence之后再释放shared与取exclusive proof。父调度/Native HOME保持，默认backend与原来源许可不替换，不发现用户Kite配置、枚举其他Ref或修改系统keychain设置。

## Alternatives considered

- 恢复旧桌面 AppControl/Host 管理页：会重新引入已切换的应用生命周期与权威边界，采用当前 Main 加公共 Client。
- 扩大 caller_intents 为任意 extension.invoke：会扩大已发布离线格式和普通输入语法；采用独立 MCP table 和 manifest15。
- 只保存 commandId 或成功摘要：无法核原 body、read-set、subject 与 reconnect carrier，采用完整非秘密原申请和独立摘要。
- 冷启动自动重发或凭当前连接/presence推断成功：跨介质与远端效果可能已发生，采用明确原查询和 unknown。
- Native Add 提供任意 raw JSON 或 secret 编辑器：不符合当前有限 Source Action 合同，采用 HTTP URL/绝对 stdio command，既有绑定独立审核。

## Verification and limits

正式 Native 页面已实现全部有限入口、原工具全文与原操作查询，实际stdio/HTTP、普通独立许可、四Auth与准确取消分别取得本机证据。真实Node DB7的create/inspect/restore保原申请、身份与零重发，旧格式拒绝边界继续有效，raw配置恢复按v16另核。源码外Native制品使用实际默认系统opener/backend完成自有HTTPS AS、callback/PKCE、fresh Service重读和准确cleanup后再重读absence，没有以替代opener/backend或直调callback代系统资格。

## Consequences

Main固定请求与多类原证明增加有界状态和严格校验成本；未知结果可能长期阻止同scope新写，不能以当前目录或清空资产恢复热权。设置关闭和scope变化必须丢弃迟到读取，不能影响原业务。新的非参与式独立审查已核当前需求／源码／原证据，并发现普通失败建立与失败replacement消费者遗漏；修复以共享closed停止解码和原冻结摘要保持known failed与unknown区分，没有删除原观察或放宽停止证明。本机HTTPS／TLS拒绝、普通OS引用清理、实际Chrome/defaultVault四Auth、准确取消与重启恢复均已有原入口证据。CUA仍未暴露Chrome控制，真实导航由默认opener发起并由原wire验证；浏览器安全提示仍交用户。完整平台、RSS／全Runtime观测、持续Soak、§35与最终退役不由本片单独证明。


## Current evidence

实际Main HTTP1项61断言、源码外Native Source/transport窗口1项18Bun断言、实际Node DB7/v15公共维护4项32断言已通过。窗口保独立许可、完整Unicode descriptor零额外RPC、下一Model schema/一次效果、冷原GET零POST及准确普通credential fresh absence。TLS8项78断言核不信任／错误DNS／缺IP SAN拒绝与正确IP SAN实际协议。macOS26.7.1 arm64、Chrome154.0.8037.98以实际默认opener/backend完成四Auth、原取消、PKCE/document导航、fresh Service复用和清理后fresh absence，原入口actual0／58.396秒、4089regular/Git保持、最终qualification passed；固定loopback／测试证书不证明生产默认网络、外部AS／账号或其他平台。

本轮共享停止消费者及原failed Query在Agent原四文件34项／666断言、默认Service真实stdio失败→原查回→独立新connect→全文工具→独立Tool Ask／一次效果4项／80断言通过。完整默认首次在Native基础夹具原pending文案断言真实红，最小观察顺序修正保持96条完整assert／原序与原预算；第二次准确未筛选 `bun run test` actual0／1400.998秒，714文件／575正式作业全启动／完成／通过、4386tracked regular输入／Git全等，正常types／API／包边界／文档门禁通过。取消／退出实现未变，由当前整轮覆盖相邻消费者；新Service失败测试不冒称已在Native窗口重做失败查回。原集成红、Chrome资格及当前精确输入／SHA／范围分别见[集成进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07native-mcp-完整设置集成与实际窗口实施中)、[Chrome验收](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07native-mcp-chrome-与默认-vault-验收)和[本轮进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11macos-mcp-失败建立与完整连接恢复)。
