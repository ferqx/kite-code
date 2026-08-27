# Runtime Authority Boundary 与 Threat Model

状态：active

读取时机：修改 Runtime authority、Client/Protocol/Server carrier、identity、Grant/Receipt、持久化、子进程协议、Model/MCP transport、Credential broker 或 Runtime State/SQLite Store 时。

验证：`bun test packages/runtime-host/test/control-frame.test.ts packages/runtime-host/test/persistent-command-crash-windows.test.ts packages/runtime-host/test/mcp-stdio-process.test.ts packages/runtime-storage-sqlite/test/store-conformance.test.ts packages/kite-local-runtime/test/manager apps/kite-service/test/isolated/carrier/native-loopback-carrier.test.ts apps/kite-service/test/isolated/runtime-command-restart.test.ts apps/kite-service/test/isolated/runtime-server-multi-client.test.ts apps/kite-service/test/isolated/runtime-transport-conformance.test.ts apps/kite-service/test/isolated/execution/posix-supervisor.test.ts tests/qualification/sandbox/windows-restricted-token.test.ts apps/kite-cli/test/keyless-runtime-startup.test.ts`、`bun run typecheck`、`bun run check:runtime-packages`、`bun run check:docs-impact`、`bun run check:docs`。

相关：ADR-0053、ADR-0123/0124/0125、ADR-0127、ADR-0142、ADR-0143。

## 当前可信域

Agent Kernel、Runtime Host、Builtin Runtime、Protocol/Server/Client 与 App composition 可以位于同一可信进程。Package/export、对象 checksum 或 HMAC 不能隔离同一进程中的恶意代码，因此同进程 typed seam 不使用 secret-key authenticity。Client input、Protocol message、磁盘 bytes、子进程输出、远端 endpoint 和 OS resource identity仍在各自真实边界重新验证。

当前不建立持久 Project authority。Project identity 是 Runtime Host 从 native canonical Workspace realpath
确定性派生的标识；Session 创建只接受 Workspace/Session facts。Coordinator 必须复用 Host 的同一
`resolveProjectIdentity()` 结果校验 durable digest，不能把 Builtin sandbox 用于边界比较的 Windows
case-folded path 再次哈希成第二个 Project identity。二者仍指向同一真实 Workspace，但只有前者拥有
持久 Project digest，后者只拥有 path containment/equality 语义。不存在 `ProjectIdentityStore`、
`ProjectHandle`、installation revision/nonce/expiry，也不存在进程级 single-Host 全局锁。Service App是
唯一 composition root，Host/Store operation 仍各有一个 production owner。

## Runtime Server / Client authority boundary

`RuntimeAccess` 是唯一 execution backend seam，Host 是其唯一 owner：拥有 Session mailbox、lifecycle、revision fence、recovery、notification routing 与 persistent receipt lookup/commit。`runtime-server` 只接收 `RuntimeAccess` 加 App-owned admission port；它拥有 connection resources 与 bounded delivery，绝不拥有 domain waiter、Session reducer、Host、Store、Kernel、Builtin module、SQLite reader 或 history authority。`runtime-client` 是 transport-neutral 的，只拥有 correlation、explicit reconnect/resubscribe 与 generation/snapshot state，不拥有 execution authority。

App 为Server提供backend default admission，并可为每个logical connection绑定不同的canonical trusted Workspace。
admission可以authorize frozen operation，但绝不从`clientInfo`、display name或request body派生authority，也不command、
cache domain state或写revision。只有create mapper使用connection admitted Workspace替换不可信wire path；
resume/query/subscribe/fork按唯一Store中的持久Session identity解析，并与connection Workspace完整
`canonicalPath + projectId + workspaceDigest`交叉校验。process-wide list query只由Store owner回答，不注入caller
Workspace。connection close释放admission/subscription/interaction binding，不取消Runtime work或关闭Host。

