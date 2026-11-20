# Web 查询与搜索

显式 daemon/Web 或开发 Web 宿主提供只读 Gateway，浏览器使用同一公开 Client 的只读能力消费 Workspace、Session、消息与诊断。UI 共享展示不扩大 Browser principal 的权限。

实现与局部验证：[Web](../../../apps/web/README.md)、[Gateway](../../../apps/service/README.md)、[Browser Client](../../../packages/client/src/browser.ts)、[Web controller](../../../apps/web/src/controller.ts)。

目录与分页保原 Store、Workspace、Session、游标和选择代次；旧请求晚到不能覆盖新页面。完整 Model Input、Runtime logs 等敏感内容按实际能力和显式确认读取。Browser 不持有 Runtime、Store、Provider 凭据或普通 mutation 权限；关闭页面不取消后台任务。

共同约束以[当前 workspace 边界](../../active/unified-agent-boundary.md)及对应 owner 为准。定向测试、真实客户端过程和平台资格分别说明，不从源码存在或最终截图推定完整行为通过。

旧 Host/Kernel/SPI 实现的[历史说明](https://github.com/ferqx/kite-code/blob/d5407cfe4319c5a84d530f63b1d0a0123218ad34/docs/development/flows/web-queries.md)只供删除前设计与证据追溯，不能恢复为当前 owner 或运行入口。

## Agent Web Search 与搜索证据

搜索请求由本次 Run 的模型、账户、用户设置和权限共同选择路线。原生搜索在模型请求内执行。普通工具 `web_search` 从用户已有的官方 DeepSeek 模型提供商派生备用搜索。多个可用提供商需要明确选用的模型连接或无歧义的显式默认配置。声明顺序不能指定付费账户。桌面状态页只读；Service 的显式搜索测试会发起一次可能计费的查询。搜索结果中的 URL 不触发逐页抓取，用户仍可按原权限使用 `web_fetch`。[搜索路由](../../../apps/service/src/web-search-route.ts) · [提供商适配器](../../../apps/service/src/web-search-providers.ts) · [普通工具](../../../packages/agent/src/tools/web-search/index.ts)

已配对的 Client 可协商 `web_search_evidence`，读取 `GET /v1/sessions/:id/executions/:executionId/web-search-evidence?storeId=…`。Service 从认证上下文取主体。首次读取和每个后续版本都核对 Store、Session、Execution、原命令主体和 Artifact 归属。同一 Execution 的每次发布使用独立的 `application/vnd.kite.web-search+json` Artifact（`kite.web-search`，版本 1），按修订单调增加。响应按调用返回最新状态，分别保留检索来源、实际引用、截断标记及已知用量。原生回答用目标 Execution、保存文本块序号、UTF-8 SHA-256 和块内 UTF-16 半开区间定位引用。文本不能匹配时保留来源链接；独立后端的回答坐标只属于后端回答。原生搜索响应保留适配器或 Runtime 任一侧观察到的截断。已执行搜索但没有可保存链接时，响应仍可标明截断。[证据实现](../../../packages/agent/src/web-search-evidence.ts) · [HTTP 合同](../../../apps/service/src/http/schema/web-search.ts) · [Client 读验](../../../packages/client/test/isolated/web-search.test.ts)

### V1 验收范围

下表列出可复验的断言和仍需单独取证的情形。SDK 用例会把请求发给受控 HTTP/SSE 对端，可核对实际请求体；固定模型用例可核对执行次数、权限及落库。真实账户验收还需观察服务端搜索事件、普通工具续轮、引用、取消与恢复，HTTP 200 或普通文字不能单独证明发生了搜索。

| 用例 | 仓库内验证与边界 |
|---|---|
| A01 路由 | 自动和关闭模式、显式模型选择、歧义配置、未知网关与受限父级逐项核对唯一选择；兼容 Responses 协议本身不授予原生搜索。[路由测试](../../../apps/service/test/isolated/web-search-routing.test.ts) |
| A02 切换模型或账户 | 配置测试核对冻结的提供商别名、原账户、Profile、端点与凭据引用；路由测试核对重建时的绑定摘要。活跃窗口中切换账户的用户过程需在桌面复验。[配置](../../../apps/service/test/isolated/web-search-configuration.test.ts) · [路由](../../../apps/service/test/isolated/web-search-routing.test.ts) |
| A03 同名工具 | 原生搜索活动不会再次派给本地执行器；同名普通函数与 MCP 工具仍能按原标识执行，SDK 用例核对序列化后的工具名和续轮请求。[普通工具](../../../packages/agent/test/isolated/web-search/tool.test.ts) · [SDK](../../../packages/ai/test/web-search.test.ts) |
| A04 历史续轮 | 在本机 Responses 对端捕获下一次请求，核对同一搜索项只出现一次；Agent 用例关闭并重开原 SQLite Profile 后再次检查。真实 OpenAI/Codex 账户分别需要实测。[冷重开](../../../packages/agent/test/isolated/execution/native-web-search.test.ts) · [SDK](../../../packages/ai/test/web-search.test.ts) |
| A05 终态 | 分别核对失败、未完整、结果未知与完成，普通回答或部分来源不能把搜索标为成功。[Agent 状态](../../../packages/agent/test/isolated/execution/native-web-search.test.ts) |
| A06 断流 | 对端已收到 POST 后，分别在首个 SSE 事件前、搜索开始后断开，核对请求计数与无自动换线。可确证的发送前失败另按原重试规则处理。[SDK 断流](../../../packages/ai/test/web-search.test.ts) · [Agent 发送边界](../../../packages/agent/test/isolated/execution/native-web-search.test.ts) |
| A07 外部错误及空结果 | 核对 HTTP 错误归类、重定向、响应损坏和提供商回显的敏感内容；合法的空条目列表按成功处理。[提供商测试](../../../apps/service/test/isolated/web-search-providers.test.ts) |
| A08 取消与未知请求 | 凭据取得期间取消、读取中止，以及独立搜索执行在原 SQLite 记录重开后的去重，各有独立断言；不得因超时、重开而发出第二次可能收费的请求。[提供商](../../../apps/service/test/isolated/web-search-providers.test.ts) · [执行预算](../../../packages/agent/test/isolated/web-search/tool.test.ts) |
| A09 DeepSeek | 本机 HTTP 对端核对请求路径、可选 `/v1`、结果数和查询字段，128 个 Unicode 码点按字符核算，超限查询不发送。[提供商测试](../../../apps/service/test/isolated/web-search-providers.test.ts) |
| A10 OpenAI 独立搜索 | 检查一次搜索请求只接收查询及指定账户和模型；仅有正文、没有可确认搜索的响应不能冒充搜索成功。该路径需用用户独立 API 账户实测。[SDK](../../../packages/ai/test/web-search.test.ts) · [后端装配](../../../apps/service/test/isolated/web-search-providers.test.ts) |
| A11 引用 | 中文、emoji、块内 UTF-16 边界、文本指纹、重复事件、搜索来源与正文引用分别核对。跨 Execution、拆开代理对、独立后端回答的范围均不能成为主回答行内引用。[Artifact 测试](../../../packages/agent/test/isolated/web-search/evidence.test.ts) · [SDK 坐标](../../../packages/ai/test/web-search.test.ts) |
| A12 并发隔离 | 同时阻塞一个子 Agent 与一个独立根会话，两者复用相同提供商调用 ID。实际 SQLite 读回各自查询和模型用量，交换会话与 Execution 会被拒绝。独立工具预算按 Run，子级路由继承账户上界；两个真实桌面窗口的并发显示仍待观察。[并发执行](../../../packages/agent/test/isolated/execution/native-web-search.test.ts) · [预算](../../../packages/agent/test/isolated/web-search/tool.test.ts) · [路由](../../../apps/service/test/isolated/web-search-routing.test.ts) |
| A13 旧会话 | 搜索之前的 Model/Tool Execution 返回修订 0、空列表。ModelOutput 继续使用原严格投影，Trajectory 继续使用原事件格式；搜索证据独立读取。[空证据与原输出](../../../packages/agent/test/isolated/web-search/evidence.test.ts) · [严格 Trace 验证器](../../../packages/trajectory/test/protocol.test.ts) |
| A14 容量与授权 | 独立 HTTP 响应在流读期间限 2 MiB、交给模型的材料限 16 KiB；每个证据 Artifact 至多 64 KiB，同一 Execution 所有修订合计至多 1 MiB。多次调用与并发修订共享该限额；错误 Store、会话、Execution 或主体均不能读取。[提供商](../../../apps/service/test/isolated/web-search-providers.test.ts) · [Artifact](../../../packages/agent/test/isolated/web-search/evidence.test.ts) · [Service/Client](../../../apps/service/test/isolated/web-search-http.test.ts) |
| A15 Desktop 操作 | 配对 Client 验证保存及重复提交不会触发测试，凭据脱敏，显式命令只调用一次注入的测试端口；另有默认 Service Run 向受控搜索后端发出一次查询并通过 Client 读回证据。[桌面 IPC](../../../apps/desktop/test/native-web-search.test.ts) 与[渲染器测试](../../../apps/desktop/test/isolated/native-web-search-settings-dom.test.tsx)覆盖设置、切换、失联与错误提示。桌面状态页应核对已配置、未配置、关闭、多个提供商和旧服务，以及跳转到“提供商与模型”后返回的状态。真实运行、切换会话、报错与恢复仍需各桌面宿主的证据。[配置和凭据](../../../apps/service/test/isolated/web-search-settings.test.ts) · [HTTP](../../../apps/service/test/isolated/web-search-http.test.ts) |
| A16 压缩、切换与回退 | 只有匹配当前绑定的私有原生历史才进入下一次请求；关闭搜索、切换账户或后端，保留普通回答并去掉不适用的续轮状态。只读重开可独立读回搜索证据及原回答。新版恢复审核对已派发、缺少安全证明的原生请求拒绝按无副作用重放；在 Linux 的 SQLite 恢复实测中，本机 HTTP 服务收到请求后立即终止进程。前一版 `1e2c1b15` 重开时，普通对照恢复发出一次请求；内联与 Artifact 保存的两种原生决策均被拒绝，新增请求为零。压缩后的真实账户续轮和其他版本的降级仍需单独检验。[绑定与重开](../../../packages/agent/test/isolated/execution/native-web-search.test.ts) · [恢复审核](../../../packages/agent/src/storage/sqlite/recovery-audit-validation.ts) |
| A17 原生预授权 | 核实际会话、工作区信任及 full 模式；拒绝或能力未知时检查发出的模型请求没有原生搜索声明。逐查询审批沿普通工具路线处理。[权限](../../../apps/service/test/isolated/permission-configuration.test.ts) · [请求断言](../../../packages/agent/test/isolated/execution/native-web-search.test.ts) |
| A18 无正文时的进度 | 在本机模型流产生首段文字之前读取真实 Execution 的搜索活动；终态应停止该执行的刷新，切换时晚到结果不能覆盖新会话。实际两种桌面宿主仍需观察开始、结束和切换全过程。[流与持久进度](../../../packages/agent/test/isolated/execution/native-web-search.test.ts) |

本轮本机夹具不产生真实搜索服务的账户资格。官方 OpenAI Responses 原生、独立 OpenAI 搜索、DeepSeek Search 和 Perplexity Search 各自需要显式允许的一次真实查询。Codex 登录的认证与独立 OpenAI API 账户分开，在自身真实搜索与续轮获得证据前保持未确认。Windows 和 macOS 的发布安装、生产窗口和真实账户同样需要对应平台记录。
