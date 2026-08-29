# 开源候选版本控制

状态：active

读取时机：修改 release manifest、候选构建/校验/安装脚本、三平台 workflow、Release Profile、Gate、rollback 或发布状态展示时。

验证：`bun test tests/release`、`bun run release:build`、`bun run release:verify`、`bun run release:smoke`、`bun run check:docs-impact`、`bun run check:docs`。

相关：ADR-0051、ADR-0052、ADR-0059、ADR-0065、ADR-0068、ADR-0069、ADR-0093、`open-source-first-release.md`。

## 首发权威

首个开源版本以 ADR-0068/ADR-0069 的 G0/G1 为唯一必要 Gate。旧 Release Evidence、Gate replay、
Sigstore、attestation、provenance、platform signer、external rollout 和 maturity 控制面只可保留为
fail-closed 历史 contract；它们没有发布权威，不属于当前或后续路线图，也不得产生通过结论。

G0 验证本地正确性、安全边界、P0/P1、安装/回滚。G1 验证 GitHub-hosted macOS/Ubuntu/Windows
构建、安装、启动、TUI/CLI smoke、DeepSeek 与 OpenCode Go OpenAI-compatible route 的真实最小调用，以及
release notes/known limitations。缺任何真实结果时保持 blocked 或未验证。

候选支持入口包括本地TUI、用户在场的foreground CLI，以及 private loopback Web Observer；前两者经 Coordinator 定位并直接连接
canonical Workspace Worker，Web 通过独立 Gateway companion 连接 Coordinator/Worker 的 read-only surface。显式 `kite service *`
仍控制旧 Service maintenance companion，但它不是默认 terminal data plane，active layout/fence 禁止 Store 6/7 双写。internal stdio、development loopback WebSocket、
browser与Desktop reference只作内部child或conformance，不能写成remote/public支持。KLSV1-06仅有
本地candidate/composition evidence；当前macOS arm64的build/verify/install/CLI+TUI+Service+MCP wrapper/upgrade/
rollback/uninstall smoke已通过。KLSV1-07的macOS 15、Ubuntu 24.04、Windows 2025 companion build/install/process
matrix尚未取得，必须保持pending，不能以workflow定义、本地通过或artifact上传取代真实三平台结果；Windows
ACL/write-through与非 Windows 本地环境的 no-follow 断言也不能互相替代。

## 候选制品

`bun run release:build` 使用 Bun standalone executable 编译当前平台的 `kite`、`kite-tui`、`kite-service`、
`kite-coordinator`、`kite-worker` 与 `kite-web-gateway`，并构建 `payload/web` 静态资产，输出：

- gzip tar 候选包；
- exact-key JSON manifest，绑定产品版本、Git commit、Bun、target 和逐文件 SHA-256；
- archive SHA-256 sidecar；
- release notes、known limitations 与普通维护者检查清单。

候选中的`kite`与`kite-tui`由release entrypoint注入managed Coordinator/Worker connector；前台`run/resume`与TUI默认
ensure Coordinator/Workspace Worker，CLI另为显式 maintenance 注入`kite service ensure/status/stop/restart` legacy manager，并提供
`kite web*` Coordinator surface。Web
命令只通过 Coordinator client ensure/discover/stop Gateway，TUI `/web` 只 discovery；connector/manager失败直接暴露，不
导入Service App、不创建embedded Store，也不`catch`后回退旧CLI backend。
source/installed Worker connector仅对同一canonical Workspace的typed Worker recovery-pending/unavailable执行一次connect内
的有界恢复：50/150/400/1000毫秒后重试完整ensure→capability mint→instance handshake，总等待不超过1.6秒，用于收敛
dead/draining Worker descriptor刚进入可清理状态的窗口。Manager的spawn/readiness outcome-unknown仍由reservation阻止第二次
spawn；Coordinator transport、protocol与exact identity mismatch立即fail closed。每个默认logical connection使用独立client
identity，避免并发generation覆盖capability。该机制不是legacy Service/embedded fallback，也不改变单Worker、单Store writer
或Coordinator identity边界。
managed release/source composition构造neutral child environment时只复制固定OS/runtime keys和内建Provider的exact
`DEEPSEEK_*`、`OPENAI_*`、`OLLAMA_BASE_URL` keys；未知`*_API_KEY`、Workspace dotenv与ambient Kite home不进入
Service。source mode的build identity绑定同一immutable companion bundle所需的CLI/TUI/Service/Coordinator/Worker/Gateway/Web、
package/root build inputs committed tree、tracked binary diff及有界untracked regular-file内容摘要；任一 companion/build input 改变都
产生新bundle identity。摘要不可用或越界时fail closed，dirty source不能复用旧detached companion。

