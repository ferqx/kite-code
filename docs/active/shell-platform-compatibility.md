# 当前规则：Shell 工具平台兼容性

状态：active
最后更新：2026-08-20
最后验证：2026-08-20
范围：

- `packages/builtin-runtime/src/planning/runtime-module.ts`（Builtin Shell operation 与参数语义）
- `packages/builtin-runtime/src/planning/runtime-module.ts`（`builtin:shell_execute` 唯一领域 executor）
- `packages/builtin-runtime/src/sandbox/`（Sandbox/环境领域投影）
- `packages/runtime-host/src/process/**`（唯一 process spawn/supervision）
- `apps/kite/src/sandbox/`（native/host-shell availability composition）
- `packages/runtime-host/src/process/spawn.ts`、`process-tree.ts`（Host process/lifecycle primitive）
- `tests/shell-exec.test.ts`（Shell 集成测试）
- `tests/tools.test.ts`（Shell 工具单元测试）
- `tests/sandbox/windows-restricted-token.test.ts`（Windows 受管 PATH 投影）

读取时机：

- 修改 Shell 工具的 `buildShellInvocation`、`findSystemBash`、`findBashBinary` 或 bash 选择策略。
- 修改 vendored MSYS2 的内容或布局。
- Shell 命令在 Windows 上报 exit code 127 或其他异常错误。
- 新增 shell 相关的平台适配代码。

相关：

- `tool-gated-autonomy.md`
- `project-conventions.md`
- `file-reading-shared-boundary.md` — MSYS2 路径转换 + readTextContent 边界

验证：

- `bun test packages/builtin-runtime/test packages/runtime-host/test tests/runtime tests/sandbox`
- `bun run test:sandbox:smoke:native`（显式宿主机 native sandbox smoke）
- `bun run typecheck`

---

## 1. Shell 解析与受治理执行

`shell_execute` 的 schema、revision、receipt projection 与 executor 由 Builtin Runtime module 唯一拥有；
App Tool Pipeline 只保留 descriptor/policy composition，不再拥有第二 command executor。Native Shell 解析发生在已获 durable sandbox dispatch
authority 的 Runtime lifecycle consumer 内，实际异步进程创建、POSIX supervisor、output drain 与 process-tree
termination 只由 Runtime Host primitive 执行。Builtin 通过 invocation-scoped mechanism 接收结果，不得直接
访问 Host、异常回退到旧 executor 或形成第二个 handler。

这里的 Builtin authority 来自冻结 SPI registry snapshot 的 catalog entry。Kernel 只裁决 governance/admission facts，Host 只提供通用
process/lifecycle mechanism；源码 caller/owner closure 已切到唯一 Builtin/Host/App seams，但 RM-16 final manifest/docs/journey/fault/soak
Gate 尚未完成，不能把 scoped closure 误称为 RM-16 completed。

TUI 与 foreground
CLI 的 startup discovery 只返回静态 candidate；Windows restricted-token 由 Local allocating Provider 在 durable
intent 后生成 transport，并在用户命令前保留 fail-closed 的 runner/OS/cleanup 失败处理。按 ADR-0119，App 可以在 startup
unavailable，或 exact `backend_unavailable + pre_dispatch + cleanupConfirmed` 后选择 host interpreter；该调用
仍须具有 Runtime identity/lifecycle，且已通过 Policy/approval 与 attempt ack。

ADR-0100 的 approved-filesystem lane 是另一条显式 capability 路径，不是 backend fallback：
`externalRead`、`externalWrite` 或 `uncertainEffects` 审批通过后，在用户命令启动前把
`filesystemMode=allow_all` 投影到已选 native backend。三个平台都遵循该规则，命令不得先失败再 replay，
也不得自行切换 host Shell；只有 ADR-0119 的独立 App availability 条件可选择 host。`curl -o`、`wget -O/-P` 与方向无法证明的文件传输客户端必须同时投影文件系统
effects；固定高危身份继续由 Seatbelt deny、bubblewrap protected mount 或 Windows guard SID 保护。Auto
模式由自动审批模型判断；风险判定或模型异常才升级真人审批。

Windows 命令语言候选顺序（只在已获准的 native/test execution 内使用）：

1. 系统 Git for Windows Bash（通过 where git 推导 ../bin/bash.exe）；
2. Vendored MSYS2 Bash（vendor/msys2/usr/bin/bash.exe）；
3. cmd.exe；
4. pwsh / Windows PowerShell。