`RuntimeWorkspaceContextFactory`按完整identity缓存per-Workspace config/model/MCP/Skill/shell context，Router按Session
identity选择context；同digest不同canonical facts、跨Workspace改绑和fork均fail closed。Runtime Application的
operation gate统一Runtime与App Control mutation，quiesce阻止新admission并等待active临界区。App Control mutation
保留exact revision CAS，lost response/`outcome_unknown`只允许query state后显式决定，不能自动重放。
只有`apps/kite-service/src/composition.ts`组合Host、Server、Store、Builtin、carrier与local auth。它还拥有raw History
projector/SQLite readonly reader、Workspace-scoped App Control与default Store lifecycle。TUI与foreground CLI只有Native
`RuntimeClient → RuntimeServer → RuntimeAccess`一条production path；完整history独立走
`RuntimeClient.history → RuntimeHistoryClient → Service exhaustive client-event projector → RuntimeLogQueryPort → SQLite
readonly reader`。`apps/kite-cli`不依赖Host、Server、Builtin、SQLite或Runtime SPI，不创建embedded/default Store，
也不在Native连接失败时回退旧owner。

Native connector只读取exact descriptor与access token，先准备authenticated no-secret App Control，再在Trust通过后取得
Workspace-bound one-shot ticket并组合Runtime WebSocket、三个History HTTP route与exact App Control/credential client；
connection从不取得control token。每个HTTP请求绑定发起时的Service instance与connector identity generation，旧instance
迟到响应在reconnect后拒绝；Runtime reconnect按generation清空旧index/readiness/ephemeral stream并重新订阅。History
transcript逐条复用closed`RuntimeClientEvent`validator，unknown或带额外字段的event不能跨Native边界。client close只
释放本connection、subscription与snapshot state，不取消Session/Turn或dispose Host。

本地 presentation DTO 与 observability 是不同边界。按 ADR-0143，closed `RuntimeClientEvent` 可以保留有界
reasoning segment、动态 tool label、普通 path/pattern/command/arguments、stdout/stderr/result 与 user-cancel
cause，使 live 与 replay 由同一 TUI reducer 组装；明显 credential/authority material 仍过滤，raw RuntimeEvent、
State、Store handle 和 settlement callback 仍禁止。该本地内容不进入 metric、diagnostic 或远程 reporter，
也不把 development WebSocket 提升为 production Web。

Protocol V1 是 exact、repo-private contract：只接纳 JSON-RPC `"2.0"`、exact V1 version/schema、bounded string IDs、object params 与冻结的 method/event allowlist。unknown、malformed、oversized、unsafe 或 pre-initialize input 在 Host mailbox、Store 或 effect 之前 fail closed。transport 不创建第二 execution path：不存在 sidecar Server、第二 listener owner、第二 Store writer、dual write、alternate transport fallback 或 catch-new-then-old compatibility branch。

Local Service infrastructure 不改变上述可信域。`kite-app-contract` 只允许 no-secret exact projection/action；
raw Provider API key、MCP OAuth 与 Service lifecycle 只存在于 `kite-local-runtime` Native codec。Local descriptor 只包含
instance/PID/start time、exact loopback endpoint、Protocol/client-contract revision、server version 与 build ID；token、
Workspace、Store/executable path、credential 与 Session 字段由 strict codec 拒绝。`access`/`control` token 是不同
restart-scoped material，connection interface不取得 control token。`kite-local-runtime/service`拥有POSIX
no-follow/owner-only primitive，以及Windows current-user SID、protected owner-only DACL、non-reparse verifier；两者都在
敏感访问时重新验证identity/permission drift并fail closed。`apps/kite-service`拥有production loopback carrier、required-port shell与唯一default
Runtime composition，`kite-local-runtime/manager`拥有terminal/release共用的dead-only stale manager。manager先用
`GET /readyz`检查liveness，再用access token、exact`{}`body调用`POST /_kite/instance`；response必须严格等于closed
`{schema, instanceId, protocolVersion, clientContractRevision, serverVersion, buildId}`shape并与descriptor的instance/
Protocol/client-contract/serverVersion/build identity一致。server identity drift、malformed或无关listener返回
`unavailable/identity_uncertain`；descriptor/expected build mismatch返回`incompatible/build_mismatch`。两类都保留state、
`spawn=0`且绝不kill。handshake拒绝query、cookie、wrong Origin/Host、non-JSON content type、非POST和非exact body；
该instance proof也不创建persisted Project authority或跨Host Store fence。

## Authority sequence

```text
Proposal
  -> Kernel Intent
  -> Policy / user approval
  -> exact prepared operation
  -> durable attempt acknowledgement
  -> external dispatch
  -> bounded result / cleanup fact
  -> Kernel acceptance and recovery decision
```

Kernel 只拥有纯 Intent、Policy/approval、result acceptance 与 recovery/completion decision；Host 负责持久化、claim、supervision、transaction/revision fencing 和 Mailbox；Builtin 负责具体 Model/Tool/MCP/Sandbox 语义。Notification、日志、模型文字和 transport success 不能回流成 Kernel fact。

