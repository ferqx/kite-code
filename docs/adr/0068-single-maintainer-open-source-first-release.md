# ADR-0068：单维护者开源首发模型

状态：accepted
日期：2026-08-04
决策者：github:@ferqx
取代：ADR-0060、ADR-0062、ADR-0067 中关于首发外部评审、签名、attestation 与多阶段 promotion 的硬门禁；ADR-0052、ADR-0057、ADR-0058、ADR-0059、ADR-0063、ADR-0064 中仅适用于企业式发布资格的部分

## 背景

Kite Code 当前只有一位维护者，交付物是用户在 macOS、Linux 或 Windows 本机运行的 Bun
TUI/CLI。项目不是多租户 SaaS、托管执行服务或企业发布平台。旧生产路线图把供应链认证、独立
authority、外部 cohort 和长期 maturity 观察作为首发前置，维护成本与实际风险模型不匹配，并会让
已经可本地验证的安全边界长期无法形成普通开源候选版本。

## 决策

首个开源版本只使用两个必要 Gate：

- `G0` 本地正确性与安全：核心测试通过；secret、Workspace、network、MCP write 与 destructive
  effect 保持 fail closed；无已知 P0/P1；安装、卸载和回滚基本流程可用。
- `G1` 普通发布验证：GitHub-hosted macOS、Ubuntu、Windows 构建通过；制品可安装并启动；
  TUI/CLI smoke 通过；DeepSeek `deepseek-v4-flash` 和阿里千问 OpenAI-compatible route 各完成
  一次低成本真实调用；release notes 与已知限制准确。

发布前只使用一份普通维护者检查清单。维护者可以在同一 PR 中实现、复核和批准候选版本，不要求
伪造 backup、独立 Release/Security 身份或多轮签署。

下列事项不阻塞首发，并且没有取得时不得表述为已经通过：第三方安全评审、Sigstore/OIDC authority
registry、SLSA/provenance、macOS Developer ID/notarization、Windows Authenticode、企业 SBOM
attestation、外部 cohort 人数、长期 canary/SLO/maturity 窗口、candidate-bound 密码学评审 artifact、
production evaluator signing authority 和独立人工签署。它们按实际价值保留为可选发布后工作，或由
本 ADR 明确取代。

首发 artifact 是无平台签名的普通开源候选包。manifest 与 SHA-256 checksum 只证明下载内容完整，
不冒充来源认证。GitHub Actions 只需要 `contents: read`；创建正式 GitHub Release、发布 npm 包或
其他不可逆公开发布仍需维护者单独授权。

Capability 的 embedded ceiling 与运行时安全边界不因发布流程简化而放宽：未知 external effect、
Workspace 越界、MCP write、destructive 操作、secret 外发和 Verification false pass 继续 fail closed。
Compaction、Verification、MCP write 与 Skills 只要求首发本地 conformance；可选能力默认关闭并由用户
显式开启。Auto Compaction 不进入首版默认能力。

108 个历史 Task 由 `release/oss-first-release/task-status-v1.json` 重新分类。旧 execution binding、
milestone 和 completion record 保留为历史事实，但不再是首发状态的权威来源。

## 备选方案

1. 继续完成 Sigstore、attestation、独立 evaluator 与长期 cohort 后再发布。拒绝：与单维护者本地工具
   的首发风险不成比例。
2. 删除所有旧控制面。拒绝：其中的 fail-closed schema、verifier 和 adversarial contract 仍有本地
   安全价值，且可供发布后选择性使用。
3. 把缺失外部证据登记为通过。拒绝：这会破坏项目的证据语义。

## 影响

- 首发可以由本地验证与普通三平台 CI 真实完成。
- 未签名候选包会在已知限制中明确披露；checksum 不是代码签名。
- 外部 canary、maturity、认证和托管形态不再阻塞，但也不获得支持声明。
- 旧计划中的企业式 Gate 仍可作为研究资产，不得重新进入首发必需集，除非新增 ADR。

## 回滚

如果项目新增维护者、托管服务或企业发行需求，新增 ADR 定义新的威胁模型和 Gate；不得改写本 ADR
或把旧的未完成证据追认为已经通过。候选版本回滚使用本地安装器保存的上一版本，不依赖远程控制面。
