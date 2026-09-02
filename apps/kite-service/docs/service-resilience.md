# Service lifecycle 与恢复

本页描述single-Service shell与`@kite-ai/kite-local-runtime/manager`拥有的lifecycle。每个canonical Kite Home最多一个Service；Runtime、
History、App Control、Controller、Web/Agent API与Store 9均在该进程内组合。Coordinator/Worker/Gateway lifecycle只属于legacy迁移边界。
显式App Server daemon是独立KASD lifecycle：它不复用本页的Service build replacement、Native control token或Web readiness，见
[`runtime-server-carrier.md`](runtime-server-carrier.md)与仓库[`single-service-local-runtime.md`](../../../docs/active/single-service-local-runtime.md)。

## 启动

manager先取得按canonical home digest隔离的native lifecycle reservation，再spawn exact source/installed `kite-service`并等待专用fd
readiness。Service启动顺序固定为：打开/验证`kite.sqlite` → 组合Runtime/Controller/Artifact backend → 绑定native endpoint与loopback HTTP
listener → reconcile旧Service instance的Controller lease → 发布ready。

任一步失败都不伪ready。manager只在exact child PID/start identity confirmed dead后清理本次reservation/socket；alive或identity uncertain保留
证据并fail closed。concurrent ensure由同一reservation串行化，只允许一个spawn。

Kite Home不保存descriptor、token、lock、launch intent或socket。POSIX每home runtime只允许`service.sock`与`service.lock`；
Windows endpoint使用named pipe。不同custom home相互独立，不另建跨home lease或coordination目录。
access/control capability在Service进程内生成并通过native握手返回，不形成durable credential file。

App Server daemon使用独立owner-only endpoint与fixed exact protocol。普通client断开不改变owner；显式stop才取消active Turn、drain carrier并
清理exact reservation。status/stop在absent时不创建Kite Home或endpoint，start只回收PID/start/socket identity明确dead的旧owner。

项目采用未发布clean cutover。普通启动不扫描、迁移或删除旧Store/layout/Artifact/process state及`.kite-code-coordination`，旧数据也不作为
current Store 9 fallback。

## 状态与停止

`status`和`stop`在Service absent时不spawn。普通stop先quiesce mutation gate，再读取Host-owned长生命周期Session operation：存在active
mutation或queued/running/waiting Turn时返回`service_busy`并恢复admission；空闲时commit drain，control caller先收到accepted response，Service再停止新连接、等待有界response flush、关闭Browser/Runtime/Host/Store，
最后释放endpoint与reservation。
同一Service收到并发authenticated control stop时共享一个request-stop flight；该flight进行中到达的ordinary stop或signal也加入同一barrier，
只执行一次quiesce/commit/owner cleanup；busy/ready结果释放flight供
后续显式重试，accepted draining保持共享，若延迟cleanup最终失败则terminal unavailable覆盖早先accepted结果。并发busy callers共享同一
结果；active work结束后的第一个retry创建一个新flight并只执行一次后续quiesce/cleanup。

stop response丢失不授权自动重放。manager只沿原PID/start identity/reservation有界查询；confirmed absent收敛为成功，仍ready、alive/uncertain或
proof drift返回`outcome_unknown`。signal shutdown同样执行recovery-safe cancel/drain/dispose，但不是client disconnect。

## Restart 与 Controller

新Service只有在取得exact native reservation后才修改Controller restart state，并在ready前把旧instance的active lease转为detached。native
client保留logical resume secret，Service restart后旋转capability并恢复到新的connection generation。旧capability、旧service identity或跨
Workspace/Session绑定全部拒绝；恢复不启动Workspace Worker，也不读取Kite Home process state。

Runtime Session初始State/snapshot/command receipt/recovery identity/Controller state与receipt在同一Store 9 transaction提交；任一步失败整笔
rollback。Session删除同事务清理namespaced Controller/effect/resource/recovery authority，因此restart不会从filesystem sidecar拼接权威。

## Web

source入口先构建fixed Web assets；Service在发布ready前验证`index.html`、OpenAPI和hashed JS/CSS并挂载Browser route。缺失时整个
Service启动失败，不发布部分ready状态。`kite web`只ensure Service并返回稳定根地址；Browser logout只撤销session，route随Service stop
关闭。Vite dev server只服务前端资源，Browser打开URL也不拥有启动本机Service的权限。

## Release

candidate只包含`kite`、`kite-tui`、`kite-service`、三个对应stable launcher及Web/docs assets。manifest中的Coordinator、Worker、Gateway slot
必须为null，archive不得出现对应executable或launcher。v2 managed-install marker、唯一`active` pointer、`.candidate-id`与manifest共同绑定
immutable candidate root；installed resolver不回退source、cwd或PATH。

当前macOS arm64 build/verify/install/single-Service smoke、upgrade/rollback/uninstall已通过。Windows ACL/reparse、named pipe与
locked-directory publication，以及Linux/Windows完整candidate/process evidence，必须等待对应hosted runner，不能由本机结果推断。

验证：`bun run --cwd apps/kite-service test`、`bun test packages/kite-local-runtime/test`、`bun test tests/release`、`bun run typecheck`、
`bun run release:build`、`bun run release:verify`、`bun run release:smoke`。
