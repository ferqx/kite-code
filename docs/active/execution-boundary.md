# Production execution boundary contract

状态：active

读取时机：修改 `ExecutionBoundary`、production composition root、sandbox capability
projection、release-controlled execution policy 或对应 feature flag 时。

验证：`bun test apps/kite-service/test/isolated/sandbox/execution-boundary.test.ts apps/kite-service/test/sandbox/network-boundary.test.ts
apps/kite-service/test/sandbox/network-boundary-concurrency.test.ts apps/kite-service/test/isolated/runtime/tool-controller.test.ts
apps/kite-service/test/config/features.test.ts apps/kite-service/test/sandbox/status-projection.test.ts
tests/isolated/workspace/worktree-controller.test.ts tests/integration/builtin-runtime/mcp-transport-boundary.test.ts
packages/builtin-runtime/test/mcp-transport-boundary-concurrency.test.ts apps/kite-service/test/git-broker.test.ts
apps/kite-service/test/runtime/git-tool-controller.test.ts tests/integration/execution/workspace-filesystem-provider.test.ts
apps/kite-service/test/isolated/execution/sandbox-execution-provider.test.ts`、
`bun test --parallel=1 --max-concurrency=1 tests/tui-system/scenarios/sandbox-mode.test.ts`、
`bun run typecheck`、`bun run check:core-boundary`。

`.github/workflows/execution-boundary-conformance.yml` 的 path filter 与 adversarial command 必须共同覆盖
上述 App、qualification、isolated、integration 和 package owner 路径；迁移测试时不得只更新其中一侧。

相关：ADR-0051、ADR-0054、ADR-0061、ADR-0070、ADR-0097、ADR-0131、ADR-0137、
`execution-platform-support.md`。

## Schema ownership

RM-13 后 `packages/builtin-runtime/src/sandbox/types.ts` 是 `ExecutionBoundary`、逐维 backend capability strength、
qualification registry 和只读工具 effect contract 的类型来源。
`apps/kite-service/src/config/execution-boundary.ts` 是 Service 配置的严格解析、canonical digest、单调收紧和技术能力评估实现。
`apps/kite-service/src/config/execution-qualification.ts` 只从仓库固定路径读取 release-pinned
qualification registry，并校验 revision 和 digest；调用方不能提供 registry 路径、批准 digest
或 production qualification。同一 OS/Bun/backend/network admission key 只能有一个
qualification，resolver 也只接受恰好一个匹配。Digest canonicalizer 显式重建每一层字段，
使用与 locale 无关的 code-unit 排序；JSON 对象字段插入顺序不能改变结果。

用户、project config 和 CLI 不能提供 boundary。普通 `loadAgentConfig()` 不接受或投影
execution artifact，只服务现有开发入口。production composition root 必须使用
`loadProductionAgentConfig()`，同时提供 release profile 的 boundary 与 flag ceiling；只有
artifact ceiling 和合并后的 rollout flag 都为 `true` 才进入 sealed admission。任一层为
`false` 都只能收紧；显式 user、project、CLI/App 层按逻辑与组合，缺少全部显式 rollout 时默认
关闭，因此后层的 `true` 不能提升前层的 `false`。production loader 使用 boundary 对应的
canonical Workspace 加载 project config，不使用进程启动目录代替该 identity。

## Fail-closed admission

production root 在创建 Runtime、Shell、writer、Skill child 或 local stdio MCP 之前必须通过
`loadProductionAgentConfig()`；它内部调用 sealed `admitProductionExecutionBoundary()`。
准入同时要求：

- flag 开启且 boundary 严格有效；
- boundary 与实际 Workspace 的 canonical key 一致；
- 仓库固定的批准 registry 对实际 OS release/version、architecture、Bun、backend 和入口给出
  精确 qualification；
- native probe 与 runtime resolver 共用 `readExecutionEnvironmentIdentity()`，并要求同一
  qualification 同时绑定 TUI 与 foreground CLI 入口证据；
- backend 按 filesystem、network、process-tree、child inheritance 逐维报告 `enforced`；Linux
  候选还单独报告 syscall-filter strength。该字段进入 sealed
  `ExecutionBackendCapabilities` 与 registry canonical digest；缺少 native negative
  conformance 或不是 `enforced` 时 admission 以 `backend_syscall_filter_unsupported` fail
  closed。Seatbelt 使用独立 policy 机制，该字段可为 `unsupported`。旧 raw
  `PlatformCapabilityEvidence` 缺少新增可选字段时规范化为 `unsupported`，不得抛错或推断为已执行；