## 真实边界

| Boundary | 当前机制 | 明确不提供的保证 |
| --- | --- | --- |
| 同进程 command/grant/receipt | strict schema、exact identity、freeze、TTL、single-use、revision/CAS | 不使用 secret key；不抵御恶意同进程代码 |
| Runtime Protocol / Server | exact codec/allowlist/limits、App admission、queued+in-flight byte reservation、cursor-ahead reset、ack-before-notification | 不创建 Runtime/Store/Kernel authority，不把 transport success 当作 domain fact |
| SQLite Store | Runtime State exact codec、SQLite Store marker、canonical event JSON、snapshot checksum、transaction/revision/effect lease | checksum 不是同用户 writer authenticity |
| Private Artifact | SHA-256 内容寻址、canonical schema、owner-only/no-follow、atomic publish、严格回读 | 不创建 installation key；digest 可被有写权限者重算 |
| POSIX/Windows sandbox | Host 创建的专用 pipe/handle、PID/PGID/Job/process identity、strict bounded control frame、peer/invocation/sequence | 不传 secret，不使用 HMAC，不声称消息层 OS-user isolation |
| MCP stdio | Host-owned wrapper/process port、固定 command/args/cwd、显式 env、bounded JSON-RPC、ready/terminal control frame | MCP initialize 不是 authority；Builtin 不直接 spawn |
| MCP HTTP | exact endpoint/boundary、TLS、OAuth/bearer credential、bounded argument inspection | 不增加本地 content-egress permit 或伪远端签名 |
| Model Provider | resolved route/surface identity、Provider TLS/auth、single-attempt transport | 不使用 release-pinned route allowlist、正文准入或 DataOrigin/EgressAuthority |
| Credential | shared CredentialBroker、OS keyring、purpose-bound opaque handle、使用点物化 | secret 不进入 Event/State/Receipt/Notification/log |
| Filesystem/process effect | exact path/process identity、no-follow、prepared operation、native sandbox、cleanup evidence | 不是消息 seal 问题 |

## Control frame

`RuntimeControlFrame` 是严格结构化的进程控制协议，不是密码学 envelope。它固定 schema、domain、peerId、invocationId、单调 sequence 与 exact payload；unknown field、wrong peer/invocation、replay、truncated/oversized/noncanonical payload 都 fail closed。POSIX 与 MCP stdio 通过继承 FD/专用 stdin 建立 wrapper channel；Windows 使用 runner control stdin/stdout 与 Job/process handles。实际用户命令不继承 Host control channel。

ready 只在 wrapper/runner 验证 control frame 且即将启动 exact child 前产生；Host 验证 ready，并完成 durable acknowledgement 后才进入 GO。pre-ready 失败必须保持 user process dispatch 为 0；terminal/cleanup unknown 不允许自动重放或切换另一 owner。
MCP stdio wrapper的ready、JSON-RPC与terminal frame都必须等待stdout write completion后再推进生命周期；尤其最终terminal
frame未刷入专用pipe前wrapper不得退出。Host只接受实际收到并验证的terminal evidence，process exit或已写入用户态buffer
不能替代该证明。wrapper runtime返回的completion Promise只在terminal已写入或fail-closed child cleanup收敛后完成；
Service standalone internal entry与executable module root都必须await该Promise，不能以fire-and-forget `.catch()`在安装
event listener后提前结束模块求值或主入口。
terminal写入后wrapper还必须显式结束stdout并等待stream close callback；普通write callback在Windows standalone上
不足以证明最后一个pipe frame已对Host可见。最终terminal control frame因此使用Bun standalone原生stdout write
Promise并校验返回的exact byte count，随后才结束stream；ready与普通JSON-RPC仍走异步背压路径。
Bun standalone的argv prefix可随平台变化；Service同时对显式command args与完整`process.argv`应用同一个
final-marker/competing-internal-mode validator，随后只把规范化的单一MCP marker交给wrapper runtime。Windows单路径
executable argv不能因`slice(2)`为空而落入普通Service命令解析或静默退出。

## SQLite Store 与 Artifact

