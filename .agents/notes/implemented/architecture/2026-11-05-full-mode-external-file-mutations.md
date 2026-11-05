# Agent Note: Full 模式统一文件工具的外部修改范围

Status: implemented

## Problem

用户在真实模型测试中观察到 Full 模式写入工作区外目标仍被拒绝，并明确要求 Full 不再因 Files 固定工作区范围拒绝普通外部写入。此前的[工具退役决定](2026-11-02-tool-surface-retirement.md)将外部修改交给 Shell，统一文件工具只有外部只读能力；因此同一 Full 用户意图会因模型选用 `write_file` 还是 Shell 而得到不同结果。直接修改底层 Workspace 根约束又会影响检查点、恢复和原有文件身份校验，不能仅删除路径检查解决。

## Decision

默认 Service 通过 [withFullAccessFiles](../../../../packages/agent/src/tools/full-access-files.ts) 为现有 `read_file/write_file/edit_file` 增加最终有效 Full 下的外部绝对路径分支，不增加工具名称、版本、执行器或身份系统。适配器位于普通外部 reader 之上、input/plan/output 准确私有引用适配器之下；[Service 装配](../../../../apps/service/src/file-checkpoint-configuration.ts)动态提供原 Profile、数据根、协调路径与实际 Runtime 资产保护范围。

外部修改预检读取新鲜可信策略；只有 Full 给出允许的能力描述。执行前检查已接纳派发证明的每个 `builtin.permissions` 叶，核 Full、信任、原工具定义／版本和准确目标 revision。父子权限交集、Planning、工具集合与派发前策略复查保持原 owner 负责。请求批准和 Auto 不因这条适配器取得新的外部修改范围，也不为不支持范围创建无效审批。

外部文件仍交给原 native 引擎：选择准确目标的最近已存在父锚点，保留 no-follow，绑定请求路径、实际路径和原父对象／目标身份，最终打开后再次核对已接纳绑定。新建使用原 `base:null` 创建路径及缺失父目录处理；覆盖与编辑使用完整 baseline 和原 CAS。OS 可写共享父目录不新增父目录 owner 要求，目标对象和新建目录的原 native 检查不放宽。底层 `WorkspaceFiles.relativePath` 继续只解释工厂固定根，不接管外部范围。

Full 对可安全编辑的外部普通文件使用 native read，返回真实完整 baseline；行窗口只决定正文选区。原普通 reader 可读但 native mutation 不支持的符号链接、硬链接或 owner 不匹配目标保留原只读读取，不给可编辑基线。保护路径拒绝不能回退到普通 reader 或 writer；其他审批模式的原外部读取行为保持，不加载外部项目指令。

每次成功外部修改沿原文件工具保留完整 postimage Artifact 与逐操作 `fileChange`，结果路径是准确绝对路径；外部文件标记 `workspaceCheckpoint:false`，不加入 Workspace 检查点或恢复写回范围。取消、发布后失败、结果保存失败和 close 故障继续沿原未知效果约束：已发生但不能确认的操作保留 `outcome_unknown` 及原原因，不能为取得结果重放。

本决定只替代旧退役 Note 中“外部修改必须使用 Shell”和“外部读取一律没有基线”的 Full 部分。旧专用工具、Workflow、检索及验证工具退役，历史格式识别和不重放约束继续有效。

## Alternatives considered

- 继续要求外部修改走 Shell：维持此前实现最省代码，但不能满足用户明确要求；模型已持有 Files 工具时仍会遇到与 Full 意图不一致的拒绝，也失去原文件编辑基线与逐操作回执。
- 放宽 `WorkspaceFiles.relativePath` 或把整个文件系统作为 Workspace 根：会把外部访问混入 Workspace IO、capture 与恢复作用域，削弱工厂固定根所表达的职责，影响现有调用者。采用独立外部适配器复用 native 原语，保留底层合同。
- 为外部文件建立新工具或执行管理器：重复现有模型入口、审批、Artifact 和 unknown 路径，并重新引入已经退役的专用外部工具能力。现有文件工具与私有引用适配器模式足以承载这次范围调整，不采用。
- 为 Full 外部读取全部强制 native 可编辑条件：会缩窄此前已支持的普通符号链接／硬链接等外部读取；保留普通 reader 作为只读兼容路径，且不为这些结果伪造基线。

## Consequences

Full 模式可自然选择统一文件工具完成普通外部创建与编辑，保留参数、执行记录、基线和 Artifact 的原职责。取得 Full 并不解除保护资源、父子限制、工具集合、OS 权限和 native 对不安全对象的约束。外部历史快照可以用于查看与交付，但不意味着 Workspace 检查点能恢复外部文件。

适配器需要按目标临时打开 native owner，并在预检与派发打开后核对同一绑定。这减少父目录替换取得新资格的窗口，不宣称对非合作外部 writer 提供文件系统事务：最终基线核对与 rename 之间的任意外部编辑／移动仍受原 native CAS 限制。

当前实现与接口说明归 [Files owner](../../../../packages/agent/src/tools/files/README.md)，产品承诺归[工具与审批手册](../../../../docs/handbook/features/tools-and-approvals.md)，本记录保留范围调整的原因和代价。

## Verification

2026-11-05，macOS ARM64／Bun1.4.2，当前任务未提交改动：[native owner 回归](../../../../packages/agent/test/isolated/files/full-access-files.test.ts)13项75断言通过，覆盖外部读写／编辑及完整基线、缺失父目录、共享父目录、每层 Full 证明、参数与目标 revision、保护路径、链接只读兼容、过期基线、父目录换根、取消、原 Workspace capture、Artifact 发布与 close 双故障仍保留 unknown。

[Service 回归](../../../../apps/service/test/isolated/full-external-files.test.ts)与[原生资产保护](../../../../apps/service/test/isolated/files-native-boundary.test.ts)同次9项82断言通过，核默认装配的完整读改写与不可变 Artifact、无外部检查点、请求批准／Auto 零效果拒绝、Profile／Runtime 资产保护、派发前降权／信任变化，以及 code／explore 子 Agent 工具边界。Agent typecheck 与变更 TS 的 Biome 通过。

上述是确定性真实文件与 Runtime 回归，不证明真实模型稳定完成任务，也不取得 Windows／Linux 或正式安装制品运行资格。真实模型结果由原测试与当前负责文档据实际轨迹记录，不以这些参数和权限回归替代。