- production boundary 要求 sandbox 配置和 CLI/App runtime restriction 均未关闭，且当前不接受
  `full_access`；成功返回的 `ProductionAgentConfig` 把 sandbox 固定为 enabled，并携带
  release-approved qualification proof。

任一条件失败返回全 false capability surface，不进入审批。审批、`full` interaction mode 或
裸 shell fallback 都不能改变结果。

成功 surface 的 `network`、`process`、`write`、`shell`、`skillChild` 和 `localStdioMcp`
是彼此独立的能力轴，不得合并成一个“只要仍有 process 就全部披露”的条件。例如原生
`read_only` 可以保留受 sandbox 约束的 Shell process，但 `write=false` 仍必须在模型 disclosure
和 Runner dispatch 两层拒绝进程内 writer，`network=false` 同样拒绝进程内网络工具。两层门禁
都消费 Registry Capability Descriptor 的 declared/effective effects；Shell 的保守 `unknown`
descriptor 只由显式 `process + shell` surface 接管，实际 filesystem/network 继续由 native
sandbox 强制。ADR-0118 的 governed in-process file read 不属于原生 process external-path capability：
`read_file`/search 可使用 `external_read`，而 writer 仍要求 surface `write=true`，外部 mutation 另需 exact
approval。process capability 不能替代该 Pipeline authority。

`read_only_only` 是独立受限 surface：registry 必须携带 digest 校验通过的非空工具 catalog；每个
工具 descriptor 仍固定 `workspace_read + network:none + process:false + write:false + externalPath:false`；
这里的 `externalPath` 轴描述原生进程 capability，不否定 ADR-0118 的 Provider `external_read`。
其 capability surface 保留 catalog revision/digest、每个 descriptor revision 和完整 effect
contract，而不是只列 tool ID，并显式关闭 network、process、writer、Shell、Skill child 和
local stdio MCP。模型工具 disclosure 和执行 runner 都会把当前 builtin capability descriptor 的
revision/effects 与该 catalog 精确匹配；不匹配或动态 MCP 工具均 fail closed。进程 external path 仍拒绝，
governed file read 由 Provider scope 独立验证。技术
fixture evaluator 只返回 `technical_evaluation` 标记，且不从 App config
barrel 导出；production loader 只接受带 registry proof 的 `release_approved` decision。当前批准
registry 是空支持集，因此所有 production 配置加载都在返回可运行配置前拒绝；现有 TUI/CLI
仍是开发入口，不构成生产旁路。

## 单调组合与 identity

`tightenExecutionBoundary()` 只执行权限交集/限制收紧；不同 Workspace 禁止组合。解析后的
Workspace realpath、排序去重后的 host allowlist 和所有安全字段进入
`computeExecutionBoundaryDigest()`。字段、Workspace identity 或有效 allowlist 变化都会改变
digest，使旧 release evidence 失效。

## Network projection and durable admission

存在 sealed `ExecutionBoundary` 时，Runner 总是派生不可变 `NetworkBoundaryPolicy`。
`networkBoundary=false` 只会把 policy 收紧为 `off`，不会回到开发期 `networkMode=allow_all`。开启后，当前
唯一具备透明逐调用执行层的网络工具是进程内 `web_fetch`：每次 robots、正文和 redirect hop
都重新校验精确 allowlisted DNS host，解析全部实际地址并拒绝 IP literal、loopback、private、
link-local、metadata 与 reserved range；transport 使用已批准地址的 pinned lookup，且不消费
proxy environment。RM-11 后 SSRF、robots、正文提取与 worker 实现由
`packages/builtin-runtime/src/web/` 拥有，App 只注入既有 network boundary fetch mechanism。
这里只承诺 host 级 admission，不承诺 URL path 隔离。

每个 allow/deny 决定都带独立 invocation/hop、policy/endpoint revision 和 digest，并在任何已
批准 socket 打开前通过 `network.admission_decided` 写入 Runtime。decision store、resolver 或
observer 不可用时返回 typed `controller_unavailable`；并发 sibling 不共享 receipt，某个 denial
或 controller failure 不会覆盖或取消其他 sibling 已持久化的决定。这些决定保存在对应 Tool Call，
Tool Result 只投影 policy revision、receipt digests 与失败码，不保存
响应正文。

