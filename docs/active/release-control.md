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

## 候选制品

`bun run release:build` 使用 Bun standalone executable 编译当前平台的 `kite` 与 `kite-tui`，输出：

- gzip tar 候选包；
- exact-key JSON manifest，绑定产品版本、Git commit、Bun、target 和逐文件 SHA-256；
- archive SHA-256 sidecar；
- release notes、known limitations 与普通维护者检查清单。

Windows candidate 还包含 pinned `kite-windows-runner.exe`、runner manifest 和 vendored
`isksh`/Coreutils runtime（含许可文件）。安装后的 launcher 通过 managed-install marker 从当前
candidate payload 解析这些文件；缺失、替换或 digest 不匹配时仍 fail closed，不会把 native runner
替换为未验证程序。Windows GNU Rust 构建必须经过
`bun run scripts/release/build-windows-runner.ts`：该入口把 checkout 与 Cargo cache 的绝对路径映射到
固定虚拟路径，固定使用 Rust toolchain 自带的 `rust-lld`，并禁止 PE linker 写入墙钟时间戳。因此
固定 toolchain 的 clean build 可在本地与 GitHub-hosted Windows runner 上生成同一 runner digest，workflow 才能在打包前用 committed
manifest pin 执行 `git diff --exit-code`。直接调用 Cargo 不得用于生成或验证 release pin。
当前 0.8.3/V6 runner pin 为
`sha256:288f4ec919722717fdc605338a2631fb681dff6013c21b4e586b0f256143c7e8`；Windows candidate 与
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
Standalone resolver 必须覆盖七个 workspace package 的全部 public export，并直接解析到仓库 source；候选构建
不得穿过 `apps/kite/node_modules/@kite/*` workspace symlink。该不变量避免 Windows Bun 1.3.14 把反斜杠
symlink path 当成非法 pretty path 而崩溃，并由 release test 对每个 `package.json#exports` 机械核对。

源码通过 Bun 运行时继续使用 `@napi-rs/keyring` 的系统凭据库。由于 Bun standalone 不能在三平台上
稳定封装该 N-API binding，预构建候选把该 adapter 固定为方法级 `unavailable`：构造和普通启动不失败，
但任何 credential get/put/delete 都 fail closed。它不回退到文件、环境变量或明文存储；该限制必须在
release notes 中披露，解除前预构建候选不声称支持持久 MCP 凭据。

候选 executable 由 `scripts/release/entrypoints/` 的无 guard 薄入口显式调用 CLI `main()` 或 TUI
`runTui()`；不能依赖 compiled runtime 对 `import.meta.main` 的平台相关判定。源码入口仍保留自身 guard，
避免被测试或其他模块导入时自动启动。

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

每个候选保存到 `releases/<candidateId>`，`bin/` 只保存当前激活 binary。新安装原子更新 current/previous
指针；rollback 只可切换到已验证、仍位于同一 managed root 的 previous candidate。uninstall 在删除前
精确枚举受管树并校验 marker、release checksum、launcher 与允许的目录结构；发现未知文件、目录或 link
立即停止，不删除任何内容，也不扩大删除范围。

`bun run release:smoke` 在新临时目录中完成 verify、install、CLI help/version、TUI version/start probe、
第二候选安装、rollback 和 uninstall。任一步非零都使 smoke 失败。
候选启动与 MCP stdio wrapper smoke 不创建、读取或要求 `runtime-authority.key`；Project identity 使用
State26/Store5 V2 strict store，Store5 使用 keyless integrity record。模型 API credential 与 MCP OAuth/
系统 keyring 仍按各自产品边界处理，不得因 Runtime 撤钥而回退到环境变量或明文文件。
固定 `--help`/`--version` 启动失败时，报告只保留退出码与 stdout/stderr 各 240 个清洗后的字符；这些
入口不读取 Provider 凭据或模型正文，诊断不写入候选 artifact。

## GitHub-hosted workflow

`.github/workflows/release-candidate.yml` 在 pull request、`main` push 和手动触发时运行
`macos-15`、`ubuntu-24.04`、`windows-2025` 矩阵。每个 job 安装锁定 Bun 版本，执行定向 release
tests、native build/verify/smoke 和 TUI startup scenario，然后上传候选 artifact。
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
