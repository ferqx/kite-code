# Agent Note: 文件入口限制说明与任务交付核验

Status: implemented

后续部分调整见[普通文件缺失观察与工具反馈决定](2026-11-05-ordinary-missing-file-and-readable-tool-feedback.md)：普通缺失改为正常观察，模型使用英文解释并保失败子任务已有证据；原始回执、父子协作与权限决定不因此改变，不代表本文全部决定被替代。真实模型仍有内容核对和最终报告遗漏，不能将反馈机制修复写成任务稳定完成。

## Problem

真实任务中，Files 入口范围错误容易被解释成用户拒绝最终交付；旧错误指导还可能暗示路径校验失败已经创建目录。父子协作已有原结果、审批事实和同子续作能力，但委派会模糊准确要求，父读取文件后仍可能漏掉字段和原文差异。读取成功与正常结束不能证明业务完成。

## Decision

在原错误码、权限 gate 和回执中修正原因与恢复说明。父目录残留提示只来自真实创建过程；Full 外部失败使用范围中立的说明。[Full 文件范围决定](../architecture/2026-11-05-full-mode-external-file-mutations.md)及原发布未知约束不变。

仅准确内置 Files 注册／版本、可信 gate 原因 `file_full_access_required` 且明确未派发、未调用 adapter 时，说明当前 Files 入口不可用。它不是用户拒绝整个业务任务，也不是其他工具的批准；原任务、工具集合、既有拒绝、unknown 与独立审批继续约束新请求。其他权限原因不获得该说明，不修改授权映射。

替换现有协作及完成依据段，要求准确传递目标、字段、转换、一次性效果和 fallback 条件；对照实际交付和原任务比较，有可安全纠正的剩余工作才续作同一子 Agent。已有事实直接比较，缺少决定性证据才补读取。工具、Source 结构、读取范围、Loop 和正常停止条件不增加机制。

## Alternatives considered

- 泛化所有权限拒绝为可换工具重试：会误导模型绕过真实拒绝或重复未知效果，限定为准确入口原因并保留原约束。
- 通过改变权限映射解决反馈问题：会改变模式范围；保持原判定，修正原回执的含义。
- 新增证据字段、完成审核或自动 follow-up：最新父输入已有准确原文、错误交付和续作工具，没有缺证据的依据；采用定向重写现有指导，不引入重复机制。

## Consequences

回执更准确，父子模型获得具体比较与纠错指导；模型仍可能误解已送达的事实或提前结束，不能将受控回归当作真实模型稳定完成任务。无新增工具／协议版本、权限或 Agent 阶段定义。

实际实现和回归归 [Files owner](../../../../packages/agent/src/tools/files/README.md)、[权限 owner](../../../../packages/agent/src/permissions/README.md)和[协作 owner](../../../../packages/agent/src/extensions/task/README.md)。[受控交付回归](../../../../packages/agent/test/isolated/business/task/delivery-correction.test.ts)核同子续作、真实 baseline 修正及 GET 仅一次；[准确拒绝回执回归](../../../../packages/agent/test/isolated/execution/files-scope-feedback.test.ts)核下一模型、其他 owner／版本及伪异常边界。真实模型结果及未取得资格保持在[原测试记录](../../../../tests/e2e/live/model/README.md)，失败不覆盖。
