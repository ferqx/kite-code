# Agent 生产准入策略修正记录

状态：completed
日期：2026-08-02
范围：D-03、D-04.1、D-14.1，以及跨平台发行/执行能力准入边界

## 结论

本批纠正了“Bun 三平台发行必须依赖 Ubuntu self-hosted runner”的过度约束。Windows、Linux、
macOS 继续作为本地 TUI/CLI 发行目标，原生兼容性使用 GitHub-hosted matrix；Shell、writer、Skill
child 与 local stdio MCP 按平台和精确 capability surface 独立准入。D-04 production execution
support set 仍为空，所有 probe 继续固定 `productionSupported=false`。

D-03 已关闭为 external canary 独立显式 opt-in、匿名无正文 telemetry。DeepSeek 官方 API 的
`deepseek-v4-flash` 只进入 blocked candidate registry；region 为 unknown，retention/training/DPA/
下游披露证据不足，production approved route bundle 保持为空。

本记录不完成任何新的 roadmap Task，不产生 milestone、production artifact、canary/SLO evidence
或第三方安全评审结论。

## 实现与文档

- 删除未提交的 Ubuntu self-hosted 专用 qualification workflow/verifier，增强已有
  `platform-capability-probe.yml` 三平台 GitHub-hosted matrix；Actions 固定 immutable SHA。
- evidence 绑定 repository/head/ref/workflow/run/attempt 和封闭 runner class，并拒绝 runtime
  platform/architecture mismatch。
- TUI 与 foreground CLI 使用共享 App sandbox composition；无法安全实现 descendant allowlist 时
  fail closed，不映射为 `allow_all`。
- Linux 候选增加 cgroup v2 pids `TasksMax` transient user scope、真实可用性探针和独立
  hard-count/cleanup 投影；代码存在不构成平台资格。
- qualification schema 增加精确 process capability surface；首个候选只声明 Shell，forked Skill/
  local stdio MCP 保持 false。
- 新增 ADR-0065，并同步 active 文档、README、book、roadmap、decision register 与
  `docs/documentation-map.json`。

## 验证

- 平台/数据/telemetry 定向批次：63 pass，0 fail。
- Config、CLI、SessionManager 入口回归：104 pass，0 fail。
- 单个 TUI `sandbox-mode` PTY 场景：1 pass，0 fail。
- `bun run typecheck`：通过。
- `bun run check:core-boundary`：通过。
- `bun run check:docs-impact`：通过。
- `bun run check:docs`：通过；10 plans、108 tasks、14 decisions。
- `git diff --check`：通过。
- macOS 26.6 开发机原生 probe：真实结果为 `excluded`、`productionSupported=false`；无 GitHub
  source identity，未登记为正式 evidence。
- 本批 22 个代码/JSON 文件的 Biome check 无 error；`session-manager.ts` 的 9 个既有
  `noExplicitAny` warning 未在本批顺带修改。全仓 `format:check` 仍被无关既有 lint/format 债务
  阻断，留待整体收口门禁统一处理，不能据此宣称最终 Gate 已绿。

## 真实证据等待

- 更新后的 GitHub-hosted macOS/Ubuntu/Windows workflow 尚未在合并后的默认分支产生新 artifact；
  旧 D-04 空支持集不变。
- DeepSeek route 仍缺 API 正文固定 retention、已验证 training opt-out、DPA、region contract 与
  下游用户披露实现。
- external canary 仍缺真实 exporter、显式 opt-in cohort、预注册 baseline 和 observation window。
- external release 前仍需另一位真人完成绑定 candidate 的第三方安全评审。

## 回滚

可关闭新增候选探针或继续保持全部 capability off。不得恢复 self-hosted Ubuntu 作为普通三平台
发行前置条件，不得把 Docker/WSL2 模拟结果登记为原生 artifact，也不得因 Bun 能启动而开放未经
验证的 effectful capability。
