# 普通 Web Fetch 工具

`@kite-ai/agent/web-fetch` 导出 `createWebFetchExtension`、`createPinnedWebNetworkPort`、`createPassiveWebExtractor` 及中立的宿主 port。导入和注册均不会解析 DNS、启动 Worker 或打开 socket。`builtin.web@1` 只注册 `web_fetch@1`；Core 必须授权并派发这个普通 Tool。远端内容和宿主资源准入都不能赋予 Tool 权限。

输入是封闭的 `{url, max_chars?, timeout_ms?}`，默认返回完整正文。只有显式传入正整数 `max_chars` 才选择正文前缀，并通过 `details.truncated` 记录这一选择。没有 8K/16K 文本上限，也没有合法跳转次数上限；规范化 URL 构成的真实循环会失败，每个实际跳转都重新准入。URL user-info 和 metadata 名称被拒绝。响应解析的安全边界为实际解码后 5,000,000 字节，支持的 gzip/deflate/br 解压后也受此边界约束；这是单次响应的解析边界，不是累计 Run/Artifact 预算。默认 15 秒超时从 Tool 入口开始，覆盖 parser asset 校验、robots、域名队列、传输和解析；较长的显式超时使用分段计时器。取消释放本请求的 socket/Worker，不据此宣称远端服务器的工作已停止。

可信宿主提供 `PinnedWebNetworkOptions`，其中包含封存的 `off`、`public` 或精确主机 `allowlist` 策略，以及 `admitHop(binding,{signal})`。binding 携带原始 URL、当前跳转/资源及实际 execution、Session、原 Store 身份；资源准入独立于普通 Core 授权。所有 DNS 候选地址都要检查，允许地址与私有地址混合的响应在连接前失败。自有连接在真正的 Node HTTP(S) lookup 中固定已验证地址，同时保留原 Host、TLS servername 和证书校验。实现不使用全局 fetch、proxy 环境、环境中的 cookies/credentials 或自动跳转。

URL 中的字面地址同样接受检查；private、loopback、link-local、metadata、reserved 及非 global 地址被拒绝，IPv4-mapped 与 transition IPv6 也被保守拒绝。显式宿主选项 `allowLoopbackForTests` 只用于本机 fixture 资格，不能推导生产网络授权。宿主可注入 DNS 解析，但仍不能绕过地址校验。单跳 `WebNetworkPort` 是明确的可信契约，其实现必须在 socket I/O 前运行 `beforeConnect`；提供的 pinned port 会在准入/DNS 后执行它，并等待普通 extension record 写入。记录包含精确 URL SHA-256、host/port、策略 revision 和已验证地址；query string、fragment、原始 URL 和响应正文不是 audit/log 字段。原 Tool 输入仍由 Core 作为准确原始意图保存。

robots 检查保留原 owner 基线：最多读取 500 KB 完整规则文本，没有固定 100 条规则裁剪；缓存为 5 分钟、200 个 origin，读取失败/超时采用宽松回退，取消仍向外传播。同 origin 请求在可取消的 500ms 域名队列等待；队列项会释放和移除，不设累计 hostname 预算。robots 请求遵守相同的逐跳 DNS、准入和 socket 规则。

parser 在自有 Bun Worker 中使用被动 JSDOM/Readability/Turndown，不执行脚本、不加载子资源、不转发 DOM 诊断。构建生成 `dist/tools/web-fetch/extractor-worker.js` 及 `extractor-worker.sha256`。源码运行同样定位这个已构建 asset，没有 TypeScript/raw parser 回退。asset 缺失或 SHA 不匹配会在网络 I/O 前局部失败，parser 身份写入 result details。Worker 终止约束取消/超时，不提供 DOM 峰值内存上限。

纯 `webExtractorAsset()` 和 `webExtractorAssets()` 只返回实际选定 Worker 及同名 `.sha256` companion 的绝对位置，不读取文件、不打开 Worker。实际 loader 使用同一 getter 核验完整字节；默认 Service 用这对位置建立 Files 保护范围。显式可信 custom extractor 不加载默认 Worker，也不把默认位置当成其运行证明；宿主另行提供实际 runtime assets。准确文件和验证过的 terminal closure 属于资产身份，任意 bundle 的父目录不自动成为保护范围。

超过 64 KiB 的正文通过普通 Tool 的 Artifact publisher 发布，保留原 public scope 和 `modelContent` UTF-8 引用；下一普通 Model checkpoint 解析完整选定正文。较小正文保持 inline。缺少 Artifact 能力时明确失败，不隐式裁剪。Artifact hash/authority 和 ModelBody 处理仍由 Core 负责。

验证覆盖实际 macOS loopback Node socket、假主机 DNS pinning、混合地址拒绝、解压超界、实际 socket 取消/隔离，以及真实 SQLite/Core/Artifact/被动 Worker，见 [network 测试](../../../test/isolated/web-fetch/network.test.ts)、[Core 测试](../../../test/isolated/web-fetch/core.test.ts)和 [asset 测试](../../../test/isolated/web-fetch/assets.test.ts)。资源策略由可信 fixture 提供，不证明通用宿主权限或 DNS 策略服务已完成。

[包外完整 manifest 测试](../../../../../tests/isolated/unified-agent/built-package.test.ts)已在 macOS/Bun 1.4.2 实际执行通过（`bun test tests/isolated/unified-agent/built-package.test.ts`，1 pass、46 个 Bun expect 调用）。它在源码树外构建并解析 17 个公开入口，通过公开默认配置和本机 compatible 模型调用普通 `web_fetch`，实际使用第四个 Worker asset 完成 HTML→Readability→Markdown，读取超过 64 KiB 的完整 Artifact 并核实原 execution scope、Store、SHA、Tool 终态和下一 Model 的完整正文。测试还移走私有包 Worker，确认新调用返回 `web_parser_unavailable`，网络和准入计数不增加，恢复 asset 后完成清理；原 SQLite Worker、Shell/MCP guardian、Skills、Client 和 Service 组合仍保留。外部 npm 依赖链接自已安装模块，这不构成新机安装资格。

真实 TLS endpoint 的 HTTPS 证书/SNI，以及原生 Linux/Windows 执行资格仍未在这里验证。完整响应、字符串、DOM 和 Artifact 可能同时驻留内存，不宣称固定内存流式处理。普通远端网页数据是低信任内容；这个 leaf 不是 Shell/MCP 进程的网络 sandbox。