远程 HTTP MCP 在下述 DNS/endpoint transport admission 之外，还必须对最终参数执行一次
deep-frozen bounded JSON/schema/secret inspection。该检查、argument digest 与协议发送共用 await 前捕获的
immutable JSON-safe 快照，调用方后续修改原对象不会改变 wire payload。secret、受保护 credential
path 或无法在固定预算内检查的参数直接发送零请求。这不是第二套 content-egress authority，
不签发 permit/nonce/ledger receipt；Tool policy/approval、transport admission 与 CredentialBroker 仍各自覆盖真实边界。

当前原生 backend 不向任意 Shell/Skill descendant 授予结构性直连网络边界。Remote HTTP MCP
具有独立的 transport boundary：
connection、inventory、resource、Tool、OAuth 操作均绑定 canonical Workspace、execution boundary
digest、run/profile identity、network policy revision、canonical endpoint/endpoint revision 与单次
invocation/tool-call receipt；实际 SDK fetch 对每个请求和 redirect hop 复用 network enforcer 的
DNS/private/allowlist/pinned-address 检查，并忽略环境 proxy。并发 sibling 不能复用一次 receipt。
但是当前 production TUI 没有可签发这些 receipt 的 App controller，因此仍在 Provider readiness
前 fail closed；这与当前空 production support set 一致，不是已经开放 remote MCP 的声明。

## Native filesystem projection

macOS Seatbelt profile 在生成任何 allow rule 前 canonicalize Workspace 与受控 runtime temp。
Hardened Shell environment从只读`/private/var/select/developer_dir`解析当前Apple developer toolchain，并把其
真实`usr/bin`置于sandbox PATH首位；不得通过`/usr/bin/git`的xcrun shim写入Seatbelt scope外的
`DARWIN_USER_CACHE_DIR`，也不得为该cache扩大系统临时目录写权限。
每次 invocation 使用独立的 `0700` runtime directory；executor 在返回前先请求终止已跟踪的
process group，未确认退出时结果 fail closed 并保留 runtime，确认后再以不跟随 symlink 的物理
遍历恢复 hostile mode/BSD immutable flag 并删除该目录，删除不能确认时同样 fail closed。最后一个
invocation 还会用不递归的 `rmdir` 回收空的共享 runtime 容器；并发 invocation 使容器非空时该步骤
安全跳过。并发调用不能共享 invocation 目录，writable temp 也不进入 executable-map
allow root。`workspace_write` 只允许 Workspace 与该 runtime root 写入；`read_only` 不允许 Workspace 写入。系统与当前 Bun/Node runtime 依赖只有
显式只读 root；默认 scope 之外的 Workspace 外 read/write/create/unlink 与指向外部的 symlink 继续拒绝。
若 Policy 对 exact invocation 依据完整 effects/scope facts 密封
`filesystem=full_access` scope，则可访问 Workspace 外敏感 identity，native profile 不再
按名称二次拒绝；网络、进程、资源和真实宿主 ACL/TCC 边界保持不变。
按 ADR-0131/ADR-0135，canonical Workspace 是完整授权身份：Policy、Seatbelt、bubblewrap 与 Windows runner 不得因
`.git`、Agent/MCP 配置、credential、shell profile、隐藏名称或大小写别名对内部成员追加 deny；
Shell child 继承同一整 Workspace scope。`checkDangerousPaths()` 接收 canonical Workspace，把可证明位于其外的
固定 credential/persistence/system identity 分类为 `sensitiveExternalAccess`，按 ADR-0133 进入模式感知授权，
不再生成永久 deny；关键 destructive
command 仍由独立规则硬拒绝。
Building 阶段内，Policy 对可证明只作用于该 Workspace 的结构化文件 mutation 直接授权；native profile 仍执行
相同 workspace scope。raw Shell（包括 Git）在 Workspace baseline 内 direct；已知 external/sensitive scope 才按
Accept Edits exact approval、Auto 三态审查或 Full direct 路由，并在获批后按 effects 为该 invocation 密封 filesystem scope。
Planning 非 Full 使用 Workspace read-only baseline direct，已知扩 scope 进入同一 approval route；Planning + Full
仍直接执行 Full scope 并保持 Plan lifecycle。该规则不改变结构化只读 capability 的 phase 资格，hard deny 仍不可覆盖。
Seatbelt 的 `#"..."` regex literal 直接消费正则反斜杠；profile generator 必须只转义该 literal
的引号 delimiter，保留 `\.` 等单反斜杠 regex token，不能复用普通 Seatbelt string literal 的
反斜杠转义。生成器测试同时要求单反斜杠模式存在、双反斜杠模式不存在。