macOS/Linux 使用同一候选解析器：优先 Bash 与配置的 POSIX Shell，再接受宿主已安装的
cmd/PowerShell，最后使用 /bin/sh。只有解释器进程无法启动时才尝试下一个候选；解释器已启动后，
用户命令的非零退出、timeout 或 cancel 不得重放。 Windows 取消使用 Job Object 终止整棵进程树。Job 绑定前已经启动的 descendants 需要单独记录并仅在 Job 强制终止后补扫；Job 绑定后创建的进程已经由 `TerminateJobObject` 处理，不得再次逐个等待确认，否则会把已完成的取消拖入无意义的 per-process 等待。取消结果仍需报告 `processCleanup`，但正常路径应在进程树退出后立即返回，不把清理等待暴露为下一条 prompt 的额外停顿。

默认命令语言仍为 Bash/POSIX。需要 cmd 或 PowerShell 语义时必须在命令中显式调用解释器；从
Windows Git Bash 调用 cmd 使用 cmd.exe //d //c ...，PowerShell 使用
pwsh -NoProfile -Command ... 或 powershell.exe -NoProfile -Command ...。

## 2. WSL 桩排除（关键安全规则）

**Windows 10+ 在 `%SystemRoot%\System32\bash.exe` 放了一个 WSL 入口桩。**
该桩需要 Hyper-V，未启用时报 `HCS_E_HYPERV_NOT_INSTALLED`。

**强制规则**：

- 选择系统 bash 时，**优先通过 `git` 路径推导**（`<git>/../bin/bash.exe` 或 `<git>/../usr/bin/bash.exe`），不依赖 `Bun.which("bash")`
- 仅在 git 不可用时，才使用 `Bun.which("bash")`，且**必须排除 `SystemRoot` 下的路径**
- 判断逻辑：路径转小写 + 正斜杠后调用 `isWslStubPath()` 检查

## 3. vendored MSYS2 的 DLL 依赖

Vendored bash 依赖 `msys-2.0.dll` 及核心工具所需的其他 DLL（`msys-intl-8.dll`、`msys-pcre-1.dll` 等共 15 个）。如果新增或升级 coreutils，**必须用 `ldd` 检查所有新增 .exe 的 DLL 依赖，确保 DLL 已复制到 `vendor/msys2/usr/bin/`**。可从 Git for Windows 的 `/usr/bin/` 获取缺失的 DLL。

## 4. 测试必须 mock 环境依赖

`findSystemBash` 的核心逻辑（`gatherSystemBashCandidates`、`isWslStubPath`）是纯函数，不依赖文件系统或 PATH。**必须 mock `which` 函数**覆盖以下场景：

- 无 git、无 bash → 返回 null
- git 安装在不同路径 → 推导候选正确
- bash 在 `SystemRoot` 下 → 标记为 WSL 桩
- bash 在其他路径 → 不误判
- 大小写、正反斜杠变体 → 正确识别

**禁止仅依赖真实环境测试**——开发者的终端通常有 Git Bash，会掩盖 WSL 桩问题。

## 5. 集成测试与 production composition 分层

`tests/shell-exec.test.ts` 使用 `tests/helpers/sandbox-executor.ts` 的显式 native/test oracle，而不是
production/TUI composition。该 helper 可在测试中注入裸 `shellTool` 以固定 Shell 选择、流式输出、
超时与取消 oracle，但 Runtime/App static gate 禁止 production 导入该 helper 或重建同名入口。
真实 filesystem/network sandbox enforcement 由 `test:sandbox:smoke:native` 和
`.github/workflows/platform-capability-probe.yml` 独立验证，不能从默认 Shell suite 推导。

## 6. Windows 直接 restricted-token runtime

windows_restricted_token 的 protocol/native compatibility implementation 创建无 UAC 的
WRITE_RESTRICTED current-user token，携带 Workspace 与 invocation-runtime capability SID；它验证 suspended
child，关联 Job，然后在 canonical 真实 Workspace 中 resume。它不创建 whole-repository staging copy，
正常 native path 不要求 administrator approval。Local Provider 在 durable preparation intent 后创建 invocation
runtime、封装为 immutable `windows_restricted_token_v1` transport，并由 Runtime consumer 在 ready/dispatch
ack 后交给唯一 Host spawn primitive 启动 runner；
runner 的 Job empty receipt、ACL revoke 与 runtime cleanup 均须在 disposal 前确认。该 backend 是 development
restricted-token sandbox，能力 registry 仍不把它升级为 strict network/protected-glob 或 production Full 资格。

