# ADR-0158：本地只读 Web 使用根页面 session，不使用 launch token

状态：accepted

日期：2026-08-31

决策者：用户直接指令

相关：ADR-0155、ADR-0156、ADR-0157。

## 背景

single-Service 已把 Web 静态资源与只读 `/v1` 放在同一个 loopback listener，且 `GET /` 已能建立短期 HttpOnly Browser
session。继续保留 Native `web_launch`、URL fragment 与 Browser exchange 会形成第二条等价启动协议：CLI/TUI 每次生成不同地址，Web
还要处理 token 捕获、清理、兑换、过期和容量，但这些机制没有对应的 remote、多用户或 Browser mutation需求。

## 决策

1. 本地 Web 的规范地址固定为当前 Service 的 `http://127.0.0.1:<port>/`。`GET /`直接返回 index，并创建或复用短期、只读、
   HttpOnly、SameSite Browser session。
2. 删除 Browser launch token registry、URL fragment捕获、`POST /v1/auth/browser/exchange`、Native `web_launch` operation及其Client方法。
3. `kite web`、`server`输出与TUI `/web`只通过既有single-Service manager确保Service ready，再用Native `describe`中的`httpOrigin`生成根地址。
   它们不attach route、不启动第二进程，也不取得Browser、Runtime或Controller权限。
4. 保留Native access/control token与Agent capability exchange。前者保护进程、Runtime和控制能力，后者绑定Workspace-scoped Agent context；
   它们不因本地只读Browser简化而移除。
5. Browser logout继续使用`DELETE /v1/auth/browser/session`。Service stop/restart撤销全部内存Browser session；关闭页面不影响Service。

本决策替代ADR-0157中保留`web_launch`与fragment exchange的第3条。ADR-0157的根路径直接200、read-only cookie和规范入口结论继续有效。

## 安全边界

- listener固定loopback并校验exact Host/peer；Browser `/v1`继续要求HttpOnly cookie、same-origin Fetch Metadata、无Authorization，存在Origin时必须exact。
- Browser principal只开放Workspace、Session、History与Checkpoint读取；mutation、Native route、Controller与SSE保持不可达。
- session只存在Service内存并受TTL/容量限制，不写Kite Home，不产生跨重启恢复或兼容路径。
- 本决策不开放LAN/remote、多用户认证、Browser mutation或Desktop IPC；这些需求必须重新决策。