密封配置还会从同一份 path evaluator 编译两种投影。每项访问都携带 canonical target、未 realpath 的
lexical Workspace identity 与 `read`/`write`/`execute` operation；最近存在祖先先经 realpath，尚未创建的
后缀再拼回。文件 read evaluator 对有效路径 allow，Policy 对敏感 external direct read 或任何 external recursive
search 要求模式感知授权：Full 直接授权、Auto 三态审查、其他模式 exact approval；Workspace 内 write/execute 对全部名称 allow。该 trusted-Workspace
规则在 Windows、macOS 与 Linux 相同，不能因为名称看似 `.git`、`.env` 或其他受保护 execute identity 而拒绝
已授权的文件工具 mutation。Workspace 外 write 在 Full 直接授权、Auto 三态审查、Accept Edits 请求 exact
approval，并在获批后形成 `approved_external`。
execute/process 投影只把 Workspace 外路径作为非 Workspace identity；Workspace 内 additional deny、
allowlist 或 protected-looking name 不得缩小信任根。PS-01 后 Tool Pipeline 在 grant 签发前固定 evaluator revision，Local Provider 验证 canonical
Workspace、path scope 与 no-follow target identity；批准后的文件 mutation 不再重新应用 execute deny。
`read_file`、`write_file`、`edit_file` 和 search spec 通过
结构化 path-access 声明接入；Registry conformance 从完整 builtin tuple 派生所有
`filesystem!=none` spec。没有通用 path hook 的 `read_plan`、`read_skill_reference`、
`shell_execute`、`git_inspect`、`task`、`activate_skill` 必须分别登记由 typed Plan Artifact、Skill reference
allowlist、native sandbox、typed Git broker 的 shared protected-path/repository admission、child Harness 和 compiled inline/fork adapter 接管的闭合例外，因此新增
filesystem builtin 不能静默遗漏 evaluator。workspace-wide search 不按 protected 名称剪枝；`.gitignore`
只作为搜索语义。文件读取即使没有外部 mutation approval也可使用 `external_read`。

Seatbelt profile 只把共享固定目录/文件集合投影到 Workspace 外身份；Shell 的命令字符串扫描不再是权威 gate。
production execution surface 或 evaluator 任一缺失时，Runner 在任何 builtin adapter I/O 前拒绝。
普通 Task child 与 forked Skill 的文件工具都继承父级同一 `taskConfig` evaluator。local stdio MCP
manager 可接收同一 evaluator，并在 transport construction 前以 `execute` operation 拒绝
outside cwd 与 path-like executable，再把 canonical cwd 和 path-like executable identity
交给 transport factory。sealed transport identity 固定把 `localStdioMcp=false`：在存在真实
sandbox-backed stdio factory、argv/runtime pinning 与 native child inheritance conformance 前，
即使 capability surface bit 被错误设为 true 也以 `transport_denied` 拒绝，生产不会构造本地 child。
typed Git/worktree controller 仍是共享 checkout / worktree placement 的 App 授权主体；模型 Git
operation 仍按 Tool Policy 走下述 broker，但 sandbox 不再以 `.git` 路径名阻止通用 Workspace process。
文件访问不获得 Git transaction/locking 语义。

### Governed Workspace filesystem seam

PS-01 将进程内文件工具的 production filesystem authority 固定到
`LocalWorkspaceFilesystemProvider`。Execution boundary 与 Policy 先确定 canonical Workspace、path-policy
revision、effective effect 和 mutation 批准范围；Tool Pipeline 在 invocation/attempt durable ack 后把这些
事实密封进短时 grant。Provider 验证 `workspace_only | external_read | approved_external` operation scope 与
target identity；`external_read` 只允许 observe，`approved_external` 只来自 durable approved mutation。
Provider 不读取 mode、Policy 或 App 配置，也不能扩大授权。

mutation 的 prepare 只捕获 lexical/canonical/no-follow identity 与 preimage，保持零写入；私有 preimage
Artifact 和 `capability.filesystem_mutation_ready` 精确 ack 后才存在 single-use commit grant。commit 前
identity、preimage、expiry、cancel 或 final check 前的 symlink swap 任一不匹配都保持零文件写入。Unix
发布消费 pinned parent descriptor；final check 后的 parent swap 不能越界重定向，若因此失去 lexical terminal
certainty 则属于 commit-unknown。Windows 在 handle-relative backend 验收前 write/edit fail closed。不得尝试
旧 adapter 或 Local 二次 dispatch。旧 file/search 实现只存在于
`tests/helpers/` 差分 oracle；Fake deny/crash 也没有生产 fallback。该 seam 没有新增 feature flag，也不
改变 Runtime format epoch。

