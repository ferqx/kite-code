# Kite Runtime Server V1 完成记录

状态：completed（KRSV1-00～KRSV1-10，含 06A/06B，本地全量与 implementation head `ba144ca0` 的 PR checks 全部通过）

日期：2026-08-26

方案：[`2026-08-26-kite-runtime-server-v1.md`](../../plans/2026-08-26-kite-runtime-server-v1.md)

ADR：[`ADR-0142`](../../../adr/0142-kite-runtime-server-v1.md)、
[`ADR-0143`](../../../adr/0143-local-runtime-client-event-presentation-fidelity.md)、
[`ADR-0053`](../../../adr/0053-web-access-no-go.md)

Pull Request：[#65](https://github.com/ferqx/kite-code/pull/65)

Implementation head：`ba144ca0e9872c96f367c93a95fc38f52ed99191`

## 1. 最终架构结果

- Runtime Host 仍是唯一 `RuntimeAccess`、Session FIFO mailbox、lifecycle、recovery、revision 与 persistent
  command receipt owner。Server 只拥有 Protocol validation、connection、subscription 与 bounded delivery，
  Client 只拥有 correlation、generation/resubscribe 与 snapshot；没有第二 Runtime、Store writer 或 domain waiter。
- `runtime-protocol` 使用封闭 allowlist、exact JSON-RPC V1 codec、完整运行时校验与显式 limits。Workspace/Session
  authority 由 App admission 固定，wire input、client metadata 与 display name 都不能提升 authority。
- TUI 与 foreground CLI 只走 `RuntimeClient → RuntimeServer → RuntimeAccess`；InProcess 经过同一 codec、initialize、
  admission、ordering 与 limits。production 不保留 Host bridge、dual execution、catch-new-then-old 或 fallback。
- Store 6 的 scoped command identity、request digest 与 applied receipt 和 Runtime state/event/snapshot/revision 在同一
  transaction 提交；restart retry 返回原 fact，不能 sidecar 双写、隐藏 DDL drift 或非原子补写。
- stdio concrete I/O 与 development loopback WebSocket 位于 App/carrier；Server core 保持 transport-neutral。
  WebSocket 只形成 development/reference evidence，未新增 `server --web` 或 production Web support，ADR-0053 未改变。
- 完整历史由 App exhaustive client-event projector 与 SQLite query-only reader 提供，live/replay 使用同一 TUI reducer。
  ADR-0143 保留本地 reasoning、动态 tool label、普通 path/pattern/command/result，同时继续过滤明显 credential/authority material。

## 2. KRSV1 任务收敛

| Task | 结果 | 关键证据 |
| --- | --- | --- |
| KRSV1-00 | completed | ADR-0142、LOGWEB-05～09 owner 串行裁决、Store 6 决策与 baseline Gate |
| KRSV1-01～04 | completed | closed Contract、exact Protocol、transport-neutral Server/InProcess、Client generation/snapshot/reconnect |
| KRSV1-05 | completed | TUI/CLI 单路径；重复 user/assistant reply、Thinking/工具聚合、间距、动态 label、无效 slash/审批诊断文案均固定 |
| KRSV1-06A/06B | completed | 原子 receipt、crash-after-commit replay、restart/multi-client conflict 与零重复 dispatch |
| KRSV1-07 | completed | parent-owned stdio child、真实 JSONL/EOF/backpressure/restart；本地 18 tests 与三平台 workflow |
| KRSV1-08 | completed | loopback-only development WebSocket、bootstrap/cookie/Host/Origin/heartbeat negative matrix；本地 24 tests |
| KRSV1-09 | completed | InProcess/stdio/WebSocket raw Protocol matrix 3 tests / 852 assertions 与三平台 workflow |
| KRSV1-10 | completed | current docs、README、ADR、documentation map、plan/completion index 与全部本地/PR Gate |

## 3. 审查与用户复测修复

PR 审查指出的三个问题在 `5f6cd898` 收敛，线程均已回复并 resolved：

1. connection generation 变化立即清空旧 Session/stream snapshot，旧 `ready` 与 revision 不再跨 Server generation
   可用；替代 Server 可以 authoritative 建立更低 revision。
2. `afterRevision` 超过 Host watermark 时，Server 关闭不可能完成的旧 iterator，以 watermark 重新订阅并发送
   reset → ready；后续 live revision 连续交付，不会永久等待或错误断线。
3. connection/global outbound budget 同时计入 queued 与 in-flight send；reservation 只在 send resolve/reject 后释放，
   blocked carrier 不能把一条大消息移出预算。

用户真实会话随后暴露 `Bash + search + search` 并发完成顺序：search summary 先完成，较早启动的 standalone Bash
terminal 后到，旧 reducer 错误关闭了后来创建的 search Thought。`f3646fec` 以 block ownership 固定 terminal 边界；
completed reasoning 即使晚于 durable final text，也回填紧邻的 exploration summary。退出、重启并 `/resume` 同一会话后，
仍只有一个 `Thinking … · searched 2 file patterns`，无需创建新会话。真实 Store 6 会话的 168 条 raw event 只读审计
也重建为 `hasThinking=true`、`modelMs=13961` 的同一第二摘要；临时审计副本已删除。

同一修复恢复 Thinking 题头与首 caption/最终回答之间恰好一行空白，保留 captions 内部紧凑顺序；Approval 面板
移除 queue sequence/generation/interaction ID 文案，只保留人工/自动审批与必要动作。内部 exact identity 与 settlement
校验未改变。

后续真实 DeepSeek 会话又暴露合法的 `reasoning prefix → visible content → reasoning suffix` 流序：旧 reducer
把首段正文保留为 active Thought 的 caption，suffix completed 后便在回答下方重新显示原始 reasoning 与活动圆点。
本地 Store 只读审计确认 durable `model.responded` 同时完整保留 final text 与 2370 字符 reasoningText；Server、Gateway
与 history 数据没有缺失。`ba144ca0` 因此不在 transport 丢弃 reasoning，也不新增 privacy redaction：首个可见正文只把
纯 reasoning summary 转为 `awaiting_terminal`，suffix 继续进入同 request 的隐藏 Thought metadata；terminal 若声明
tool calls，同一 summary 会重新激活为工具旁白，既不泄漏/重复最终回答，也不破坏既有工具聚合。

测试 harness 新增 exact frame sequence/delay，可逐帧发送 prefix → content → suffix → stop/[DONE]。临时移除新的
pure-summary settlement guard 时，真实 PTY 稳定复现回答后 `● Thinking` 与 reasoning 原文；恢复后 live 和退出、重启、
`/resume` 都只有一个 `Thinking Ns` 题头、一个回答与一行固定间距。Server/Client owner tests 仍为
34 pass / 0 fail / 430 assertions；TUI layout/reducer 为 295 pass / 0 fail，TUI harness 为 121 pass / 0 fail，
全部 40 个隔离 PTY scenario files 通过。临时 Store 审计副本已删除，原 Store 未修改。

后续真实 `curl -s --max-time 20 'https://wttr.in/?format=3&lang=zh'` 审批又暴露 development sandbox
scope 回归：prepared consumer 把用户对 exact invocation 批准的 `network=allow_all` 错误映射成 production
`network.allowlist` evidence；当前 backend 如实报告该 production 能力为 `unsupported`，于是批准后的命令仍在
dispatch 前返回 `invalid_grant`。`d4bb0c17` 恢复 ADR-0082/ADR-0101 已接受的边界：POSIX 的受限
filesystem/network-off scope 继续要求 `enforced` evidence，批准后的 development `allow_all` 则按该次 sealed grant
执行，不能伪装或反推 production qualification。Windows 仍要求 approved network 与同次
`filesystem=allow_all` 配对；exact command/grant/identity、expiry、durable lifecycle、backend digest、read-only
冲突与独立 hard deny 均保持 fail closed，production support set/allowlist 仍为空且未扩大。

回归覆盖同一条 weather command 在批准前零 dispatch、`approve_once` 后恰好一次 `networkMode=allow_all`
dispatch；Provider/consumer matrix 同时验证 seatbelt、bubblewrap、Windows lower-assurance scope、evidence drift、
read-only/full 冲突与零 replay。macOS 原生 Seatbelt smoke 为 32 pass，证明默认网络仍阻断而批准网络可到达本地
HTTP endpoint；[Platform run 32985188902](https://github.com/ferqx/kite-code/actions/runs/32985188902) 的 macOS 15、
Ubuntu 24.04、Windows 2025 全部通过。Windows 首轮只暴露测试把受控 `PATH` shell 前导误当 argv drift；
`970c5e28` 将断言收紧为 payload 必须以 exact approved command 结尾，产品代码未再改变。

## 4. 本地最终验证

| Gate | 结果 |
| --- | --- |
| `bun run typecheck` / `bun run build` | 10 个 Runtime workspace 全部通过 |
| `bun run test` | 269 workspace files、94 integration/golden/release/harness files、46 isolated files 全部通过 |
| `bun run test:tui:system` | 40 个隔离 PTY scenario files 全部通过 |
| `bun run test:runtime:transport` | 3 pass / 852 assertions；InProcess、真实 stdio 与 development WebSocket 同矩阵 |
| stdio / development WebSocket | 18 / 24 tests 全部通过 |
| Runtime fault / soak | fault contract 35 pass / 1 platform-conditional skip；CI profile 7/7 cases |
| approved sandbox scope | exact weather approval、prepared consumer/provider matrix 与 macOS native smoke 32 pass；Platform run 32985188902 三平台通过 |
| docs/static | docs-impact(all/staged)、docs、core boundary、package/test ownership、pre-release architecture、compaction 与 diff/format Gate 通过 |
| release | release tests 161 pass；本地 candidate build/verify/smoke 通过 |

## 5. GitHub Actions

Implementation head `ba144ca0` 的适用检查全部成功：

- [Required run 32982515513](https://github.com/ferqx/kite-code/actions/runs/32982515513)：unit、quality、runtime-e2e、
  runtime-fault-soak、compaction、TUI shard 0/1/2/3 与 aggregate；`protected-branch` 对 feature branch 按设计 skipped。
- [Runtime stdio run 32982515507](https://github.com/ferqx/kite-code/actions/runs/32982515507) 与
  [transport run 32982515366](https://github.com/ferqx/kite-code/actions/runs/32982515366)：macOS 15、Ubuntu 24.04、
  Windows 2025 全部成功。
- [Platform run 32982515516](https://github.com/ferqx/kite-code/actions/runs/32982515516)、
  [OSS RC run 32982515533](https://github.com/ferqx/kite-code/actions/runs/32982515533)、
  [Execution Boundary run 32982515385](https://github.com/ferqx/kite-code/actions/runs/32982515385) 与
  [MCP keyring run 32982515407](https://github.com/ferqx/kite-code/actions/runs/32982515407) 全部成功。

## 6. 明确保留的非目标

- 不交付 production Web/SSE/HTTP log listener、Web UI、Desktop 完整产品或公开长期兼容的通用 SDK。
- development WebSocket 不改变 ADR-0053，也不扩大首发支持矩阵。
- Builtin `web_fetch` 的 release-controlled network boundary 不在 KRSV1 范围内；普通 TUI 缺少 boundary 时继续在 DNS
  前 fail closed，审批或 Full 不能绕过。实际启用外网 fetch 需要后续独立 network admission/qualification 决策。
- 本记录的 PR native evidence 不冒充 `runtime-resilience-qualification.yml` 的正式 7×8 manual qualification；
  Required workflow 的 CI-profile fault/soak 只登记为本 tranche 的实现 Gate。
- Server/Client 不取得 raw Runtime Event、Store handle、SQLite writer 或 Runtime lifecycle authority；完整 history
  继续由 App-local query-only path 提供。
