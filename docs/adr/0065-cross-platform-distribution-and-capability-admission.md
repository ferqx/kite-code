# ADR-0065：跨平台发行与执行能力资格正交

状态：accepted
日期：2026-08-02
决策者：`github:@ferqx`（Platform + Release，single-maintainer）
关联：D-04、Phase 1B、Phase 2A、ADR-0053、ADR-0054、ADR-0061

## 背景

Kite Code 是由 Bun 运行的本地 TUI/CLI，正式发行目标是 Windows、Linux 与 macOS。某个平台能
安装、启动并完成非特权 Runtime 行为，不等于该平台已经证明了 Shell、writer、Skill child 或
local stdio MCP 所需的 filesystem、network、process-tree 与 child-inheritance 隔离。

把 Linux 强隔离候选误写为整个产品的首个生产平台，会不必要地要求维护一台 self-hosted Ubuntu
runner，并把跨平台发行与某项 effectful capability 的技术资格耦合。反过来，仅凭 Bun 支持某个
操作系统就开放该系统上的自动执行能力，也会绕过 ADR-0061 的逐项准入。

## 决策

1. Windows、Linux 与 macOS 是本地 TUI/CLI 的发行目标。安装、启动、PTY/ConPTY、路径、ACL/
   keyring、配置和非特权 Runtime contract 使用 GitHub-hosted 原生矩阵分别验证。
2. `.github/workflows/platform-capability-probe.yml` 使用固定的 `macos-15`、`ubuntu-24.04` 与
   `windows-2025` runner，并在 evidence 中绑定精确 GitHub repository/head/ref/workflow/run/
   attempt 和 runner class。Docker、WSL2、交叉编译或指令模拟只可作为开发预检，不能替代这些
   runner class 的原生 evidence。
3. 发行平台与 execution capability 分开准入。平台可以发行 TUI/CLI，而未通过原生 conformance
   的 Shell、writer、Skill child、local stdio MCP 或 network capability 必须保持关闭并显示准确
   状态；审批不能恢复被技术边界关闭的能力。
4. Linux bubblewrap + seccomp + cgroup v2 pids 是 Shell 的候选实现，不是跨平台发行前置条件。
   GitHub-hosted Ubuntu 先运行真实探针；若 user namespace、user systemd scope 或 cgroup controller
   不可用，artifact 必须保留 `excluded`，不得改用 self-hosted runner 伪装通用发行要求。
5. qualification 只要求 evidence 所声明的 capability surface。首个候选 surface 可以包含 Shell，
   同时把 forked Skill 与 local stdio MCP 明确设为 `false`；未声明能力不因同一 sandbox executor
   存在而继承资格。
6. ADR-0061 接受的 D-04 空支持集保持不变。probe 固定输出 `productionSupported=false`；任何非空
   production execution support 仍需新的追加决策、新鲜原生 evidence 和独立 release gate。

## 备选方案

- 只验证开发者的 macOS：拒绝，不能证明 Windows/Linux 的本地行为。
- 所有平台必须先具备等强 sandbox 才允许发行 TUI：拒绝，混淆产品可运行性与 effectful capability。
- 以 Docker/WSL2 或 `linux/amd64` 模拟替代原生矩阵：拒绝，kernel、cgroup、PID 1 与清理语义不同。
- 永久要求 self-hosted Ubuntu：拒绝；只有明确的受控部署环境资格才应引入其独立 runner identity。

## 后果

维护者无需为常规三平台发行验证维护第二台机器。GitHub-hosted matrix 产生可复现的原生候选
evidence；平台差异通过精确 capability surface 和 fail-closed 状态表达。某个平台的强隔离探针
失败不会伪装成通过，也不会错误地阻断该平台上不依赖该能力的 TUI/CLI 行为。

## 回滚

可以进一步关闭某个平台或 capability，也可以在真实部署需求出现后新增 self-hosted runner class。
不能回滚为 Bun 可启动即开放自动执行、用模拟环境冒充原生 evidence，或让单个平台探针结果代表
三平台支持。