Windows candidate 还包含 pinned `kite-windows-runner.exe`、runner manifest 和 vendored
`isksh`/Coreutils runtime（含许可文件）。安装器写入 v2 managed-install marker 与唯一 `active` regular-file
pointer；stable launcher 将同一个 immutable candidate root 显式 pin 给 child process。Windows runner resolver
只接受 marker、pointer、`.candidate-id` 与 candidate `manifest.json` identity 完全一致的 candidate，并对
launcher、marker、pointer、candidate root、runner manifest、runner 与 Shell/Coreutils runtime 执行
no-follow/non-reparse/regular-file 检查；缺失、替换或 digest 不匹配时仍 fail closed，不会把 native runner
替换为未验证程序。Windows GNU Rust 构建必须经过
`bun run scripts/release/build-windows-runner.ts`：该入口把 checkout 与 Cargo cache 的绝对路径映射到
固定虚拟路径，固定使用 Rust toolchain 自带的 `rust-lld`，并禁止 PE linker 写入墙钟时间戳。因此
固定 toolchain 的 clean build 可在本地与 GitHub-hosted Windows runner 上生成同一 runner digest，workflow 才能在打包前用 committed
manifest pin 执行 `git diff --exit-code`。native runner 源码变更必须在同一候选提交刷新该 pin；
直接调用 Cargo 不得用于生成或验证 release pin。
当前 0.8.3/V6 runner pin 为
`sha256:bd83cc949494c9fde20b7b58a4f08a35055bfaa9b9f6a0eef5be11490bfb2ecd`；Windows candidate 与
Platform Capability Probe 都必须在打包或原生 E2E 前重建出该精确摘要。
`tests/release/supply-chain-workflow.test.ts` 固定 workflow 对该入口的调用顺序，并校验路径重映射与
linker、路径重映射与时间戳清除参数不会被后续 Actions 修改静默移除。

build 不读取 Provider secret，不自动加载 `.env`/`bunfig`，也不把环境变量内联到 executable。
manifest/checksum 是完整性数据，不是代码签名、notarization、provenance 或身份认证。
归档 writer 规范化 tar entry 时间戳并重算 header checksum；同一 target、manifest 与 payload
重复构建必须字节一致，构建墙钟不得改变 archive SHA-256。
PR candidate job 固定 checkout `pull_request.head.sha`，并通过 `KITE_EXPECTED_CANDIDATE_COMMIT` 要求
manifest `commitSha` 精确匹配；GitHub 临时 merge ref 不能充当最终候选 identity。
构建器只接受与当前 host OS/architecture 完全一致的 native target，不 cross-compile，也不下载另一平台的
Bun runtime；三平台候选分别在对应 GitHub-hosted runner 上生成。Ink 的可选 React devtools 路径在
生产候选构建时固定为空实现，不成为依赖或网络下载入口。
installer contract fixture同样默认使用当前runner的native target与executable suffix；Windows需要执行lifecycle
stub时由该runner原生编译测试executable。跨target拒绝测试必须显式构造另一target，不能让固定macOS fixture在
Linux/Windows抢先触发target gate并掩盖待测安装不变量。
Standalone resolver 必须覆盖十四个 workspace package 的全部 public export，并直接解析到仓库 source；候选构建
不得穿过 `apps/kite-cli/node_modules/@kite-ai/*` workspace symlink。该不变量避免 Windows Bun standalone 把反斜杠
symlink path 当成非法 pretty path 而崩溃，并由 release test 对每个 `package.json#exports` 机械核对。

源码通过 Bun 运行时继续使用 `@napi-rs/keyring` 的系统凭据库。由于 Bun standalone 不能在三平台上
稳定封装该 N-API binding，预构建候选把该 adapter 固定为方法级 `unavailable`：构造和普通启动不失败，
但任何 credential get/put/delete 都 fail closed。它不回退到文件、环境变量或明文存储；该限制必须在
release notes 中披露，解除前预构建候选不声称支持持久 MCP 凭据。

候选 executable 由 `scripts/release/entrypoints/` 的无 guard 薄入口显式调用 CLI `main()`、TUI `runTui()`、Coordinator、
Worker、Web Gateway 与 Service main；不能依赖 compiled runtime 对 `import.meta.main` 的平台相关判定。源码入口仍保留自身
guard，避免被测试或其他模块导入时自动启动。
source manager在POSIX直接执行带shebang的Service/Coordinator/Worker/Gateway entry；Windows source-mode必须以当前Bun
executable为command、对应 TypeScript entry为首个argument。Windows不得尝试把`.ts`当作native executable；installed candidate
仍直接执行 resolved `kite-service.exe`、`kite-coordinator.exe`、`kite-worker.exe` 或 `kite-web-gateway.exe`，不能回退PATH或
source entry。

