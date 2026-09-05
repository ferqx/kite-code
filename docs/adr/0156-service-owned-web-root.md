# ADR-0156：Service 启动即拥有同源 Web 根页面

状态：accepted

日期：2026-08-31

决策者：用户直接指令

相关：ADR-0152、ADR-0155、[`Service 同源 Web 根页面实施方案`](../space/plans/2026-08-31-service-owned-web-root.md)。

## 背景

ADR-0155 已将 Web 业务数据收敛到唯一 Service 的只读 `/v1`，但仍保留 `web_ensure/status/stop`：Service 可以先 ready，之后再由客户端
提交静态资源路径、挂载 Browser route 和启动独立 Web lifecycle。这使“一个 Service、一个地址”在用户侧仍表现为两个需要理解和操作的
服务，也让 TUI 启动后 Web 不一定可用。

用户要求 Service 与 Web 是同一个产品入口：启动 Service 后，访问 Service 地址默认进入 Web；TUI 只启动/复用 Service，不再启动或 attach
另一个 Web 服务。

## 决策

1. Web 静态资源是 source/release Service 的必需启动输入。Service 在发布 ready 前验证并挂载资源；资源缺失时整个 Service 启动失败，不能
   形成“API ready、Web absent”的部分状态。
2. 唯一 loopback listener 同时提供 `/`、`/index.html`、`/assets/*`、`/api-docs`、`/v1`及既有Native/Runtime route。`GET /`签发短期
   one-shot launch token并重定向到`/index.html#token`，Web仍通过Browser exchange换HttpOnly cookie。
3. 删除独立 Web lifecycle 及Native `web_ensure/web_status/web_stop`。Native IPC只保留无持久状态的`web_launch`，用于CLI/TUI重新签发可打开
   URL；它不挂载资源、不启动进程、不改变Service readiness。
4. `kite web`只确保唯一Service并打印新的launch URL。`web status`和`web stop`退出公开命令面；Browser logout只撤销当前Browser session，
   Web route与Service同生共死。
5. source开发入口负责先构建Web资源；installed candidate继续使用immutable `payload/web`。TUI连接、Browser关闭和Browser logout都不停止
   Service。

本决策局部替代ADR-0155与ADR-0151中的独立Web attach/status/stop lifecycle；其single-Service、只读REST、Browser cookie安全、
path-free DTO和无SSE/业务WebSocket结论保持不变。

## 后果

- 用户只需理解和启动一个Server；其根地址就是Web入口。
- Service readiness同时证明Runtime/API与Web静态资源可用。
- 不再存在Web absent/ready状态、asset root由客户端注入、Web stop后API独活等组合与测试矩阵。
- 每次打开仍签发一次性Browser URL，直接访问根地址不会暴露Native/Agent credential。

## 非目标

- 不自动打开系统浏览器；CLI只打印可点击URL。
- 不开放LAN/remote、多用户、Browser mutation、SSE或业务WebSocket。
- 不把TUI迁移到REST，也不让Browser获得Service启动权限。