### Governed Sandbox execution seam

PS-02 将 confinement preparation 固定到 protocol-first `SandboxExecutionProvider`。RM-13 后该私有
Provider contract 的物理 owner 是 `packages/runtime-spi/src/sandbox-execution-provider.ts`；
`packages/builtin-runtime/src/sandbox/` 拥有 backend、protected-path、network、grant 与 Local Provider
领域语义，`packages/runtime-host/src/` 拥有唯一异步进程创建 primitive、POSIX supervisor、进程树终止和
有界 output drain，`apps/kite-service/src/sandbox/` 是唯一 native/host-shell availability composition root。已删除的
`src/protocol/sandbox-execution-provider.ts`、`src/core/sandbox/**` 与
`src/core/execution/sandbox-execution/*` 不得恢复为兼容 owner、实现或 spawn 路径。

Policy、approval 与
ExecutionBoundary 先冻结 canonical Workspace、精确 argv/command digest、network/filesystem mode、资源限制、
protected-path revision 和 cancellation correlation；allocating Local Provider 只有在 Tool invocation/attempt
与 `capability.sandbox_preparation_intent_recorded` 都 durable ack 后才收到 sealed prepare grant。Provider
只返回 immutable data-first plan、backend capability evidence 与 cleanup handle，不拥有 Runtime Event、State、
Policy、approval 或 process spawn。

prepared consumer 必须区分“要求后端强制的限制”与“用户已经批准移除该维限制”的 development scope。
POSIX 的 `workspace_only/read_only` 与 `network=disabled` 继续要求对应 backend evidence 为 `enforced`；
`filesystemMode=allow_all` 与 `networkMode=allow_all` 则是 exact invocation 已密封的 unrestricted projection，
不能再映射成 production `filesystem.full_access` 或 `network.allowlist` evidence 并二次拒绝，也不能据此把
这些 production evidence 标为 `enforced`。Windows lower-assurance V6 development path 同样消费其已声明
scope，但 `network=allow_all` 仍必须与同一次批准的 `filesystem=allow_all` 配对。command identity、grant、
expiry、durable lifecycle、backend digest 和 hard deny 的全部复验保持不变。

Pipeline 把 private preparation Artifact 与 `capability.sandbox_preparation_ready` durable ack 绑定后，Runtime
consumer 才能单次消费 plan。consumer 在 spawn 紧前重验外层 invocation 的 tool call、capability revision、
effective-effects/admission、Workspace、attempt 以及 preparation/ready/dispatch/plan digest、expiry 与
cancellation；`cwd` 必须等于冻结的 canonical Workspace。backend discovery 只返回静态候选，bubblewrap/cgroup
等真实 usability probe 只能在 allocating intent durable ack 后由 Runtime lifecycle consumer 调用。consumer
负责 durable identity/plan 重验并把已批准 argv 交给 Host；只有 Host process supervisor 可以实际 spawn，
并负责 timeout、bounded output drain 与 descendant cleanup。Builtin Provider 不能通过异常、不可用或 cleanup
失败回退到第二个 process owner。

POSIX allocation 把 host-only `controlRoot`（socket、lock、identity）与 sandbox-writable `dataRoot`（TMP/cache）
放入两个独立 private base；profile/bind 只能包含 data root。即使 full-access 已授权用户文件系统，macOS
Seatbelt 也显式拒绝整个 control base，Linux mount namespace 则以只读空 tmpfs 覆盖整个 control base，使当前及
并发 invocation 的 Host-control identity 都不可见。目录创建、权限与递归
删除通过 no-follow/pinned descriptor 交叉验证，确认完整后代退出后先删 data、再删 control 和 allocation；首个
合法 control connection 被接收后立即停止 listen。cleanup 失败保持同一 disposal/abandonment intent 为 pending，
记录 `lastFailure` 与递增 attempt；下一次 recovery 至多执行一次新 attempt，不重新 prepare/spawn，只有成功 receipt
才进入 completed。Fork 不复制任一当前或历史 named snapshot 中仍 pending 的 cleanup authority。

