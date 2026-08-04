# Production execution platform support

状态：active

读取时机：修改 sandbox backend、production execution admission、process-tree 限制、
network boundary、TUI/CLI composition root、Skill/local stdio MCP child 或平台发布矩阵时。

验证：`bun test tests/sandbox/platform-backends.test.ts tests/sandbox/cgroup-pids.test.ts tests/sandbox/app-sandbox-composition.test.ts tests/sandbox/process-tree-limit.test.ts
tests/sandbox/platform-capability-probe.test.ts tests/sandbox/execution-boundary.test.ts
tests/sandbox/network-boundary.test.ts tests/sandbox/network-boundary-concurrency.test.ts`、
`bun test tests/postinstall.test.ts`、
`bun run scripts/release/platform-capability-probe.ts`，以及
`bun run scripts/release/verify-platform-capability-evidence.ts`、
`.github/workflows/platform-capability-probe.yml` 的声明平台原生 artifact。

相关：ADR-0054、ADR-0061、ADR-0065、ADR-0068、`release/platform-capabilities/support-matrix-v1.json`、
`docs/space/plans/2026-07-29-agent-production-execution-isolation.md`。

## 当前支持集合

当前 effectful execution 的 production-supported platform/backend 集合为空，D-04 已按“空支持集”
关闭。ADR-0068 明确该空集合只阻止对应 Shell、writer、MCP write、effectful Skill 等能力，不再阻止
生成和安装普通开源 TUI/CLI 候选包。候选包与 effectful capability 支持声明是两个独立结论：

Windows、Linux 与 macOS 同时是本地 Bun TUI/CLI 的发行目标。发行/启动/PTY/路径/ACL/keyring
兼容性与 effectful execution capability 是两个 Gate：某个平台可以通过普通 TUI/CLI 发行验证，
但其 Shell、writer、Skill child 或 local stdio MCP 仍可因原生隔离证据不足而关闭。常规三平台
验证使用 GitHub-hosted `macos-15`、`ubuntu-24.04`、`windows-2025`，不要求 self-hosted Ubuntu；
Docker、WSL2 和架构模拟只作开发预检。

源码安装仍以 Bun 为包管理器；候选版本另使用 Bun standalone executable、manifest/checksum 和安全
安装器，不要求目标机预装 Node。开发依赖安装的 `postinstall` 仍由 package script 显式通过系统 `node` 启动。
该 bootstrap 必须只使用 Node 18 可初始化的 ESM 路径/加载 API；导入模块不得安装 Hook，只有直接
执行脚本才可尝试通过已保证存在的 `bun x` 安装 lefthook，不得额外假设系统提供 npm/npx。
lefthook 安装失败继续是非关键开发工具故障，不能阻断依赖安装。
Ubuntu 24.04 默认 Node 18 的 Docker x64 预检负责捕获误用 `import.meta.dirname` 等较新全局属性；
该预检不替代 GitHub-hosted 原生平台 artifact。

| runner 候选 | backend 候选 | 当前结论 | 主要缺口 |
| --- | --- | --- | --- |
| macOS 15 | Seatbelt | `excluded` | fresh candidate artifact 证明 filesystem 与 network-off，但没有硬 process-tree 上限、cleanup、Skill/MCP 继承与入口组合证据 |
| Ubuntu 24.04 | none（bubblewrap namespace probe 不可用） | `excluded` | runner 不能启动所需 namespace；没有 filesystem、process-tree、继承与入口组合证据 |
| Windows Server 2025 | none | `excluded` | 没有 filesystem/network sandbox backend |

