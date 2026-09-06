# MCP、Skills、Subagent 与验证

这些能力由 Builtin 提供语义，Service 注入外部依赖，Kernel/Host 决定治理与生命周期。共享入口是[Runtime module 注册](../src/index.ts)与[SPI registry](../../runtime-spi/src/registry.ts)。

## MCP

[manager](../src/mcp/) 维护实际 Server 能力，配置和认证由 Service control plane 拥有。发现/搜索、绑定、执行和结果验证是不同阶段；catalog 出现工具不代表已获授权。revision 改变时旧 binding 不能静默适配新声明，read-after-write 必须检查同一能力版本。

## Skills

[catalog](../src/skills/catalog.ts) 发现可用指导，[workflow](../src/skills/workflow.ts) 编译工作流，[activation](../src/skills/activation.ts) 处理激活。能力开关、effect 和输入 contract 仍须满足；不能仅凭 Skill 文件存在启动任意工作。仓库文档同步 skill 的执行规则属于开发流程，不改变产品 Skill Runtime。

## Subagent

[role 与 context](../src/subagent/)、[runtime module](../src/subagent/runtime-module.ts) 将 task、角色上限和明确输入交给 child driver。独立 step/tool identity 保持 live 与 replay 对应；审批挂起记录来自已解析工具参数，恢复不重建另一份未经验证的 invocation。并发子任务不共享不受约束的 mutable caller state。

## Verification

[deterministic executor](../src/verification/deterministic-executor.ts) 使用文件、命令、schema、MCP 或 receipt/Artifact 等证据，缺失或无法验证的结果明确 inconclusive。Kernel 决定 required、完成、repair/waive/compensation，Builtin 不自行宣布任务完成。

验证：[MCP callbacks](../test/mcp-tool-pipeline-callbacks.test.ts)、[Skill workflow](../test/skills/workflow.test.ts)、[Subagent context](../test/subagent-model-context.test.ts)、[Subagent operations](../test/subagent-operations.test.ts)。跨包规则见[验证](../../../docs/active/verification-governance.md)与[MCP 治理](../../../docs/active/mcp-runtime-governance.md)。