Windows development allocation 使用 preparation digest 派生的单一 runtime directory。无论 prepare 在 ready 前失败，
还是已 ready 的 invocation 在 dispatch 前中止，consumer 与 Windows executor 都必须在签发 cleanup grant 前或
receipt 确认后的收尾阶段清理并确认该 exact entry；两者复用同一 no-spawn cleanup routine，避免 allocator 返回的
real path 与环境临时目录的别名造成执行成功后被误报为 cleanup failure。其路径从最近存在祖先 canonicalize 后按临时根的 direct-child 规则验证，并在同一 canonical 临时根下以
固定 basename 删除，避免 macOS `/var` 与 `/private/var` 别名把合法 cleanup 误判为越界。base 自身为 symlink
必须拒绝。cleanup 或 receipt 未确认时必须保持
fail closed。executor 已删除 exact entry 且最后一个 allocation 同时回收空 runtime base 时，随后 Provider 的
同一 exact-entry reconciliation 是已确认的幂等成功，不得把缺失 base 误报为 cleanup failure。
Runtime allocation descriptor 在平台提供数值型 `process.getuid()` 时额外比较 owner UID；该 API 不存在时
不得把 `undefined` 当作 owner mismatch，而是继续依赖 no-follow、file type、link count、dev/inode 与平台 ACL
边界。唯一 owner 例外是 `tmpdir()` 本身为 root-owned、sticky directory；受管 base/allocation/control/data
仍必须归当前 UID 所有。Windows/Linux CI 必须复测这些分支，不能因宿主 API surface 或共享 temp root 差异在
Provider dispatch 前误拒绝合法目录。
`cleanupConfirmed=false`，不得 host fallback 或把调用标为已清理。

Linux bubblewrap 的候选 hard-count contract 已固定 Runtime 生成的唯一 systemd scope unit、`--unit=...`
argv 与 strict path/kill/empty candidate parser；但当前 dispatch record 尚不能在 GO 前 durable ack 实际
ControlGroup identity，也不能持久化 empty receipt。故 Local Provider 对 `maxProcessTreeTasks` 继续
以 `cgroup_pids_cleanup_authority_unavailable` fail closed，不生成可执行 cgroup plan；consumer/recovery
不会把 GO 后的临时观察或 systemd unit 消失推断为 cleanup success。Provider 仍不执行 systemctl 或其他
spawn；待 lifecycle 能 durable 绑定 scope 后才可接入 Runtime verifier。

当前 Darwin Seatbelt 无法证明 `setsid`/detached descendant containment，因此 allocating preparation 继续以
backend unavailable fail closed。Windows development backend 的 deterministic runtime cleanup 只证明其 exact
allocation lifecycle，不替代 handle-relative workspace mutation、structural network 或 production qualification。
Linux bubblewrap workspace-scoped 路径是唯一可继续收集 containment 证据的候选，但当前 production support set
仍为空；未在本平台执行的 native path 不算 whole-workflow 证据。旧 Windows direct executor 和旧 Core ToolSpec 裸
`shellTool` fallback 已删除，Fake deny/crash 不调用 Local 或 host fallback。该迁移没有 feature flag，也未改变
Runtime schema v26 或 `kite-runtime-modularization-v1-2026-08-19` format epoch。

Darwin 的 supervisor negative conformance 由
`apps/kite-service/test/isolated/execution/posix-supervisor.test.ts` 实际创建 `setsid()` session descendant；PGID 终止后
`cleanupConfirmed` 必须保持 `false`。恢复同样传递 `descendantContainmentProven=false`，所以只终止已绑定
supervisor group 不会伪造完整后代清理 receipt。`launchd.plist(5)` 的 `AbandonProcessGroup=false`
只覆盖同一 process group，`sandbox(7)` 的继承语义不提供生命周期 authority；在 macOS 没有可验证的
kernel/launchd/descriptor-owned descendant authority 前，Seatbelt allocating 继续 unavailable。

### Brokered Git access（ADR-0097）

`ExecutionCapabilitySurface` 只投影只读 `gitInspect`，并绑定精确
`brokered-git-r1` feature revision。Builtin catalog disclosure 与 Controller dispatch 继续原子绑定；
generic process/read-only fallback 不能隐式产生 typed Git capability。ADR-0131 已取消 native `.git`
deny/mask，因此 ADR-0097 原资格模型无法为当前 profile 产生新 qualified evidence；production
`gitInspect` 保持 excluded，直到追加 ADR 定义不依赖 Workspace path deny 的资格模型。