`bun run release:verify` 在执行任何 binary 前解析 archive，拒绝未知/缺失/重复路径、绝对路径、父目录
跳转、link、schema 漂移、target 不匹配和任一 checksum 不一致。只有 verifier 通过后 smoke 才可以
启动 payload。GitHub-hosted candidate job 额外使用 `--require-clean-source`，dirty-source manifest
不得上传为候选 artifact。

旧 Linux full-chain evaluation diagnostic 及其 workflow job 已删除，不属于当前候选包或 release gate。Platform
Capability workflow 只运行本页列出的 native probe、verifier 与 release evidence；不得从已删除脚本恢复
`candidate_only` artifact 或用可选诊断替代 `bun run release:verify`、release smoke、G0/G1、production support
matrix 或 approved registry。

## 安装、回滚和卸载

安装器只接受显式 archive 和 prefix。prefix 不能是 filesystem root、用户 home、仓库 root、symlink
或 reparse point。第一次安装创建自身 marker；后续替换、回滚或卸载要求 marker 的 canonical root
与实际目标完全一致。安装器不接管无 marker 的已有目录。

每个候选保存到 immutable `releases/<candidateId>`；首次安装以 atomic copy 创建 stable `bin/kite`、`bin/kite-tui`、
`bin/kite-service`、`bin/kite-coordinator`、`bin/kite-worker` 与 `bin/kite-web-gateway` launchers，后续 upgrade/rollback
只验证既有 launcher identity，不逐文件替换正在运行的 companion。安装器以 v2 marker 与唯一 `active` regular-file pointer 原子切换 current/previous；
running process 固定启动时的 candidate root，不重新读取 pointer。rollback 只可切换到已验证、仍位于同一 managed
root 的 previous candidate。uninstall 在删除前
精确枚举受管树并校验 marker、release checksum、launcher 与允许的目录结构；发现未知文件、目录或 link
立即停止，不删除任何内容，也不扩大删除范围。

upgrade/rollback 不停止、不 force-kill、也不删除仍在运行的旧 candidate；pointer 切换只影响后续新启动进程，
并要求 target candidate 已完整校验。只有 destructive uninstall 才在删除前调用当前 candidate 的普通
`kite service stop`、确认 `service status --json` 为 `applied + absent`，随后取得同一 Native lifecycle fence。
`service_busy`、identity uncertain、state 残留或任何 stop/status 失败都保持 active candidate 与 managed tree 不变；
installer 不手工清 state。
调用方提供custom `KiteHomeIdentity`时，ordinary stop、status确认与后续lifecycle fence必须全部使用该同一root；不得
省略`--kite-home`而误停默认Service，也不得用默认home的absence替代custom owner清理证据。
managed client接管显式或OS-derived Kite home时先拒绝symlink/non-owner identity，再仅把home目录本身收紧为owner-only；
既有descriptor/token/lock权限漂移仍fail closed，不借cleanup或install自动修复。
installer默认OS-derived code root同样直接交给Service home owner primitive创建/验证，不先用平台默认`mkdir`产生不同
owner/ACL再补救；Windows管理员token的default owner不能替代current-user SID。
installer contract tests的临时Service home也必须由同一state owner primitive创建，不能用普通Windows `mkdir`默认owner
替代current-user SID/protected DACL身份后再伪造lifecycle fence通过。

当前候选 manifest 的 `releaseSlots` 已绑定 CLI、TUI、Service、Coordinator、Worker、Gateway 与 Web entrypoint/identity；
这些 independent asset identities 不等于三平台 process/runtime qualification。POSIX atomic rename 后会
flush 父目录；Windows 使用已实现的 regular-file flush 与 atomic replacement，但 directory write-through、ACL 与
三平台安装/运行 qualification 仍须对应 hosted/真实 Windows 证据，不能以本地 macOS 结果代替。