persistent capability ledger 使用 V2 readiness marker。首次创建、V1 迁移、上次初始化中断或 static
protected-path set 变化时，runner 在 per-Workspace mutex 内幂等完成 ACL setup；最多等待 30 秒。完成后，
相同 path set 的并发 invocation 只读 ledger 并走无锁快路径，因此并发 `git status`/短命令不会被 ACL
初始化串行化，也不会因旧的 2 秒等待窗口误报 ledger busy。ledger 写入使用原子替换，ready marker 只能在
ACL 操作全部成功后提交。

POSIX runtime 继续由 manifest 固定。verified Bun executable 可在可用时通过受控 child PATH 提供；
这只是 runtime resolution，不是 repository copy，也不自动授予 Full/network authority。裸
npm/npx/pnpm/pnpx/yarn/yarnpkg/corepack 在 restricted child 中固定转发到 Windows `.cmd` shim，避免
POSIX lookup 命中 Windows 无法执行的 extensionless Unix shim；adapter 显式经 `cmd.exe /d /c` 承载
batch shim，不能让 isksh 直接启动 `.cmd` 并把 `C:\Program Files` 等 PATH identity 拆词。command 可以显式调用 bash、cmd.exe、
pwsh 或 powershell.exe。

Shell read-only fast path 不使用上述通用继承 PATH。Runtime 仅在 Builtin frozen catalog entry 与 Pipeline 重新证明
命令只读后签发内部 execution trust：POSIX executor 固定以非登录 `/bin/sh -c`
执行，Windows restricted-token 继续使用密封 shell runtime/Coreutils；二者的继承
PATH 条目均必须为 Workspace 外可 canonicalize 的绝对目录。相对条目、空条目、
Workspace 子目录与 symlink alias 被删除；无沙箱 development fallback 也消费同一最小
环境，不能因 backend 不可用而恢复 Workspace executable replacement。普通需审批 Shell
仍保留用户工具链和 Homebrew/项目 PATH 语义。

isksh 本身不提供 MSYS2 drive mount。为保持共享 Shell contract，restricted-token adapter 在送入 runner
前仅转换 shell token boundary 上的字面量 `/x/...` 盘符前缀为 native executable 可接受的 `X:/...`；
引号、其余参数与 POSIX shell syntax 保持不变，URL、`/dev/null` 和相对路径不得转换。审批、receipt 与
Tool Result 的 `command` 继续保存用户/模型提交的原始命令，不保存 adapter prelude。变量展开后才产生的
`/x/...` 不属于该静态兼容层；调用方应使用字面量 POSIX drive path 或 `X:/...` mixed path。

Shell Tool Policy 与 macOS/Linux 共用逐调用网络授权：精确 `node|npm|pnpm|yarn|bun --version|-v`
按本地只读、network-disabled 执行；明确网络命令和 `node script.js`、`npm run build` 等 uncertain
script 先审批，批准后仅该 invocation 投影为 `allow_all`。direct profile 接受该开发期授权，但不会
structural enforce network-off、arbitrary
descendant allowlist 或 future root .env.* protection。因此已选 backend 的 TUI/CLI Full 仅是 ADR-0121
定义的开发期交互模式，不是 production admission；只有 backend=none 时才显示“非沙箱环境无法开启full”。

当且仅当 invocation 已投影为 `allow_all`，macOS/Linux 本地 backend 都把宿主已有的标准代理变量
`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`（以及小写形式）传给该 command；这是用户已批准
网络能力的一部分，支持企业和本地代理。Windows 还要求同一次 invocation 明确投影 `full_access`，才将
这些变量交给使用当前用户 token 的 command；`allow_all + read_only/workspace_write` 在 runner 前 fail closed，
而非扩大 filesystem scope。network-disabled、policy-proven read-only 和未批准调用继续使用无 proxy 的最小
环境。代理 URL 可能含认证信息，Shell 输出、模型投影和 session log 不得主动回显其值；代理变量只在
supervisor/runner 实际 spawn 时从宿主读取，不能写入持久化的 preparation 或 recovery artifact。

