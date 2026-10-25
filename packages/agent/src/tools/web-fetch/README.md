# 普通 Web Fetch 工具

模型工具名保持 `web_fetch`，可信 model 元信息启用声明属性的 snake_case 投影。`max_chars` 省略时返回完整提取正文，`timeout_ms` 省略时为60000毫秒；内部工具身份、网络审批与逐跳准入保持不变。

`@kite-ai/agent/web-fetch` 导出 `createWebFetchExtension`、`createWebFetchBindingFactory`、`createPinnedWebNetworkPort`、`createPassiveWebExtractor` 及中立的宿主 port。导入和注册均不会解析 DNS、启动 Worker 或打开 socket。`builtin.web@1` 只注册 `web_fetch@1`；Core 必须授权并派发这个普通 Tool。远端内容和宿主资源准入都不能赋予 Tool 权限。

输入是封闭的 `{url, max_chars?, timeout_ms?}`，默认返回完整正文。只有显式传入正整数 `max_chars` 才选择正文前缀，并通过 `details.truncated` 记录这一选择。没有 8K/16K 文本上限，也没有合法跳转次数上限；规范化 URL 构成的真实循环会失败，每个实际跳转都重新准入。URL user-info 和 metadata 名称被拒绝。响应解析的安全边界为实际解码后 5,000,000 字节，支持的 gzip/deflate/br 解压后也受此边界约束；这是单次响应的解析边界，不是累计 Run/Artifact 预算。默认 60 秒总时限从获准派发后的 Tool 入口开始，不包括审批等待，覆盖 parser asset 校验、robots、域名队列、传输和解析；显式正整数 `timeout_ms` 可覆盖默认值，较长的显式超时使用分段计时器。工厂以 `defaultTimeoutMs` 暴露同一运行默认值供 Service 封存，模型 schema 描述使用同一常量。robots 独立 3 秒宽松回退保持。取消仍立即传递至本请求的 socket/Worker，不等待总时限到期；不据此宣称远端服务器的工作已停止。

可信宿主提供 `PinnedWebNetworkOptions`，其中包含封存的 `off`、`public` 或精确主机 `allowlist` 策略，以及 `admitHop(binding,{signal})`。binding 携带原始 URL、当前跳转/资源及实际 execution、Session、原 Store 身份；资源准入独立于普通 Core 授权。所有 DNS 候选地址都要检查，允许地址与私有地址混合的响应在连接前失败。自有直连在 Node HTTP(S) lookup 中固定已验证地址，同时保留原 Host、TLS servername 和证书校验。不使用全局 fetch、ambient proxy/cookies/credentials 或自动跳转。

`proxy` 是宿主已选定的 HTTP/HTTPS 入口与 `noProxy` 绕过表；低层 port 自身不读取环境或发现系统设置。HTTP/HTTPS 目标均通过 CONNECT 连接已验证的字面 IP，代理不能重新解析目标域名；原 Host、TLS SNI、证书链与主机名检查保留，HTTPS 代理本身也校验证书。仅支持无需认证的 HTTP/HTTPS 代理，拒绝 user-info、路径、查询与片段；不转发 Proxy-Authorization，不跟随 CONNECT 重定向，不在代理失败后直连。每次连接有独立 agent，关闭 ambient proxy；握手、响应体和取消均归原请求，不取消兄弟请求。可信 `certificateAuthority` 可提供所属 CA，证书/名称校验始终开启；该选项不接受 JSONC、模型或网页输入。

`recoverFakeIp` 默认关闭，正式默认 Service 显式开启。仅非字面主机且系统 DNS 的 1–64 项有效候选全部属于 `198.18.0.0/15` 或 `2001:2::/48` 时，使用固定 Cloudflare HTTPS DNS wire POST（`cloudflare-dns.com/dns-query`，公网 bootstrap IP）恢复真实地址；混合、私网、literal Fake-IP 或解析失败不借此放行。可信 `dnsOverHttps` 可选择另一 HTTPS endpoint 和 1–8 个公网 bootstrap IP，显式选择时跳过系统 DNS。当前连接固定使用第一个 bootstrap 地址，不重新解析 endpoint；标准 wire A/AAAA 顺序查询并检查 transaction ID、问题名/类型、边界、压缩及 CNAME 环，65,535 字节上限，不跟随 DNS HTTP 跳转。解析 endpoint 走同一已选代理/绕过规则，只发送目标域名；所有真实结果继续执行原全候选公网检查，然后才记录目标审计并连接。失败和取消不改用未验证的系统结果。