`git_inspect` 只接受 `status | diff | log | branch_list` 的逐 operation 严格有界 schema；unknown/无关字段拒绝。path 必须是 literal，相对路径中的 pathspec magic、glob、casefold 与反斜杠形式一律在进程前拒绝。Builtin broker 在任何 Git
process 前验证 canonical repository/common-dir、Workspace 外受信 binary identity、受限 config、
attributes、replace refs、grafts 与 shared protected-path evaluator；无法证明安全时零 dispatch。
`core.excludesFile`、include/url/protocol/remote/credential 及其他可跨越仓库边界的 config 一律视为 hostile，且 broker 环境不得继承用户 Git 配置。`diff` 在 dispatch 前还要以有界历史/对象 provenance 证明请求路径从未由 protected 名称或 protected blob 派生；无法证明时只返回低信息量拒绝。每次 adapter request 都携带独立 stdout/stderr byte ceiling，App 以流式 UTF-8 安全读取并在溢出时终止 process tree。Unix adapter 在 timeout、取消或输出超限后还要在有界窗口内等待 detached process group 消失；只有系统返回 `ESRCH` 才记录 `cleanupConfirmed=true`，超时、权限错误或其他无法证明的结果继续 fail closed。
`.gitattributes`、`.git/info/attributes`、grafts、`refs/replace` 与 `packed-refs` 在读取前逐级验证 metadata boundary、拒绝任意 symlink；packed refs 中出现 replace ref 同样视为 hostile。
命令 argv 和环境由 broker 构造，禁用 system/global config、credential/askpass、hooks、filters、
pager、external diff 和可执行 attributes。`log` 只返回 hash/time 等 metadata，不读取 subject、blob
或 protected 内容。每次 terminal 产生绑定 repo、binary、schema、operation 与可信
timing 的 typed evidence/receipt；App process adapter 只执行 broker 已准入的 invocation。

按 ADR-0136，direct `git status`、无 patch `git log` 和其他 raw Git invocation 都先按当前 mode 审查；闭集
classifier 不再产生免审授权。批准后，匹配 ADR-0134 grammar 的 status/log 仍可使用 hardened Shell
environment，由 preparation 固定关闭外部 config、prompt、pager、external diff、optional locks 与 repository
fsmonitor。其他 Git 使用普通获批 Shell environment；remote、external target 和无法证明的 effects 继续作为
reviewer 与 sandbox scope 的结构化事实。
`brokered-git-r1` 不按 raw Git token hard deny 或强制返回 `nextCapability=git_inspect`。Planning、关键系统
destructive 与 capability admission 仍独立治理；typed `git_inspect` 不从 generic Shell authority 推导
production qualification。

现有三平台 probe 仍记录旧 native metadata read/write deny 字段，但当前 profile 按设计不会令其
`enforced`，因此 brokered Git production qualification 明确为 excluded；开发 fixture 通过不产生
production support。未来 probe 必须随新的追加 ADR 更换资格事实，不能把 Workspace path deny 重新加回。
未来 `qualified` evidence 必须直接绑定真实 profile revision/digest、protected-rules digest、broker/schema
revision、repository/executable identity 与 invocation receipt UUID，并符合后续 ADR 定义的新资格事实；
由标签字符串临时哈希出的值不能作为资格证据。当前 probe 不拥有这组 release evidence，因此即使本地
positive/hostile 控制通过也保持 excluded。

`createSandboxExecutor()` 已从 production 入口删除；同名函数只存在于
`tests/helpers/sandbox-executor.ts` 作为原生行为 oracle。Builtin catalog entry 也不接受裸 `shellTool`
fallback。TUI 与 foreground CLI 只组合 `composeAppSandboxExecutor()`；按 ADR-0119，其决策为
`sandbox | host_shell | denied`。`host_shell` 只接受已经过 Policy/approval、durable Tool attempt ack 的调用，
并且只能在用户命令启动前的 startup unavailable，或 typed `backend_unavailable + pre_dispatch +
cleanupConfirmed` 后选择；缺 Runtime identity/lifecycle 的 App executor 直调继续拒绝。

### Unified sandbox startup and denial

TUI 与 foreground CLI 共用 allocation-free startup discovery。discovery 只返回静态 backend
candidate，不运行 bubblewrap/cgroup/native runner probe，也不分配 runtime directory。真实
usability probe 只能在 Tool attempt 与 sandbox preparation intent durable ack 后由 Runtime consumer
执行；Provider 仍如实 fail closed。若结果是 typed pre-dispatch backend unavailable，且 abandonment/disposal
receipt 已确认，App availability composition（包括唯一 prepared Shell port）才会为同一条已获准命令初始化
并执行唯一一次 host Shell attempt。

