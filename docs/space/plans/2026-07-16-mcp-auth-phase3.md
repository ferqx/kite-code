# MCP Auth Phase 3 实施计划

状态：active
优先级：P1
创建日期：2026-07-16
来源：用户指令“开始 2026-07-15-mcp-tui-management-center-implementation Phase3”
依赖：ADR-0010、ADR-0012、Phase 2 配置与 reconcile
替代边界：只承接旧总计划 Phase 3 的 Core auth/credential 目标；TUI 路由继续以 ADR-0012 为准。

## 目标

在不恢复 `/mcp` 管理中心的前提下，交付 OS vault-only Credential Store、静态 credential reference、HTTP OAuth discovery/PKCE/callback/refresh/revoke、Supervisor auth 状态和 App shell 独立恢复提示。认证成功只通过新 discovery 和新 model turn 恢复能力，不重放旧 Tool Call。

## 已完成

- [x] 选择 `@napi-rs/keyring@1.3.0`，禁止文件与 CLI fallback；
- [x] Credential Store contract、native backend、memory fake、material/key validation；
- [x] macOS Bun 加载与 write/read/delete 原生 smoke；
- [x] SDK `OAuthClientProvider` 的 token/client/verifier/discovery 持久化；
- [x] 高熵 state、constant-time callback 校验、127.0.0.1 随机端口、timeout/cancel；
- [x] 无 shell browser opener；后台 401 不自动打开浏览器；
- [x] Manager begin/finish OAuth、stored-token resume、新 discovery；
- [x] environment/credential/OAuth metadata schema，inline client secret 拒绝；
- [x] static credential header 只在 transport 构造时解析；
- [x] remote token revocation helper；
- [x] `/mcp` 保持只读，独立 App shell Login/Cancel 提示；
- [x] fake unit、真实本地 HTTP OAuth integration、component 与 leak assertion；
- [x] macOS/Windows/Ubuntu 原生 keyring smoke workflow 与 Linux Secret Service session 启动步骤；
- [x] ADR/active/README/book/documentation map 更新。

## 剩余退出门禁

- [ ] Windows + Bun + Windows Credential Manager write/read/delete smoke；
- [ ] Linux + Bun + Secret Service write/read/delete smoke；
- [x] TUI PTY：login required 不自动打开浏览器，Esc defer 后输入恢复；
- [x] TUI PTY：Login、Cancel、opener failure，且不访问真实系统保险库；
- [x] 完整非 PTY 测试、docs impact、docs、typecheck、boundary、diff check 与本次改动文件 Biome check；
- [ ] 仓库级 `format:check` 基线收敛（当前失败来自本次范围外的既存 Biome 配置版本与文件告警）；
- [ ] 完成记录与旧总计划 Phase 3 状态归档。

## 验证

```bash
bun test tests/mcp-credential-store.test.ts tests/mcp-oauth-provider.test.ts tests/mcp-auth-coordinator.test.ts tests/mcp-oauth-integration.test.ts tests/mcp-manager.test.ts tests/mcp-supervisor.test.ts tests/mcp-config-catalog.test.ts tests/mcp-panel.test.tsx
bun test --parallel=1 --max-concurrency=1 tests/tui-system/scenarios/mcp-authentication.test.ts
KITE_RUN_NATIVE_KEYRING_SMOKE=1 bun test tests/mcp-keyring-platform-smoke.test.ts
bun run typecheck
bun run check:core-boundary
bun run check:docs-impact
bun run check:docs
```

Phase 3 只有在三个生产平台 native smoke、PTY 场景和仓库门禁都通过后才能标记 completed/archived。在此之前不得以 macOS 单平台证据替代跨平台 backend 退出标准。