URL 中的字面地址同样接受检查；private、loopback、link-local、metadata、reserved 及非 global 地址被拒绝，IPv4-mapped 与 transition IPv6 也被保守拒绝。显式宿主选项 `allowLoopbackForTests` 只用于本机 fixture 资格，不能推导生产网络授权。宿主可注入 DNS 解析，但仍不能绕过地址校验。单跳 `WebNetworkPort` 是明确的可信契约，其实现必须在 socket I/O 前运行 `beforeConnect`；提供的 pinned port 会在准入/DNS 后执行它，并等待普通 extension record 写入。记录包含精确 URL SHA-256、host/port、策略 revision 和已验证地址；query string、fragment、原始 URL 和响应正文不是 audit/log 字段。原 Tool 输入仍由 Core 作为准确原始意图保存。

排查 `web_destination_denied` 时，在同一宿主网络环境复核实际 DNS 候选：空集合、超过64项、地址族不符或任一非公网地址都在连接前失败。普通工具批准不能放开这些目的地。正式宿主的自动选择、备用用户配置和精确失败码归 [Service](../../../../../apps/service/README.md)及[手册](../../../../../docs/handbook/features/models-and-configuration.md#网页网络配置)。2026-10-25 Windows x64／Bun1.4.3 原 GitHub API 请求的 DNS 返回 Fake-IP，旧 port 在 `beforeConnect` 前拒绝；新版在不修改本机网络设置下自动选择已登记代理，真实解析后成功读取 `github.com/octocat/Hello-World`（HTTP200，226,219字节）。同一 API 另见 HTTP403 或超时，不能以网页成功承诺 API 配额或远端稳定性。

robots 检查保留原 owner 基线：最多读取 500 KB 完整规则文本，没有固定 100 条规则裁剪；缓存为 5 分钟、200 个 origin，读取失败/超时采用宽松回退，取消仍向外传播。同 origin 请求在可取消的 500ms 域名队列等待；队列项会释放和移除，不设累计 hostname 预算。robots 请求遵守相同的逐跳 DNS、准入和 socket 规则。

[Core 回归](../../../test/isolated/web-fetch/core.test.ts)用实际 loopback 响应延迟16秒，确认省略时限后超过旧15秒门槛仍成功并向下一Model交付完整正文；同文件继续核显式10ms／1200ms时限、socket关闭、准确取消及清理未知。[默认Service回归](../../../../../apps/service/test/isolated/default-web-fetch.test.ts)另核缺少默认时限字段的旧快照在凭据、Provider和Store效果前拒绝冷恢复，不悄悄更换预算。2026-10-25 Windows x64／Bun1.4.3，本轮Core、默认Web与配置三文件15项／324断言通过，Agent／Service类型及构建通过；不将本机延迟fixture当成远端网站稳定性或其他平台资格。

parser 在自有 Bun Worker 中使用被动 JSDOM/Readability/Turndown，不执行脚本、不加载子资源、不转发 DOM 诊断。构建生成 `dist/tools/web-fetch/extractor-worker.js` 及 `extractor-worker.sha256`。源码运行同样定位这个已构建 asset，没有 TypeScript/raw parser 回退。asset 缺失或 SHA 不匹配会在网络 I/O 前局部失败，parser 身份写入 result details。macOS 的结果、原错误或准确取消在[原 Worker owner](../../platform/process/owned-worker.ts)确认原 Mach 权死名和准确释放后才结束；可信同步 preload 不改原 main、相对 import、hash 或一次输入，最早已创建取消也先交接原权再请求终止。五秒独立收尾预算包括原身份取得和终态观察，缺证据保失败；原错误与清理错误同时保留。清理未知先交原 Core 保存 outcome_unknown，取消／timeout不能掩盖它或继续下个 Model；[完整 Core 文件](../../../test/isolated/web-fetch/core.test.ts)的真实准确取消／冷读用例验证这条分支，注入的清理失败不作为 native 死亡证据。Win/Linux 原路径及未闭合资格保持。单线程收尾不提供 DOM 峰值内存上限，也不证明整个 Runtime 内存回收。

纯 `webExtractorAsset()` 和 `webExtractorAssets()` 返回实际选定 Worker、同名 `.sha256` companion 及固定 observer preload／准确 source leaves或built chunk的绝对位置，不读取文件、不打开 Worker。实际 loader 使用同一 getter 核验原 parser 完整字节；默认 Service 从准确 metadata 建立 Files 保护范围。显式可信 custom extractor 不加载默认 Worker，也不把默认位置当成其运行证明；固定 observer 与 SQLite 共用，宿主另行提供 custom 运行资产。准确文件和验证过的 terminal closure 属于资产身份，任意 bundle 的父目录不自动成为保护范围。

正式 Service 通过 binding factory 为每个 Run 创建被动 descriptor及 disposer；真正的 extractor scope在已经授权的 Tool execute内、prepare之前才取得，prepare hash和extract使用同一个 scope。默认 scope保实际创建的 Worker与原 termination Promise，只有准确收尾成功才移除；close先封门并取消本 scope的解析，独立尝试全部原 Worker，失败及其 owner保持，重复 close复用原结果。该 disposer接入已有 Run binding lease；普通 Tool保存 unknown不等于资源已关闭，清理失败仍阻止 Runtime关闭及 Profile维护锁交接。没有 Core的Web类别分支或全局资源注册表。

网络 port、robots cache和同 origin队列仍由宿主工厂共享，关闭一个 Run不取消另一个 scope。没有 `bind` 的可信 custom extractor保持宿主所有权，Run不会调用它的 `close`；低层 `createWebFetchExtension` 的调用者自行承担所属资源寿命。[scope隔离测试](../../../test/isolated/web-fetch/binding.test.ts)核实际 parser等待HTTP时的准确关闭、兄弟完整正文及custom宿主归属；[正式清理未知测试](../../../../../apps/service/test/isolated/web-fetch-cleanup-ownership.test.ts)核原 Run未知、关闭失败、维护busy和所属进程实际退出后的完整冷读。故障fixture只注入原 JavaScript terminate失败，不能授原生OS API失败或全Runtime资源资格；通用assembly准备／清理双失败现按[生命周期owner](../../lifecycle.README.md)的明确类型交接，完整资源观测与其他producer资格仍保门禁。

超过 64 KiB 的正文通过普通 Tool 的 Artifact publisher 发布，保留原 public scope 和 `modelContent` UTF-8 引用；下一普通 Model checkpoint 解析完整选定正文。较小正文保持 inline。缺少 Artifact 能力时明确失败，不隐式裁剪。Artifact hash/authority 和 ModelBody 处理仍由 Core 负责。

验证覆盖实际 macOS loopback Node socket、假主机 DNS pinning、混合地址拒绝、解压超界、实际 socket 取消/隔离，以及真实 SQLite/Core/Artifact/被动 Worker，见 [network 测试](../../../test/isolated/web-fetch/network.test.ts)、[Core 测试](../../../test/isolated/web-fetch/core.test.ts)和 [asset 测试](../../../test/isolated/web-fetch/assets.test.ts)。资源策略由可信 fixture 提供，不证明通用宿主权限或 DNS 策略服务已完成。

[包外完整 manifest 测试](../../../../../tests/isolated/unified-agent/built-package.test.ts)已在 macOS/Bun 1.4.2 实际执行通过（`bun test tests/isolated/unified-agent/built-package.test.ts`，1 pass、46 个 Bun expect 调用）。它在源码树外构建并解析 17 个公开入口，通过公开默认配置和本机 compatible 模型调用普通 `web_fetch`，实际使用第四个 Worker asset 完成 HTML→Readability→Markdown，读取超过 64 KiB 的完整 Artifact 并核实原 execution scope、Store、SHA、Tool 终态和下一 Model 的完整正文。测试还移走私有包 Worker，确认新调用返回 `web_parser_unavailable`，网络和准入计数不增加，恢复 asset 后完成清理；原 SQLite Worker、Shell/MCP guardian、Skills、Client 和 Service 组合仍保留。外部 npm 依赖链接自已安装模块，这不构成新机安装资格。

[代理回归](../../../test/isolated/web-fetch/proxy.test.ts)在 Windows x64／Bun1.4.3 使用隔离 HTTP/HTTPS CONNECT、真实 TLS 和仅 fixture 信任的测试证书，核原 Host/SNI、错误主机和未信任证书拒绝、Fake-IP 自动恢复、显式 wire DNS、私网/混合/literal 拒绝、伪造响应、DNS HTTP 跳转拒绝、CONNECT 407无直连回退和准确取消/兄弟隔离。普通 Core 测试另核代理后的公开跳转与私网跳转在连接前拒绝。Windows 环境/已登记代理及真实 GitHub 网页探测已验证；macOS 设置仅有解析 fixture，Linux 环境分支及这两平台的原生代理 socket 尚未实测。PAC/WPAD、SOCKS、代理认证、系统没有暴露的入口仍不在支持范围。

完整响应、字符串、DOM 和 Artifact 可能同时驻留内存，不宣称固定内存流式处理。普通远端网页数据是低信任内容；这个 leaf 不是 Shell/MCP 进程的网络 sandbox。