当前 Darwin Seatbelt 因无法证明 detached/session descendant containment 而对 allocating
prepare 返回 unavailable；Windows restricted-token 保留 protocol V6 preparation/runtime codec，但在
handle-relative/no-follow runtime cleanup 未完成前同样 unavailable。Linux bubblewrap 是唯一继续
收集 native PID namespace/cgroup/descendant-exit 证据的 candidate，仍未进入 production support set。
请求 `filesystemScope=full_access` 会暴露 host-only control root，因此也 fail closed。

用户命令在获准后至多执行一次。native command 可能已经启动、non-zero exit、timeout、cancellation、
cleanup unknown/failure 或 runner failure 时都不得以非沙箱方式重试。sealed surface 没有 Shell、请求
`filesystemScope=full_access`、network allowlist 无法兑现或独立 Policy 判为高危时，App 保持 `denied`。Host fallback 是
unisolated availability，不是 native qualification；qualification/probe 不能在后台把已拒绝 executor
提升为可运行权威。

`packages/builtin-runtime/src/sandbox/process-tree-capability.ts` 是 native process-tree evidence 的唯一分离投影；
已删除的 Core 路径不得恢复为兼容导出：
`hardCountLimit` 需要具名 limiter mechanism 与 native conformance；`terminationCleanup` 只表达
终止后残留确认。process group、PID namespace、Windows Job termination 或清理成功都不能单独
产生 `processTreeLimit=enforced`，所以 Seatbelt、bubblewrap 与 Windows `none` 均保持
hard-count `unsupported`，production surface 在 admission 阶段全关闭。Windows
`windows_restricted_token` 只在 `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` 真实生效（第 N+1 个进程创建
失败）且 Job 清空确认后投影 `windows_job_active_process_limit=enforced`；这不改变空支持集。
raw artifact 同时保留 `hardCountMechanism`；旧 V1 artifact 缺失时按 `none` 解释，
不能从 verdict 反推机制。通用布尔 projector 不从 sandbox barrel 导出，release producer 只能
读取当前保守投影。

## App-owned writer placement and status

`apps/kite-service/src/workspace/worktree-controller.ts` 是唯一拥有 Git/worktree authority 的 typed Service
controller。共享 checkout 默认只读；只有用户在场且显式选择的 foreground TUI writer 可使用当前
checkout。D-09 继续排除 foreground Headless CLI writer；后台、定时、无人值守、并发和委派 writer
只有在 controller 开启时才可进入 identity-bound worktree，创建失败不得回退共享 checkout。
controller 要求 clean、精确 40-hex baseline，使用持久单 writer lease、opaque Runtime binding 与
ownership nonce；branch collision、Git/磁盘失败、crash recovery identity 不匹配全部 fail closed。
cleanup 只移除 identity 验证通过且 clean 的 controller-owned worktree；dirty、conflict、operation
lock 或 identity drift 都保留现场供人工恢复。它不 push、merge 或删除 branch，并关闭 checkout
hooks。

`apps/kite-service/src/release/execution-status.ts` 只投影已经通过 Service config 与 Builtin/Host production admission 的有效状态：实际
sandbox backend/availability/fallback、filesystem scope、network mode 与 host 数量、protected-path
policy、controller worktree 状态以及 capability 的 typed disabled reasons。它不暴露 Workspace
路径、host 名、process limit、qualification proof 或完整安全 profile，也不产生 capability。
TUI 的 `/permissions` 只用于选择 interaction mode，不显示或授予 production boundary；CLI
`--execution-status` 在创建 Runtime、MCP 或 Skill 前输出状态并退出。CLI 直接启用
`executionBoundary`/`networkBoundary` 会在参数解析阶段拒绝，显式 `false` 仍可单调收紧。

运行中的 `/permissions full` 仍不构成 production boundary admission。它必须在 Kernel 的 live-control
事件入口重新验证 Full-qualified sandbox；失败时不改变 Runtime authorization 或 interaction mode。
> 路径同步：执行边界引用当前无版本命名的 runtime state/store 文件；格式版本继续作为数据 metadata。
> Capability boundary synchronization: sandbox recovery now imports capability digest helpers through the Builtin capability subpath rather than the root barrel.
