# Agent Note: 长会话当前视图保留未结束工作

Status: implemented

## Problem

[执行手册](../../../../docs/handbook/features/execution.md)要求当前Run和后台工作使用原身份显示及控制。公共Store `getView`却取Session lifetime最早200个Run/Execution：真实205轮模型完成后，第206轮已经派发仍不在公共视图，Formal Desktop/TUI/Web的当前状态选择不能取得原工作。改取最后200项仍会隐藏更早创建、至今running的独立Job。完整已保存输出reader不能修复这种身份源遗漏。

## Decision

[Store owner](../../../../packages/agent/src/storage/README.md#当前会话视图)在现有只读事务内分别取同Session最近200个Run/Execution身份，再并入全部active Run与原`planned/dispatching/running/outcome_unknown` Execution。SQL UNION对rowid去重，最终按原rowid顺序返回，未结束工作不受历史200项门槛限制。Run/Execution本身、Session/Store和通知水位仍为原事实，消息首屏及公共DTO保持。

unknown即使另有核实证明，也不由展示查询重写；原取消、阻挡和恢复事务仍分别判定authority。这个投影不成为完整历史目录，旧记录继续通过准确ID读取，完整消息和保存输出沿各自分页合同。当前Native仍只有选中Session的执行源；跨会话后台总览需要完整公共目录及原身份的新鲜观察，不能从有限getView拼出完整资格。

## Alternatives considered

- 保持first200：实际原Run遗漏反例不满足当前工作行为，不能用消费者缓存掩盖。
- 只换为last200：真实更早live Job仍可能退出投影；未结束身份必须独立并入。
- 返回全部历史：每次当前状态读取都随累计历史增长；当前工作与完整历史已分别有职责，修复不要求建立无界历史响应。
- 在客户端重建Execution或以reconciliation证明改写unknown：产生第二份权威或扩大恢复许可，原Store选择即可保留真实状态。

## Consequences

[真实长会话测试](../../../../tests/isolated/unified-agent/active-view.test.ts)通过公开Runtime/HTTP/Client、实际SQLite与fixture Model adapter，先启动唯一真实detached Job，再完成205轮并保持第206轮派发。公开视图及实际便携Desktop controller同时保留当前Run/Model和原Job；旧Run仍可按ID读取。只读游标/ACK和模型206／Job1计数保持，准确取消当前Run后旧Job仍running，正常所属服务退出及自有profile清理完成。

较早unknown、冷恢复、真实Electron/PTY和三平台没有从这一有限fixture取得实际窗口资格。运行结果、独立审查、强制门禁、原完整默认和剩余阶段退出条件由[整体进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07长会话当前工作投影)维护。这个局部修复不声明完整历史分页、Native跨会话后台总览、默认可信Shell或V1.3整体完成。