固定证据来自
[Platform Capability Probe run 30579701659](https://github.com/ferqx/kite-code/actions/runs/30579701659)，
绑定提交 `a4bdf22aa7c2a987734524c278c4750e7b9faa96`。macOS arm64、Ubuntu x64 与 Windows
x64 artifact 均为 `excluded`、`productionSupported=false`；三个 artifact 的 archive digest
固定在 support matrix。它们不包含 TUI/CLI composition evidence，也不能产生 production
资格。

2026-08-01 的候选加固证据来自
[Platform Capability Probe run 30693651821](https://github.com/ferqx/kite-code/actions/runs/30693651821)，
绑定实现提交 `c9e0dccdaad4cc6a6db57b54d80e0074e3bf8aa4`。该 run 不替换上述 D-04
固定证据或批准 registry，只验证最新候选实现仍安全排除：macOS evidence digest 为
`sha256:439b29a506a43d8ff684a289a0ee083fffff2ac08849798a2082299f78029590`，Ubuntu 为
`sha256:88e9de9a7480dc27bd651a477d5befd2ca3b3bdb1413b30b8d07cfdf24dcf176`，Windows 为
`sha256:7dfd1390fae758ac64d74476231e53dd4f5233bef6a5e8832fc324dcb6a82f7d`；三者均为
`excluded`、`productionSupported=false`，且 `hardCountMechanism=none`。因此 Task 1B.2/1B.3
以负向结果完成，但 production support set 继续为空。

## 准入语义

矩阵当前显式选择 `selectedNetworkMode=off`。`supported` 要求 filesystem allow/deny、
network-off、完整 process-tree 硬数量上限与 kill 后清理、TUI/foreground CLI 组合根，以及
`processCapabilitySurface` 声明为 `true` 的每一种 child inheritance 全部为 `enforced`。声明为
`false` 的 forked Skill/local stdio MCP 不会因 Shell 通过而继承资格。无旁路 allowlist 可以是
`unsupported`，但该平台此时只能支持 network-off profile；
需要 allowlist 的 profile 仍不可准入；若未来选择 allowlist，evaluator 必须改为要求
`network.allowlist=enforced`。`read_only_only` 只接受单独通过 conformance 的无进程
Workspace-bound 只读工具、network-off 和两个入口组合证据；当前不存在该 fallback。

backend discovery、sandbox 命令成功、顶层 shell invocation permit、PID namespace、
`--die-with-parent`、child 自然退出或 proxy 环境变量都不是对应能力的 enforcement evidence。
`ProcessTreeCapabilityEvidenceV1` 把 hard-count limiter 与 termination cleanup 分开投影；只有具名的
cgroup pids、Windows Job active-process limit 或已接受等价机制同时通过 native conformance，
前者才能为 `enforced`。成功清理 process group/Job descendants 不会提升 hard-count verdict。
探针无法执行或不能证明时按 `unavailable/unsupported` 处理，最终结论为 `excluded`。
Linux backend detection 还会执行与真实 executor 相同的 PID/network namespace 最小启动探针；
只有 binary 在 PATH 上但宿主禁止这些 namespace 时投影为 `backend=none`，而不是创建随后必败的
runtime 或把 binary discovery 当成可执行边界。
`outcome` 只是技术能力分类；探针固定输出 `productionSupported=false`，不能自行完成治理签署。
即使某 runner 的技术项全部为 `enforced`，也必须由新的追加 ADR、新鲜证据与独立 release
gate 才能改变已关闭 D-04 的空支持集并产生 production support 声明。`backend=none` 不可能产生进程型
`supported`，只能在另行验证的无进程 fallback 条件下产生 `read_only_only`。

当前 macOS 本机增量 probe 已能证明 Workspace read/write、Workspace read-only、Workspace 外
read/write、protected Git/Agent config/credential/shell profile、symlink escape、network-off 和
shell descendant filesystem inheritance；executor 还使用逐 invocation、`0700`、结束清理且不
共享的 runtime temp，返回前请求终止已跟踪 process group；未确认退出时 fail closed 并保留 runtime，
确认后才以不跟随 symlink 的物理清理恢复 hostile mode/BSD immutable flag，删除不能确认时也
fail closed。profile 还拒绝读取未列为 runtime
dependency 的 `/private/etc/hosts`。这些只是
未固定的开发 evidence。当前候选 profile 还从共享 protected-path 定义生成大小写不敏感的
anchored regex，并由 native smoke 对 `.GIT/config` read 与 `.ENV.TEST` write 做负向验证；绑定
`e6e0ffb51115c3380a1dcc340dd1627b3bdd0970` 的 Platform Capability Probe run `30705493919`
已通过该候选场景。这仍是 raw candidate evidence，不是 release-pinned production qualification。
Seatbelt 没有实现并
证明每次 Shell invocation 的硬 process-tree 数量上限，forked Skill/local stdio MCP 与两个
production composition entrypoint 也尚未形成 native evidence，因此 outcome 仍必须是
`excluded`、`productionSupported=false`。

Task 1B.4 的进程内网络控制器已能对 `web_fetch` 逐 invocation/hop 执行精确 host allowlist、
DNS 实际地址检查、manual redirect 复查、endpoint revision 与 pinned socket，并在 dispatch 前
持久化 allow/deny receipt。该控制器不依赖 proxy environment，但也不能约束任意 descendant。
因此所有候选平台在 sealed boundary 下仍把 Shell/Skill 网络收紧为 off。Remote HTTP MCP 已有
逐 invocation transport/endpoint admission 实现，但当前 production TUI 未提供 receipt controller，
local stdio 也因缺少 native child conformance 明确排除；没有平台因此进入支持集。

Linux bubblewrap 的开发边界现已把 canonical Workspace 按 `workspace_write` 或 `read_only`
分别投影为 rw/ro bind，并把逐 invocation runtime 显式 rw bind；runtime 清理在只暴露该 runtime
和只读系统工具的独立 mount namespace 内执行，避免 nested symlink 把宿主清理重定向到
Workspace 或其他宿主路径。Ubuntu workflow 区分“namespace probe 可用并运行真实 executor”与
“runner 禁止 user namespace 因而明确排除”；后者保持 `backend=none`，不能用绿色 workflow
伪装 bubblewrap native qualification。probe 还单独投影 bubblewrap `syscallFilter` 强度；vendored
binary 存在但没有 negative syscall conformance 时仍为 `unavailable`，并产生稳定 limitation。
protected path、syscall filter、硬 process-tree 上限和完整 child/入口继承未证明时，Linux 结论
继续是 `excluded`。

当前本地增量实现把 TUI 与 foreground CLI 收敛到同一个 App sandbox composition root，并为
Linux 候选加入 `systemd-run --user --scope` + cgroup v2 `TasksMax` 的 argv-only 包装、真实启动探针
及独立 hard-count/cleanup 投影。候选 capability surface 只声明 Shell；forked Skill 和 local stdio
MCP 明确为 false。GitHub-hosted Ubuntu 是否同时允许 bubblewrap、seccomp、user systemd scope 和
cgroup pids 必须由更新后的三平台 workflow 真实运行后决定；本地测试或代码存在不能提前改变
`excluded`/空支持集结论。allowlist 目前没有 descendant-safe backend，App composition 对其直接
fail closed，绝不映射为 `allow_all`。

## ExecutionBoundaryV1 schema 与 composition gate

Task 1B.1 已在 Core 冻结 `ExecutionBoundaryV1`：filesystem 只允许
`read_only | workspace_write | full_access`，network 只允许 `off | allowlist`，local/private
network 固定为 `false`，process-tree 上限必须是有限正整数。Workspace root 在解析时使用真实
路径 canonicalize，并与 Workspace Trust 共用 `canonicalWorkspaceKey()`；allowlist 只接受精确
DNS host、统一小写/排序/去重，不接受 URL、IP literal 或空的 allowlist 模式。

边界组合只能收紧：filesystem scope 取更小权限、allowlist 取交集（空交集变成 network off）、
protected policy 取 deny、process-tree limit 取更小值、sandbox required 取逻辑或、unavailable
fallback 取 fail。不同 canonical Workspace 的边界禁止组合。

production composition gate 不接受单一 `sandboxAvailable`，也不接受调用方传入 raw
`supported | read_only_only`。它只读取
`release/platform-capabilities/approved-execution-qualifications-v1.json`，校验固定 revision/digest，
再按实际 OS release/version、architecture、Bun、backend、network mode 和 TUI/foreground CLI
入口精确解析 qualification。probe 与 resolver 共用 canonical environment identity producer，且
Windows identity 直接读取 Runtime 的 OS version API，不启动 PowerShell/CIM 子进程，避免冷启动或
runner 负载把 production admission 变成无界同步等待；native evidence 与 resolver 仍消费同一值。
每个可批准 qualification 必须同时包含两个入口的 composition evidence。qualification 内逐维固定 filesystem、network、完整 process tree、
child inheritance 和 verified in-process read-only strength。flag/artifact 缺失、Workspace 不匹配、
`full_access`、环境无匹配 qualification 或任一必需维度 `unsupported` 时 capability surface 全部
关闭；同一环境 admission key 重复也按歧义拒绝，不能由 registry 文件顺序选择首项。

`read_only_only` 还要求 digest 校验通过的非空 tool catalog；每个 tool contract 明确禁止 network、
process、write 和 workspace 外路径，只允许 Workspace read。准入 surface 保留 catalog
revision/digest、descriptor revision 与 effect contract，供后续 tool disclosure/execution 对照，
不能只按相同 tool ID 放行。当前 builtin disclosure 与 runner 已执行该匹配，并拒绝外部路径及
动态 MCP；该 surface 的 shell、writer、Skill child 和 local stdio MCP 始终关闭。

对未来非空的原生 `supported` qualification，surface 各能力轴同样独立执行：例如
`filesystemScope=read_only` 可以保留受 native sandbox 约束的 process/Shell，但模型披露和
Runner 都必须按 descriptor effects 拒绝进程内 writer；`network=off` 拒绝进程内网络工具，
任意 production surface 都拒绝进程内文件工具的 Workspace 外路径。审批不能提升这些 ceiling。

`loadProductionAgentConfig()` 是 2A composition root 必须使用的 Core 配置准入入口，并在返回
任何可供 Runtime/进程使用的配置前完成 sealed gate；它不改变当前开发 TUI/CLI。当前静态
support matrix 与批准 qualification registry 都是空支持集，1B.1 schema 或技术评估 fixture
不能自行提升为 release approval。未来改变 registry 必须绑定新的固定 evidence/manifest，不能
从用户、项目、CLI 或普通 App 调用参数构造。

production loader 按 boundary 的 canonical Workspace 读取 project config，并将 user、project、
CLI/App 的 rollout 与 sandbox restriction 按 deny-wins 组合。`sandbox.enabled=false` 或
`--no-sandbox` 等价 restriction 必须在 composition 阶段拒绝，不能获得 shell/process surface；
成功的 production config 固定 `sandbox.enabled=true`，后续入口必须直接消费该 sealed config。

## Evidence 生命周期

探针 JSON 记录实际 OS release/version、architecture、Bun、backend、逐项 verdict、限制和
canonical digest。静态 support matrix 当前为 `accepted_empty_support_set`。任一 backend、
profile、composition root、runner image 或边界实现变化都需要新 evidence；只有新的追加 ADR
与独立 release gate 才能加入非空生产支持项。

GitHub-hosted evidence 还绑定 repository/head/ref/workflow ref/workflow SHA/run ID/attempt 与封闭
runner class：`macos-15-arm64-github-hosted`、`ubuntu-24.04-x64-github-hosted`、
`windows-2025-x64-github-hosted`。缺任一来源字段或未知 runner class 时 probe 直接失败；WSL2、
Docker 或 self-hosted 结果不能伪装成上述 class。

workflow 还绑定 numeric repository ID，并在上传 artifact 前调用独立 verifier；expected source 来自
GitHub workflow 环境，不从待验证 JSON 自报。verifier 对 top-level、source 和每个嵌套对象执行 exact-key
检查；producer 以 exclusive-create 写入无尾随空白的 canonical JSON bytes，verifier 再重建 digest、outcome
与 limitations，并固定拒绝 `productionSupported=true`。当前 foreground CLI/TUI
入口探针固定 `unavailable`，直到入口拥有的真实集成测试能注入断连/取消并证明同一 composition root；
普通函数调用不能伪造该 evidence。cgroup TasksMax 只能投影 hard-count，cleanup 在 unit-owned cgroup
empty/populated verifier 完成前固定不通过，process group 自然退出或 `setsid` 逃逸不能当作零 residual 证明。

同一 workflow 的跨平台 exclusion contract 使用 workspace-relative、由 Bun 执行的 marker fixture；不得把
未引用的宿主绝对路径直接拼入 shell 命令。这样 Windows Git Bash/cmd 与 POSIX shell 都实际验证 marker
创建或未创建，路径语法差异不能造成正向假失败或把 release-boundary bypass 隐藏成负向通过。

`scripts/release/execution-boundary-smoke.ts` 与
`.github/workflows/execution-boundary-conformance.yml` 把当前空支持集带入 actual synthetic artifact
smoke：三个 target 只能输出 `excluded`，八类 adversarial contract 只能输出
`excluded_not_admitted`，report 固定 `productionSupported=false`、supported count=0、
`distributable=false`。默认分支
[run 30739946155](https://github.com/ferqx/kite-code/actions/runs/30739946155) 已在 head
`dc64d25d67c9e40330676668b5f039872d04269a` 生成 macOS 15、Ubuntu 24.04 与 Windows 2025
三个 artifact；独立 verifier 重建 canonical/report digest、检查 3 target/8 case，并对三个实际
synthetic bundle 完成 bootstrap verification。Task 1B.9 因此以负向 conformance 完成并唯一产生
`MS:1B-DONE`。该 milestone 只证明 exclusion 和 fail-closed contract，不改变 D-04 空支持集，也不
产生 production qualification 或可分发制品。完整身份见
[Phase 1B 完成记录](../space/execution/completed/2026-08-02-agent-production-phase-1b.md)。

三平台 conformance 的测试夹具必须只依赖 runner 上可移植、可规范化的身份：临时路径按
canonical native path 比较，不假定 POSIX `/tmp` 或未规范化的短路径；需要生成提交或 merge
状态的 fixture 显式提供本地 Git author/committer identity；恢复 baseline 内容时直接恢复已知
blob bytes，不继承宿主 `autocrlf` 或 filter。上述约束只消除 runner 假设，不改变任何 admission、
excluded verdict 或生产支持声明。

上述 workflow 的第三方 Actions 全部固定到 immutable commit SHA，并由 release workflow contract
test 阻止 tag 回退。App worktree controller 的 Git 子进程使用最小环境，不继承宿主 credential/
askpass/SSH/proxy 等任意变量，隔离 system/global config，并禁用 hooks、fsmonitor、external diff/
textconv。controller 以 `worktree add --no-checkout` 建立 worktree，再从 Git tree 读取有界 regular blob
并直接写入，结构上不调用 smudge/process filter；tracked `.gitattributes`、common-dir
`info/attributes`、repo-local `filter.*` 或 config include 声明都会在 materialization 前后拒绝。
首次拒绝检查发生在任何 `status`/`diff` 等 worktree-aware Git 命令之前，避免 stat-dirty tracked
file 让 Git clean/process filter 在 admission 失败前执行。
Git replacement objects 在最小环境中固定禁用；common-dir replacement refs、packed replacement refs
或 legacy grafts 存在时 baseline admission 直接拒绝。单文件、总字节与文件数量都有显式上限。
`provisioning` 记录只保留给 operator 诊断，不能经 `recover()` 自动提升为 `active`；必须显式丢弃并
重新创建，只有已经 active 的 worktree 才能轮换 recovery lease。

Review handoff 对 tracked 内容使用 binary diff，对 untracked owned regular file 生成有界、SHA-256
绑定、base64 binary-safe 的 `KITE_UNTRACKED_FILE_V1` 内容记录。symlink、特殊文件、硬链接、超限、
owner/path/前后快照变化全部 fail closed；changed-files 只有文件名而没有内容的 handoff 不再成立。