新 Session 只使用 State 27 / Store 6 / `kite-runtime-server-v1-2026-08-26` 与 epoch 派生的 `.runtime-state-store-{generation}.db` current target。SQLite Store 当前 exact schema 是 **8 tables / 2 non-primary-key indexes**；没有 persisted authority codec、`authority_envelope`、DataOrigin/EgressAuthority/egress nonce ledger。Event 是 strict canonical JSON，Snapshot 以 SHA-256 checksum 检测损坏。写入/恢复 Store 时会校验目标会话的当前 Event/Snapshot；SessionStore 的会话发现只按序解码到第一条命名候选后停止，不以全日志解码阻塞 TUI 启动，具体会话恢复仍走 session-scoped 完整校验。历史 source 只要存在 WAL/SHM sidecar 就必须在隔离副本中读取；`SQLITE_OPEN_READONLY` 不足以保证 SHM 不被更新，真实 source 的 identity、mtime 与字节不得变化。只读日志 reader 打开时只校验数据库 marker 与表结构，并在读取某页时逐条解码该页事件。一个坏会话不能阻断其他正常会话的日志查询，坏事件所在页仍会明确失败。

`runtime_command_receipts` 是第八张表。它的唯一 key 是 `(scope_session_id, command_id)`；存储的 request digest、target Session、canonical original applied receipt 与 committed revision/time 把 replay 绑定到一个 exact command decision。同 scope/key 的不同 digest fail closed。State/event/snapshot/revision decision 与 receipt 在同一 Store transaction 提交；所以 commit 后、response 前的 crash 只能让同 ID retry 返回原事实，绝不再次 prepare 或 dispatch effect。parse/codec/auth/overload/transport failure 不创建 receipt。receipt retention 是刻意的：close、Session delete、target delete 保留 receipt；fork 绝不复制 source receipt；不设 TTL 或 capacity pruning；只有删除整个 Store 才会移除 metadata。

Session delete 同样是显式 Runtime command，不是 App/TUI 的 SQLite helper。Host 在 Session mailbox/lifecycle
边界串行化删除，Store 在一个 `BEGIN IMMEDIATE` 中写入 scoped applied receipt 并删除该 Session 的 durable
facts，但保留 receipt；Host 随后移除 registry projection，且不会再以 close snapshot 重建已删 Session。

State 26 / Store 5 / `kite-runtime-modularization-v1-2026-08-19` 与 State 27 / Store 5 / `kite-runtime-saq-v1-2026-08-25` 都是 explicit source-only compatibility profile，不是 writer。用户选中的 exact session 可以经 no-follow isolated copy atomic import 到 Store 6；unknown source 静默忽略，corrupt source 只隔离该 session。source bytes 永不写回、checkpoint、rename 或作为 fallback 执行。

不匹配 current marker 的 database 直接 fail closed。production package 不导出 old constructor/path，也不存在 Store 5 current writer、sidecar receipt database、hidden DDL drift、ignored receipt table、try-new-catch-old、dual write 或 mixed-format normalization。

## Carrier scope

stdio是Service-owned internal child I/O：bounded UTF-8 JSONL从stdin输入，stdout只承载protocol，diagnostics使用stderr；EOF只释放connection，不会创建新的Runtime owner，只有parent capability可以请求composition shutdown。默认terminal入口使用Service-ownedNative loopback carrier：只bind loopback，经restart-scoped token/ticket认证，并接受exact Host/Origin/CSP/no-CORS/frame/heartbeat checks。另有development/reference WebSocket carrier只用于conformance。两者都不改变ADR-0053：不能据此发布`kite server --web`、production Web UI或remote support claim。

Private Artifact 以 canonical bytes 的 SHA-256 内容寻址并返回 path-free ref。文件权限、no-follow、atomic rename、fsync、schema readback 与 Runtime receipt identity 共同检测损坏和混淆；不存在 `model-artifacts.key`、key loss 终态或无 Artifact dispatch fallback。

## 删除的推测性机制

以下名称不属于 production contract：Runtime/Artifact installation key、AuthorityKey/bootstrap/HMAC/authenticator、ProjectHandle/ProjectIdentityStore、single-Host global lock、persisted authority envelope、DataOrigin、EgressAuthority、Remote MCP permit/receipt、`providerDataPolicy` 与固定 Provider route policy。负向测试可引用旧文件名以证明它不会被创建，但不得恢复实现或 public export。

真实 API key、OAuth token 和系统 keyring credential 不在删除范围内；它们只用于连接外部服务，并必须通过共享 CredentialBroker 在使用点短暂物化。
