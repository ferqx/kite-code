# ADR-0163：探索展示分类只由Service投影

状态：accepted

日期：2026-09-01

决策者：用户直接指令

相关：ADR-0030、ADR-0041、`docs/active/thought-pre-consolidation.md`

## 背景

TUI历史实现通过`intent=inspect`与`ls|rg|grep|find`等command前缀识别Shell探索调用，同时Service已经能够消费
Runtime签发的`effectClass`与`sideEffect`，并在client-safe `tool.queued`中投影closed `presentation`。两套分类会在
新增只读语义、回放缺项或命令组合变化时漂移；TUI规则虽不产生执行授权，仍会影响Static冻结和视觉阶段边界。

## 决策

1. Service projector是唯一探索展示分类owner。Builtin读取固定为exploration；Shell只有可信Runtime事实为
   `effectClass=read_only + sideEffect=false`时才投影为exploration，否则为standalone。
2. TUI只消费`tool.queued.presentation`并按call ID更新生命周期，不解析command、模型`intent`或程序名前缀。
3. exploration调用直接物化为`tool_summary`，standalone调用直接物化为`tool_card`。因此终态`tool_card`无需再次判断
   工具类别即可进入Static。
4. 删除无生产调用的历史block扫描/重聚合函数与Shell前缀表；`consolidateTools.ts`只保留统计文案生成。
5. terminal缺少queued事实时继续fail closed：不得从工具名、终态或空参数推导Shell exploration。

## 后果

- 新增只读Shell语义只需更新Builtin registry；Service与TUI不会维护重复命令表。
- live与history replay共用同一client-safe presentation事实。
- 本决策取代ADR-0041的TUI command grammar；其“复合Shell不能仅凭`ls`前缀归为探索”的安全目标由Runtime分类器承担。

## 回滚

若Service无法提供可信presentation，应修复投影或保留standalone，不能恢复TUI命令文本推断。