文件系统授权独立于上述网络投影。Windows 与 macOS/Linux 一样，普通外部路径和临时目录在审批通过后
使用保留 `WRITE_RESTRICTED`、LUA 与 privilege stripping 的 approved filesystem token；其 mirrored
user/group/guard restricted SID 只约束写访问，read/execute 仍服从 current user 普通 ACL。普通 Workspace
invocation 仍使用 capability SID
ledger，扩权 invocation 不把全局写权限写入 persistent Workspace ledger，也不要求 UAC。显式危险路径
在 Tool Policy 阶段拒绝；approved token 还携带 restricted-only guard SID，既有固定路径对该 SID 添加
invocation-scoped deny，并初始化与普通 token 相同的 child-object default DACL，避免变量拼接或间接执行
绕过字符串检查，同时允许已批准 shell 启动 Node/npm descendant。该 scope 不等于 Full 或 production evidence；
持久 Workspace capability ledger 只允许保存 Workspace 内 protected path，外部用户配置路径不进入
该 ledger 或 repair 范围；普通 Workspace token 对外部路径没有 capability allow，写访问仍被拒绝。
若同一命令同时需要网络和外部文件系统，Tool Policy 必须同时展示对应 effects，批准后只执行一次。

在 user script 前无法选择或 structural start 该 backend 时，App 进入 `denied`。script 开始后，
non-zero exit、timeout、cancel、runner、Job 或 ACL cleanup failure 都不得在其他
Bash/cmd/PowerShell 上 replay。

ADR-0088 已删除 AppContainer 与 repository staging。Windows native runner 只接受 protocol V6
direct Workspace request；runner 和 vendored isksh/coreutils digest 继续固定在
`release/platform-capabilities/windows-runner.json`。

## 7. 超时必须终止整棵进程树

Shell 命令未提供 `timeout_ms` 时必须使用 600000ms 的默认硬超时；显式 `timeout_ms` 可以覆盖为更短或更长的正整数，但不得存在无限执行路径。达到有效超时后，执行器必须先停止 stdout/stderr reader术语（标准输出/错误读取器），再强制终止 shell 包装进程及其全部后代，并等待终止动作完成后返回 exit code 124。用户通过 AbortSignal术语（中止信号）取消时必须复用同一套 reader 停止和进程树终止流程，但返回 exit code 130 与取消提示，不得继续等待默认超时或误报为超时。不得只结束 shell 包装进程而留下后台子进程。

- Windows 在命令启动后立即关联 Job Object术语（作业对象），并在 guard 建立及终止根 Shell 前扩展已知原生 process snapshot术语（进程快照）。终止整个 Job 后仍须清扫关联前已经启动的后代；根 Shell 在 graceful 等待期内先退出不得跳过该 sweep，因为未被 Job 追踪的后代可能已重设 parent。原生句柄不可用时降级为 `taskkill /T /F`。原生终止必须保留 process handle术语（进程句柄）并等待其进入终态后再返回。
- Unix 启动命令时创建独立 process group术语（进程组）。终止时先向整组发送 `SIGTERM` 并等待 500ms；仍存活时发送 `SIGKILL`，再进行最多 2 秒的退出确认。忽略 SIGTERM 的后代必须由强制阶段清理。
- `tests/shell-exec.test.ts` 必须记录实际后代 PID，并断言超时或取消结果返回时该 PID 已不再存活；取消测试还必须证明不会等待显式超时到期。
- Windows 回归测试还必须故意在 Job 关联前启动后代，验证关联竞态中的逃逸进程同样被清理。

Shell result 必须返回结构化 `processCleanup`：是否确认退出、是否进入 forced 阶段和未确认
descendant 数。Tool Controller 只能把这些安全事实写入 result metadata；未确认退出必须另发
`cancel_incomplete` cancellation diagnostic，禁止把原始命令、路径或进程输出复制到诊断。
Bun spawn 不直接消费 AbortSignal，整棵树的取消由 ProcessTreeGuard 唯一负责，避免只终止
root process。

stdout/stderr reader 必须持续 drain 子进程管道，但执行期每路最多保留 256 KiB head+tail；超过上限时写入明确 capture omission marker，不能继续持有完整输出副本。实时 progress 按完整逻辑行发布，单个未终止长行最多保留 16 KiB tail；CRLF 在进入事件层前规范为 LF 行语义。Windows restricted-token runner 的任意二进制 frame 必须先用跨 frame `TextDecoder` 解码并经过同一有界行缓冲，禁止把 8 KiB transport chunk 当成一行或在 frame 边界插入假换行。最终模型投影仍继续使用 `packages/builtin-runtime/src/filesystem/projection.ts` 的每路 4000 字符 head+tail 边界。
