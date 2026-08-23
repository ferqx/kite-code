# Kite Runtime Authority & Format V1 实施方案

状态：active

日期：2026-08-20；2026-08-23 按用户裁决与 ADR-0127 重开收口

优先级：P0

父 RFC：[`Kite Runtime Modularization V1 RFC`](../../design/2026-08-19-kite-runtime-modularization-v1-rfc.md)

分期决策：[`ADR-0124`](../../adr/0124-runtime-modularization-staged-delivery.md)、[`ADR-0125`](../../adr/0125-accepted-rfc-staged-revision.md)

最终简化决策：[`ADR-0127`](../../adr/0127-remove-rav1-speculative-authority.md)

当前实施 baseline：`2b4b4e01da0a554a9f6e83ffeba8b7d7953f2c41`

Implementation final SHA：pending

目标 Runtime State schema：`26`

目标 Runtime Store schema：`5`

目标 epoch：`kite-runtime-modularization-v1-2026-08-19`

## 1. 重开原因

早期 RAV1 completion records 与 `604db49d` qualification 证明的是一套随后被用户否决的实现：持久 ProjectHandle、single-Host lock、内部 key/HMAC、child key bootstrap、DataOrigin/EgressAuthority/remote permit、fixed Provider policy 和带 authority ledger 的 Store5。它们还引入了真实的启动错误：缺 installation key 或同进程重复 composition 会让 TUI unrecoverable。

用户要求删除全部过度设计。因此原 RAV1-01～06 的“completed”标签和旧 run 只能作为历史证据，不能证明本次最终 production truth。当前计划按源码重新打开，并以 ADR-0127 的简化边界收口。

## 2. 最终目标

1. canonical Workspace 的确定性 Project identity；无 Store/Handle/installation lifecycle。
2. 一个 App composition root、一个 Host/Store operation owner；无全局 single-Host lock。
3. POSIX/Windows/MCP stdio 使用 Host-owned OS channel、strict bounded `RuntimeControlFrameV1` 和 process supervision；无 secret bootstrap/HMAC/authenticator。
4. Private Artifact 使用 SHA-256 内容寻址、owner-only/no-follow、atomic publish 与 strict readback；无 Artifact key。
5. Model 五 purpose 使用一个 Gateway 与 configured-provider admission；无 fixed route registry/feature flag。
6. MCP Manager 是唯一 protocol owner；HTTP 使用 endpoint/TLS/network、bounded argument inspection 与共享 CredentialBroker；无 DataOrigin/EgressAuthority/permit/ledger。
7. 新 Session 只使用 State26/Store5/new epoch；Store5 exact DDL 为 7 tables / 2 indexes，Event canonical JSON、Snapshot checksum；旧 Store4 不读取、不迁移、不修改。
8. 保留真实 OAuth/API credential broker、attempt acknowledgement、revision/effect lease、native sandbox、cleanup、strict restore/fork/rewind/delete、stream inactivity retry 与 structured terminal fixes。

## 3. Owner/delete matrix

| Scope | 唯一 production owner | 删除项 |
| --- | --- | --- |
| Project identity | Runtime Host deterministic resolver | ProjectIdentityStore、ProjectHandle、identity file/composition |
| Session/Store | App bootstrap + Host session + SQLite V5 adapter | single-host lock、Store4 public constructor、old/new fallback |
| Child control | Runtime Host process port/wrapper | AuthorityKey、FD/stdin key bootstrap、HMAC/authenticator/envelope |
| Model | Builtin Gateway/response source/transport | fixed Provider policy registry、route candidate、policy flag、second caller |
| Private Artifact | Builtin domain stores | artifact-key loader/file、keyed ref/HMAC/key-loss terminal |
| MCP protocol | Builtin Supervisor/Manager | SDK direct stdio spawn、App second decision、remote permit/receipt |
| Credential | one Builtin CredentialBroker | Manager/Auth/OAuth default stores、ambient env/raw secret fallback |
| Runtime format | State26 codec + Store5 adapter | persisted authority codec、origin/egress/nonce tables、header shim |

## 4. 阶段状态

| Stage | 状态 | 当前验收 |
| --- | --- | --- |
| RAV1-01 simplified identity | implementation complete; Gate pending | CLI/TUI no key/no lock；canonical alias identity；removed caller/static scan |
| RAV1-02 control boundary | implementation complete; native Gate pending | POSIX/MCP real child；Windows TS；final-SHA Windows Cargo/native E2E required |
| RAV1-03 Model/MCP/Credential | implementation complete; Gate pending | five-purpose Gateway；HTTP argument inspection；one broker；secret absence |
| RAV1-04 no speculative fencing | implementation complete; Gate pending | no global lock；SQLite revision/lease concurrency facts；multi-process startup |
| RAV1-05 State26/Store5 | implementation complete; Gate pending | exact 7/2 DDL；all-session preflight；fork/rewind/delete/reopen；old bytes unchanged |
| RAV1-06 cutover/qualification | active | full default/TUI/fault/soak/package/docs/manifests；final SHA Platform/OSS/7×8 verifier |

## 5. Stop-and-report Gate

- `bun install --frozen-lockfile`；
- 7 workspace typecheck/build/test、root format/lint；
- runtime packages/core/docs/docs-impact/manifests；
- full default `bun test` 与完整 `test:tui:system`；
- fault、local soak、release/installed wrapper smoke；
- POSIX/MCP real child negatives；Windows Cargo fmt/check/test/build/restricted-token E2E/probe；
- production static scan 清零已删除 owner、key/HMAC、permit/policy/ledger 与 legacy public path；
- GitHub Platform、OSS、7 case × 8 measured Runtime Resilience Qualification + verifier 全部绑定唯一 final SHA。

任何失败、skip 覆盖 required native case、未提交改动、远端不同步或旧 SHA evidence 都不能完成本计划。

## 6. Cutover 不变量

- 不保留 try-new-catch-old、异常 fallback、双写、双 handler、第二 registry、隐式 compatibility adapter。
- 旧 Store4 只允许 test support 显式打开并验证 bytes 不变；production package 只导出 V5。
- 同进程 typed seam 不增加密码协议；control frame 不声称 cryptographic authenticity。
- 真正的 API/OAuth credential 只在 Broker 使用点物化，不能因删除内部 key 而退回环境变量或明文配置。
- 最终文档、completion evidence、push 后工作树与 qualification 必须共同收敛；在此之前保持 `active`。
