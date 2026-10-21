# Agent Note: 环境卡按原工具来源筛选后台 Shell

Status: implemented

## Problem

用户要求环境信息卡只显示后台 Shell，前台执行不应出现在这里。`shell.execute` 与 `shell.launch` 都创建 `shell.command` Job，仅按运行状态筛选会混入前台命令；取消是否随父任务结束也不能说明前后台。公开后台目录使用闭合响应，直接给默认响应增加字段会影响旧消费者。

## Decision

后台目录在原读取事务内核对 Job 的直接父 Tool 与同 Session、origin Store、root work，只在显式 `includeSourceTool:true` 时投影 `sourceTool` 的 ID、定义和版本。默认与 false 的响应保持原结构，不加入工具正文、结果、引用或授权材料。无 SQL 迁移，也不修改原操作意图。

Native 环境读取和准确停止复核显式请求该元数据，卡片只把父 ID 匹配、来源为 `shell.launch@1` 的 `shell.command` 作为后台 Shell，再沿既有运行／停止中筛选。前台 `shell.execute`、缺失来源或未知版本不补后台身份。子 Agent 展示与只读详情保持，Shell 原停止准入和自动更新保持。

## Alternatives considered

- 按 `running` 或 `detached` 筛选：前台命令同样是运行中的 Job，前后台都允许不同的取消关系，无法准确区分。
- Native 逐项额外读取父执行：会增加请求并脱离目录的一致快照，子会话来源还涉及不同的读取准入；现有父工具记录可以在原受控目录事务内完成投影。
- 给 Shell Job 输入加入新的前后台字段：需要改变原操作请求与重试意图，还要处理旧输入；已有持久父工具身份足以表达当前两种启动方式。
- 默认目录直接携带新字段：闭合旧消费者可能拒绝额外字段，因此采用显式读取选择。

## Consequences

来源未知的记录仍保留在原执行历史和后台目录中，但不会冒充后台 Shell 进入环境卡；查询不停止、重启或重放任何 Job。恢复后的原父工具身份可继续投影，读取来源不授予新的操作或子会话读取权。

[真实 SQLite／HTTP 及两次恢复测试](../../../../tests/isolated/unified-agent/background-directory.test.ts)核默认响应、原来源与零读取写入；[Native 测试](../../../../apps/desktop/test/native-background-panel.test.tsx)覆盖前后台、取消关系和来源缺失反例；[Client](../../../../packages/client/test/background-directory.test.ts)与[Browser](../../../../packages/client/test/browser-background.test.ts)核每页选择、身份绑定及额外正文拒绝。这些验证不代替实际 Shell 进程或安装版窗口的平台资格。
