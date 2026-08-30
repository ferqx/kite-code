# Service lifecycle 与恢复

本页描述single-Service shell与`@kite-ai/kite-local-runtime/manager`拥有的lifecycle。每个canonical Kite Home最多一个Service；Runtime、
History、App Control、Controller、Web/Agent API与Store 9均在该进程内组合。Coordinator/Worker/Gateway lifecycle只属于legacy迁移边界。

## 启动

manager先取得按canonical home digest隔离的native lifecycle reservation，再spawn exact source/installed `kite-service`并等待专用fd
readiness。Service启动顺序固定为：打开/验证`kite.sqlite` → 组合Runtime/Controller/Artifact backend → 绑定native endpoint与loopback HTTP
listener → reconcile旧Service instance的Controller lease → 发布ready。

任一步失败都不伪ready。manager只在exact child PID/start identity confirmed dead后清理本次reservation/socket；alive或identity uncertain保留
证据并fail closed。concurrent ensure由同一reservation串行化，只允许一个spawn。

Kite Home不保存descriptor、token、lock、launch intent或socket。POSIX每home runtime只允许`service.sock`与`service.lock`；
Windows endpoint使用named pipe。不同custom home相互独立，不另建跨home lease或coordination目录。
access/control capability在Service进程内生成并通过native握手返回，不形成durable credential file。

项目采用未发布clean cutover。普通启动不扫描、迁移或删除旧Store/layout/Artifact/process state及`.kite-code-coordination`，旧数据也不作为
current Store 9 fallback。

## 状态与停止

`status`和`stop`在Service absent时不spawn。普通stop先quiesce mutation gate：存在active operation时返回`service_busy`并恢复admission；
空闲时commit drain，control caller先收到accepted response，Service再停止新连接、等待有界response flush、关闭Browser/Runtime/Host/Store，
最后释放endpoint与reservation。

stop response丢失不授权自动重放。manager只沿原PID/start identity/reservation有界查询；confirmed absent收敛为成功，仍ready、alive/uncertain或
proof drift返回`outcome_unknown`。signal shutdown同样执行recovery-safe cancel/drain/dispose，但不是client disconnect。

## Restart 与 Controller

新Service只有在取得exact native reservation后才修改Controller restart state，并在ready前把旧instance的active lease转为detached。native
client保留logical resume secret，Service restart后旋转capability并恢复到新的connection generation。旧capability、旧service identity或跨
Workspace/Session绑定全部拒绝；恢复不启动Workspace Worker，也不读取Kite Home process state。

Runtime Session初始State/snapshot/command receipt/recovery identity/Controller state与receipt在同一Store 9 transaction提交；任一步失败整笔
rollback。Session删除同事务清理namespaced Controller/effect/resource/recovery authority，因此restart不会从filesystem sidecar拼接权威。

## Web

`kite web`在任何lifecycle访问前验证fixed asset root、`index.html`、OpenAPI和hashed JS/CSS。缺失返回`web_assets_missing`，不得创建DB、
endpoint或Browser session。asset有效后才ensure同一Service并attach Browser-only route；`web stop`只撤销route/session，不停止Service、
Runtime或Agent API。Vite dev server只服务前端资源，Browser打开URL也不拥有启动本机Service的权限。

## Release

candidate只包含`kite`、`kite-tui`、`kite-service`、三个对应stable launcher及Web/docs assets。manifest中的Coordinator、Worker、Gateway slot
必须为null，archive不得出现对应executable或launcher。v2 managed-install marker、唯一`active` pointer、`.candidate-id`与manifest共同绑定
immutable candidate root；installed resolver不回退source、cwd或PATH。

当前macOS arm64 build/verify/install/single-Service smoke、upgrade/rollback/uninstall已通过。Windows ACL/reparse、named pipe与
locked-directory publication，以及Linux/Windows完整candidate/process evidence，必须等待对应hosted runner，不能由本机结果推断。

验证：`bun run --cwd apps/kite-service test`、`bun test packages/kite-local-runtime/test`、`bun test tests/release`、`bun run typecheck`、
`bun run release:build`、`bun run release:verify`、`bun run release:smoke`。
