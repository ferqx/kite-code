# ADR-0155：单 Service 下 Web 收敛为只读 REST 客户端

状态：accepted

日期：2026-08-31

决策者：用户直接指令

相关：ADR-0147、ADR-0149、ADR-0152、ADR-0154，
[`Web REST 客户端收敛实施方案`](../space/plans/2026-08-31-web-rest-client-convergence.md)。

## 背景

当前正式source/release已经收敛为每个canonical Kite Home唯一Local Service、唯一Runtime Host、唯一Store 9 writer、唯一
`kite.sqlite`和一个loopback HTTP listener。TUI/CLI通过Native client复用该Service；Web则通过独立的Browser bootstrap、tab、Directory、
History和WebSocket Observer contract读取另一套Browser projection。与此同时，`/v1` Agent API已经拥有Session、History、Checkpoint
read contract与同源OpenAPI，但Web只展示静态`/api-docs`，不消费真实API。

这导致Web与Server形成平行业务面：Workspace/Session目录、History、状态、分页、错误与live恢复分别由Web Observer和Agent API实现。
继续在两条路径上同时增加Run、Interaction、mutation或stream会扩大重复authority与测试矩阵。

OpenCode的可借鉴原则是TUI、Web和SDK都作为Server客户端，并可通过attach共享同一批Session与状态；但OpenCode允许显式启动额外Server，
不提供Kite所需的per-home唯一Runtime/Controller owner。Kite保留现有single-Service lifecycle，只采用“多个薄客户端连接同一Server”的原则。

## 决策

### 1. 保留每个Kite Home唯一Service

TUI、CLI、`kite web`与未来本机客户端继续通过同一个`KiteServiceManager.ensure()`定位或启动Service。并发ensure只有一个启动者取得
reservation，其他调用等待并复用同一ready owner。build/contract不兼容、process identity不确定或reservation无法证明死亡时fail closed，
不得启动第二Service。

客户端退出不停止Service：TUI退出只释放自身Runtime/Controller连接，Browser关闭或`web stop`只撤销Browser session；只有显式
`service stop|restart`改变Service进程生命周期。Service继续独占Runtime Host、active Run/Interaction、MCP/Shell child、Store writer和
`kite.sqlite`。多个Server共享SQLite不进入当前产品范围。

### 2. `/v1`成为Web唯一业务数据面

Web改为同一Service `/v1` API的只读客户端。首个cutover只开放并消费：

- Workspace list；
- 一个Workspace下的Session list；
- Session get；
- Session History分页与增量读取；
- Session Checkpoint list/preview。

Browser不再通过`/_kite/web/directory`、`/_kite/web/history`或`/_kite/web/client`取得业务数据。完成Web cutover的同一Task必须删除对应
生产route、transport调用和重复projection，不保留dual read或fallback。Web页面继续使用path-free DTO，不取得canonical Workspace path、
Store path、credential、Native capability、Controller binding或raw Runtime event。

本阶段只使用普通HTTP JSON request/response；不新增SSE、业务WebSocket、long-lived app protocol或Browser mutation。运行中Session的
近实时展示由有界、可见性敏感的REST重新验证完成；后续只有实测证明轮询不能满足产品需求时，才另行决定事件transport。

### 3. Browser认证保留一次性交换，但纳入REST auth namespace

`kite web`仍先完成immutable asset preflight，再ensure同一Service并签发短期、一次性launch token。Browser从URL fragment捕获token、
同步清除fragment，并调用`POST /v1/auth/browser/exchange`换取内存持有、HttpOnly、SameSite Browser session。退出使用
`DELETE /v1/auth/browser/session`。

Browser JavaScript不保存Agent API bearer、Native access token或Controller secret。Browser cookie与外部Agent bearer由不同auth middleware
解析为不同principal，但成功认证后调用相同read handler/query authority。Browser principal只允许path-free service-scoped discovery与
observer read；现有Agent principal继续绑定exact Workspace。Origin、Host、Fetch Metadata、CSRF、body/header bound和`no-store`规则不放宽。

该决定部分替代ADR-0147/0149中“Browser只消费独立Web companion contract、不得进入Agent API data plane”的结论，但不开放Browser
mutation、Controller、credential custody、LAN、remote或multi-user。

### 4. TUI本阶段不迁移transport

TUI继续使用当前Native client、private Runtime Protocol、Controller binding和subscription。此次只要求TUI入口与Web入口共同通过同一
single-Service manager，并补齐TUI-first、Web-first、同时ensure、build mismatch、退出与restart的跨入口验证。

只有当REST mutation、Interaction、Run wait/event delivery与presentation fidelity全部达到现有TUI能力，而且迁移能删除而不是复制现有
Native路径时，才另立Task决定TUI是否消费REST client。本ADR不提前接受该迁移。

### 5. OpenAPI与Browser client来自同一contract

Workspace与Browser auth read contract进入`@kite-ai/agent-api-contract`的同源codec/OpenAPI/schema生成。Web只依赖browser-safe HTTP client与
public DTO，不导入Service、Runtime、Store或Native connector。静态`/api-docs`展示同一artifact；页面存在不代表当前principal拥有所有
contract operation。

## 后果

- TUI、Web与未来客户端共享同一Service、Runtime和数据库事实，不要求同一阶段统一transport；
- Web不再拥有独立Session/History业务后端，API、OpenAPI与实际Web消费对齐；
- single-Service manager继续承担并发启动、identity与build一致性，不把SQLite误当作跨Server execution authority；
- Browser获得只读`/v1` data-plane能力，因此需要新增principal、cookie exchange与route authorization的跨边界测试；
- 暂不提供Web mutation或事件stream，运行中Session使用有界REST重新验证；
- 已接受ADR-0147/0149保留历史，其Browser companion-only结论由本ADR局部替代。

## 备选方案

### 多Server共享一个SQLite

拒绝。SQLite只能串行化数据库写入，不能统一active Run、Session mailbox、Controller、Interaction、MCP、Shell child、取消和drain等
进程内authority。

### 本阶段同时把TUI迁移到REST

拒绝。当前TUI依赖完整command/subscription/Interaction/rewind/fork/compaction与presentation fidelity，而production `/v1`仍主要是只读
surface；同步迁移会把Web read cutover扩大为全Runtime client重写。

### 保留Web BFF并在内部调用`/v1`

拒绝。它保留重复route、DTO和错误面，只是把重复从Store查询移到HTTP proxy，不能降低客户端或测试心智负担。

### Browser直接保存Agent bearer

拒绝。Browser使用独立HttpOnly session和read-only principal，不让JavaScript持有长期Agent或Native credential。

## 回滚

生产cutover前可以删除新增Browser auth/Workspace contract和Web REST client，不改变当前TUI或Web Observer。cutover Task必须原子切换Web并删除
旧Browser业务route；若验证失败，回退整个Task到旧Web Observer版本，不在同一build中运行dual read或silent fallback。已经存在的Service、
Store 9和TUI Native路径不受影响。
