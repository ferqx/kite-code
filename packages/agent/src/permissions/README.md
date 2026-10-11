# 权限策略与 Shell 授权

本模块拥有 Kite 的三策略规则与 Shell 命令分析，公开入口为 `@kite-ai/agent/permissions` 和 `@kite-ai/agent/permissions/shell`。Service 读取可信宿主事实并装配这些工厂；HTTP、客户端和配置正文不产生权限。用户合同归[工具和授权](../../../../docs/handbook/features/tools-and-approvals.md)，本次边界及证据归[实施进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。

[index.ts](index.ts) 的 `createPermissionPolicy` 接收 `readPolicy/describeCapability/readReviewContext?`，按请求批准、自动审核、完全访问返回通用 `PermissionDecision`。当前模式、工作区信任、真实能力、控制 revision 与准确命令身份共同参与摘要。硬拒绝先于模式；旧 raw `ask` 拒绝。import 和工厂创建不读取宿主资源，真正审核、人工决定、原接纳与派发复核继续由 [Execution](../execution/interactions.ts) 与 Store 执行。

[capabilities.ts](capabilities.ts) 的 `builtinCapability` 统一实际 Tool、Job 与 Action 的固定效果和 safeRead；权限装配与 `workflowCapabilityDescription` 使用同一份分类，Shell 工厂也复用原 Shell 分类。Workflow 的 Job 三维 unknown、最低人工审批和未知 Files 的保守 write 投影保持，不能据此给执行策略补写入授权。MCP source/auth 分类只接收宿主原三个已注册定义 ID；Service 仍提供实际注册、选中 server、transport 可用性和网络配置事实。[constraints.ts](constraints.ts) 组合当前策略与原计划约束、Workflow 最低人工审批、明确文件恢复审批。宿主提供已校验的原状态和身份，约束不能放宽硬拒绝或改变原授权范围。既有 reason、revision/快照格式、单次与同命令授权、取消/恢复语义保持。

[shell.ts](shell.ts) 的 `createShellConfiguration` 接收 Workspace、选中工具及可信平台路径/环境，检查原资产后装配普通 Shell Tool/Job。输入请求与实际授权分开；`hostExecutionScope` 只读取最终已接纳证明，逐维求父子文件系统和网络交集。命令摘要绑定原命令、范围、环境、配置和执行/解析资产，真正启动前重核资产与硬拒绝；原 8192 proof 上限及失败关闭保持。Service 不保留策略或范围解释副本。

Shell 工厂通过本包既有 `@kite-ai/agent/jobs/shell` 与 `/shell` 公共入口装配，保留 Job 的独立构建和资产位置。这里用包内相对导入会使 Bun splitting 将 supervisor 定位函数提升到根共享 chunk，破坏基于 `import.meta.url` 的原相对路径；真实源码树外制品测试已证此失败。保留 public entry，而非增加资产回退或放宽校验。

[shell-command-policy.ts](shell-command-policy.ts) 使用本包固定 `tree-sitter-bash 0.25.1` 与 `web-tree-sitter 0.25.10` WASM。有限字面量 AST 与危险扫描分开，保原 cwd 分支预算与资产完整性校验；动态或不透明命令不取得安全证明，由实际系统范围约束，越界失败不自动扩权重跑。两个公开 entry 均进入本包 build；正式制品按 Agent manifest 复制完整解析依赖。

[原策略测试](../../test/isolated/permissions/policy.test.ts)、[独立解析与资产篡改测试](../../test/isolated/permissions/shell-command-policy.test.ts)、[独立范围测试](../../test/isolated/permissions/shell-scoped-permissions.test.ts)从原 Service owner 迁入，原用例及断言保持；策略测试另通过真实 Core 核同名扩展不能借只读权限、Workflow Job 不降格。实际 macOS [Service Shell](../../../../apps/service/test/isolated/shell-configuration.test.ts)和[网络审批](../../../../apps/service/test/isolated/web-permissions.test.ts)继续验证正式调用链。边界检查沿公开导出和 barrel 拒绝本模块反向依赖 Service、Service 直接解析依赖或重新实现原工厂。

Linux/Windows 真实执行依用户安排后置，Windows 正式 Shell 后端仍缺失；RSS 真实超限、完整 Runtime 观测缺项及 V1.3 阶段退出门禁保留。源码迁移和本机通过不改变这些资格。
