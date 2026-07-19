# Kite Code 产品定义

## 定位

Kite Code 是一个开源、多模型、跨平台的终端代码 Agent，面向需要可审计执行、明确授权和可靠恢复的开发者。

## 产品承诺

1. **模型可替换**：Core 不绑定单一 provider。
2. **执行可控**：能力发现、授权、审批和 sandbox 相互独立。
3. **过程可恢复**：事件、快照、调用意图和回执持久化。
4. **完成可验证**：高风险任务以 Evidence 和 Verification 验收。
5. **扩展可治理**：MCP、Skill 与 Subagent 进入同一 Capability/Policy 边界。
6. **前端一致**：TUI 与 CLI 共享同一个 Runtime Kernel。

## 当前产品能力

| 领域 | 能力 |
| --- | --- |
| 交互 | TUI、CLI、多轮会话、计划审核、审批与 ask-user |
| 模型 | DeepSeek、OpenAI、OpenAI-compatible、Ollama 配置 |
| 执行 | 文件、搜索、Shell、Web Fetch、MCP、Skill Workflow、Subagent |
| 安全 | interaction mode、authorization、effect classification、auto review、sandbox |
| 数据 | Runtime Event Store、Snapshot、Artifact、Restore/Fork、Session Logger |
| 验收 | not-required/best-effort/required Verification、repair、replan、waiver、compensation |

工具和事件集合会随 mode、feature flag、provider 与 catalog 动态变化，不以固定数量作为产品契约。

## 目标用户

- 在终端中完成代码理解、修改、验证与计划工作的开发者；
- 需要自托管或自选模型的团队；
- 需要工具审批、外部写入治理和审计证据的组织。

## 非目标

- 托管 SaaS、移动端或自动 PR 评论机器人；
- 用 Capability Catalog 取代 OS sandbox；
- 对任意第三方 MCP 承诺通用 exactly-once；
- 让 Skill、模型或远端 provider 自行扩大用户权限。

## 当前架构原则

产品行为由 `Agent → Capability → Policy → Execution → Verification` 流水线完成，Runtime Kernel 是唯一事实中心。详细规则见 [`docs/active/six-concept-runtime-architecture.md`](docs/active/six-concept-runtime-architecture.md)。

历史路线、竞品调研和未实施设想只保存在 `docs/space/`，不得作为当前产品能力声明。当前缺口必须以源码、测试和显式 backlog 为准。
