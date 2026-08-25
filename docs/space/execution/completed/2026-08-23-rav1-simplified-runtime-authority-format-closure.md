# RAV1 简化 Runtime Authority & Format 收口完成记录

状态：completed

日期：2026-08-23

权威来源：用户直接裁决、当前源码与测试、`docs/active/`、ADR-0127、
`2026-08-20-kite-runtime-authority-format-v1-implementation.md`

实施 baseline：`2b4b4e01da0a554a9f6e83ffeba8b7d7953f2c41`

Implementation final SHA：`938c43b9e6156e89e25f316780b9c713c24b1042`

Final documentation SHA：本记录所在提交；该 SHA 不在文件内自引用，由本记录第 6 节定义的
GitHub workflow `headSha` 与仓库最终同步状态机械绑定。

## 1. 用户问题与裁决

早期 RAV1 实施把推测性 authority 扩大成 installation key、ProjectHandle、single-Host 全局锁、
内部 HMAC/authority frame、DataOrigin/EgressAuthority ledger、remote permit 与固定 Provider policy。
它们导致了两个真实启动故障：安装密钥缺失以及同进程重复 composition 会让 TUI unrecoverable。

用户明确要求全部移除这些过度设计，且后续 bugfix 只修复已复现的根因。ADR-0127 记录了这一
最终决策，ADR-0126 及原 RAV1-00～06 completion records 已 superseded。

## 2. 最终 production truth

- Project identity 只是 canonical Workspace 的确定性标识；无 ProjectIdentityStore、ProjectHandle、identity file 或全局 Host lock。
- Runtime/Artifact 不创建、读取或要求 installation key；同进程 seam 与 child control channel 都无 HMAC/authenticator/secret bootstrap。
- POSIX、Windows 与 MCP stdio 只使用 Host-owned OS channel、process/Job identity 与 strict bounded `RuntimeControlFrameV1`。
- Private Artifact 使用 path-free SHA-256 内容寻址、owner-only/no-follow、atomic no-replace publish 与 strict readback。
- Model 五个 purpose 经同一 Gateway 与 configured-provider admission；无 release-pinned route registry 或 policy flag。
- MCP Manager 是唯一 protocol operation owner；HTTP 使用 exact endpoint/TLS/network、bounded argument/secret inspection 与共享 CredentialBroker；无 permit/nonce/ledger。
- 新 Session 只使用 State26、Store5、`.runtime-state26-store5.db` 与 epoch `kite-runtime-modularization-v1-2026-08-19`。Store5 exact DDL 为 7 tables / 2 indexes；旧 Store4 不读取、不迁移、不修改、不 fallback。

## 3. 保留的用户修复

用户原有 model streaming inactivity timeout 与 structured exhausted-retry terminal 改动已保留并纳入同一原子切换。
`tests/model-invocation-gateway.test.ts` 继续验证 active stream 不被 inactivity deadline 误杀，
`tests/runtime/agent.integration.test.ts` 继续验证 structured attempt outcome 进入 `model_retry_exhausted` 终态。

## 4. 有依据的 bugfix

收口过程只修复了 Gate 实际复现的问题：Darwin cleanup 的无效 `chflagsat` 路径、PTY fixture 无界等待、
standalone POSIX/MCP wrapper 首启超出 5 秒、Private Artifact 并发发布 inode race、first-run TUI readiness 时序，
以及 Windows runner 源码变化后的可复现 binary digest pin 漂移。没有为这些 bug 新建密钥、协议、兼容层或推测性威胁模型。

## 5. 本地 Required Gate

| Gate | 结果 |
| --- | --- |
| `bun install --frozen-lockfile` | passed；lockfile 无漂移 |
| `bun run typecheck`、`bun run build` | passed；7 workspace |
| `bun run format:check`、`bun run lint` | passed；既有 warning、0 error |
| runtime package/core/docs/docs-impact/manifests | passed；State26/Store5/new epoch，7 tables / 2 indexes |
| `bun run test` | passed；root 3495 pass / 6 skip / 0 fail，全部隔离文件与 workspace tests 通过 |
| `bun run test:tui:system` | passed；39 个隔离 PTY scenario |
| `bun run test:runtime:fault` | passed；35 pass / 0 fail |
| `bun run test:runtime:soak` | passed；7/7 case，无 orphan PID/worktree/residual path |
| `bun run release:build`、`bun run release:smoke` | passed；installed MCP wrapper 与 install/upgrade/rollback/uninstall 通过 |
| production deleted-owner static scan | passed；key/HMAC/ProjectHandle/global lock/DataOrigin/EgressAuthority/permit/fixed policy 为 0 |
| 正常 pre-commit hooks | passed；未使用 `--no-verify` |

## 6. 受信 GitHub 证据

Implementation final SHA `938c43b9e6156e89e25f316780b9c713c24b1042` 上：

- [Platform Capability Probe 32624192364](https://github.com/ferqx/kite-code/actions/runs/32624192364) passed；macOS、Ubuntu、Windows 三个 native job 全过，其中 Windows 包含固定 Rust toolchain、Cargo tests、native build、restricted-token E2E 与 capability verifier。
- [OSS Release Candidate 32624193937](https://github.com/ferqx/kite-code/actions/runs/32624193937) passed；macOS arm64、Linux x64、Windows x64 候选构建、安装、启动、MCP wrapper、回滚与卸载全过。
- [Runtime Resilience Qualification 32624195770](https://github.com/ferqx/kite-code/actions/runs/32624195770) passed；seed 1729，7 case × 8 measured = 56 attempts 全部 passed，独立 verifier 与 artifact upload 成功。

本记录所在 final documentation commit 必须再运行同样三套 workflow，且三个 run 的 `headSha`
必须精确等于该提交。这些 external check records 是 final SHA 证据；为避免自引用改变 Git commit SHA，
不将 final SHA/run ID 回写到该提交内。三项通过后不再创建后续提交。

## 7. 完成裁决

RAV1-01～06 已按 ADR-0127 简化边界完成 production cutover、本地 Gate 与 implementation-SHA qualification。
原 completion records 只作 superseded history。总计划归档；完成状态的最终机械条件是第 6 节所述 final documentation SHA
三套 workflow 成功、远程分支同步且工作树干净。