`bun run release:smoke` 在新临时目录中完成verify、install、CLI help/version、TUI version、真实
Coordinator→Workspace Worker ensure/mint/handshake、installed `kite-service` MCP stdio wrapper、第二候选安装、rollback和uninstall。
任一步非零都使smoke失败；该本机
smoke不替代KLSV1-07三平台companion lifecycle qualification。
CLI、TUI、Service、Coordinator、Worker 与 Web Gateway candidate都从`scripts/release/entrypoints/`的显式顶层入口编译；Service
entrypoint无条件await `runKiteServiceMain()`，其余 companion 也各自调用 exact main，source manager也解析同一入口。不得依赖compiled
standalone中的`import.meta.main`判断启动，
因为其平台差异会让Windows companion在未发布ready/terminal时以0退出。Service entrypoint同时是带Bun shebang与
POSIX executable mode的source manager目标；release contract固定验证该mode，不能只保证compiled candidate可启动。
长期驻留的test-owned Worker/Coordinator在删除fixture前按descriptor中的PID+OS start token精确复核，再由test owner发送SIGTERM；
这不是产品manager的PID kill或新增Coordinator stop surface。smoke结束时会删除其独占临时根；Windows只对刚退出native executable造成的短暂文件锁执行有界重试。若smoke
本身与临时根清理同时失败，runner保留并报告两项错误，清理异常不得覆盖原始候选失败。
TUI/release fixture的显式Kite home必须在写config前由production `ensureLocalRuntimeServiceHome`创建；Windows测试不得
先用普通`mkdir`继承Administrators/runner ACL，再要求manager把不同owner目录“修复”为current-user identity。
fixture普通stop若lost response返回`outcome_unknown`，只能有界query status并要求`applied + absent`，不得自动重放stop；
仍为ready/uncertain时保持临时root并使smoke失败。`service_busy`是commit前的明确拒绝；TUI test owner可在resident
Session/Turn有界结束后重发一个新的ordinary stop，但该路径不得与`outcome_unknown`共用重试逻辑。
manager status遇到descriptor或instance-lock残留时仅在process probe明确dead后执行exact stale cleanup，并返回
`applied + absent + not_running`；alive/uncertain或cleanup fault仍不可作为unknown stop的完成证据。
Service carrier在control handler返回ack后使用有界active-response drain关闭listener，deadline耗尽才force close；不能把
`setTimeout(0)`或一次event-loop yield当作wire flush证据。即使该窗口存在，调用方仍按上述unknown-outcome规则处理
真正丢失的响应，不能由transport实现推导mutation一定未执行。
固定MCP wrapper fixture的stderr会被持续drain，但失败报告最多保留240个清洗后的可打印字符；该诊断不得包含
任意用户MCP配置、credential或模型正文。
wrapper ready或terminal拒绝后smoke仍必须调用同一handle的有界cleanup并确认process tree；失败分支不能因跳过
cleanup而用Windows executable锁掩盖原始protocol证据。
initialize响应后的synthetic stdout reader必须持续drain到terminal/EOF，并把stream error并入同一failure；
提前release reader会让Bun把无人消费的controller error抛出并绕过exit-code与cleanup报告。
失败报告同时保留wrapper的有界numeric exit code，用于区分中途生命周期退出与已提交terminal后的child结果；
该码不携带command、path、credential或用户内容。
候选启动与 MCP stdio wrapper smoke 不创建、读取或要求 `runtime-authority.key`/Artifact key；Project identity
只使用 canonical Workspace digest，SQLite Store 使用 strict canonical record 与 snapshot checksum。模型 API credential 与 MCP OAuth/
系统 keyring 仍按各自产品边界处理，不得因 Runtime 撤钥而回退到环境变量或明文文件。
固定 `--help`/`--version` 启动失败时，报告只保留退出码与 stdout/stderr 各 240 个清洗后的字符；这些
入口不读取 Provider 凭据或模型正文，诊断不写入候选 artifact。

## GitHub-hosted workflow

`.github/workflows/release-candidate.yml` 在 pull request、`main` push 和手动触发时运行
`macos-15`、`ubuntu-24.04`、`windows-2025` 矩阵。每个 job 安装正式基线 Bun `1.4.0`，执行定向 release
tests、native build/verify/smoke 和 TUI startup scenario，然后上传候选 artifact。Windows job在release tests与
candidate build前额外运行Service state owner test，验证current-user SID、protected owner-only DACL、non-reparse
identity以及ACL drift fail-closed；该单项或单平台通过都不能替代完整三平台matrix。
Platform Capability Probe 的 Windows 临时 Workspace 在采集前固定 canonical path identity，并在
写出 evidence artifact 前以同一 identity repair persistent ACL ledger；8.3 alias 不能分裂采集与清理。

workflow 只有 `contents: read`；不得申请 `id-token: write`、`attestations: write`、`contents: write` 或
`packages: write`，不得调用 `gh release` 或 npm publish。上传 artifact 是 CI 交付，不是公开 Release。

## Release Profile 与能力

Release Profile 的字段组合继续 deny-wins，只能收紧 embedded ceiling。普通候选包可以运行 TUI/CLI，
但不会因此开放未获本机安全 admission 的 effectful execution。MCP write、effectful Skills、remote
telemetry 与其他高风险 capability 默认 off；Auto Compaction 首版默认 off。

disable-only rollout、旧 production supply-chain verifier 与 promotion Gate 没有删除；它们在未配置
authority 时继续 fail closed，但只属于历史安全 contract，不参与 G0/G1，也不绑定后续 Task。

## 维护者发布边界

唯一检查清单是 `release/oss-first-release/MAINTAINER_CHECKLIST.md`。单维护者可以完成同一候选的实现、
复核和批准，不需要另一个账号或独立签名。正式 GitHub Release、npm publish 和其他不可逆公开动作
必须获得用户单独授权。
