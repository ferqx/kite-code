# Agent Note: 统一 Shell 启动与运行时执行身份

Status: implemented

## Problem

前台与后台分别暴露启动工具，模型需要生成 key、选择取消关系，并填写嵌套权限。调用表面增加了与业务命令无关的决策，也容易把恢复原结果误写成再次执行。用途描述需要进入展示，但不能改变命令授权或成为风险依据。

## Decision

新模型只提供 shell_execute/read/wait/stop。execute 默认前台，background:true 返回同一原 Job 的句柄与受理状态；前后台共用原 operations.ensure 和引用保存。前台期限与后台互斥，在 Schema 和启动前校验中一致拒绝。

模型输入移除 key/cancellation。省略内部 key 时从已持久化的 Tool execution ID 确定性派生，不用命令文本去重、不在恢复时随机生成。新 Tool 调用即使命令相同也有独立执行，普通前后台沿 attached 取消关系。原结果只通过返回的 shell_id 读取、等待和停止。

顶层 filesystem/network 由共享纯输入解析转换为原 Job 的 permissions 合同，两个维度独立。description 只供原展示链路使用，不进入 Job、命令语义摘要或 Shell 风险模型输入；完整原 Tool 调用与完整性绑定保持。请求值不充当最终授权，现有审批、父子交集、受保护资源、批准复用及超时规则不变。

内部保留旧 shell.launch、显式 key、permissions、cancellation 和 timeoutMs。新目录用现有 hidden/omitParameters 投影，不改工具版本；历史投影继续使用原 descriptor。后台只读目录增加可选来源 background:true，取自同一来源范围的准确父 Tool 原输入，不输出正文或改变取消权。

## Alternatives considered

- 继续要求模型生成 key：用户已明确要求运行时管理身份，且已有持久化 Tool ID 可复用。
- 每次随机生成 key 或按命令去重：分别可能造成恢复重放，或把两次明确的新调用错误合并。
- 新建启动管理器或嵌套调用旧 Tool：会增加第二条审批与执行路径，现有 operations.ensure 已满足需求。
- 删除旧注册和旧输入：会破坏原引用与历史解释；保留内部合同并收窄新模型表面即可。

## Consequences

新参数更少，真实执行和授权仍沿原链路。旧引用冷读、同一 Tool 重入和不同新调用的回归由[统一入口测试](../../../../packages/agent/test/isolated/tools/shell/unified-entry.test.ts)覆盖；权限与语义摘要由[扁平权限回归](../../../../packages/agent/test/isolated/permissions/shell-flat-input.test.ts)覆盖。

历史冷读不等于任意旧活动 Run 的自动恢复资格；原配置、来源与未知效果约束继续生效。受控模型和参数回归不证明真实模型稳定完成复杂任务，也不取得未执行平台或安装制品资格。当前合同归[Shell owner](../../../../packages/agent/src/tools/shell.README.md)。
