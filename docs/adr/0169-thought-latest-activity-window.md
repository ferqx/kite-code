# ADR-0169：Thought 使用单一最新活动窗口

**Status**: accepted
**Date**: 2026-09-03
**Decision makers**: @chenchao
**Supersedes**: ADR-0030 关于 confirmed captions 永久可见的展示结论、ADR-0167 关于 active reasoning 正文不可见的结论

## Context

一个只读探索阶段会在多次模型调用间交替产生 reasoning、exploration tool 和带工具响应的普通文本。Reducer 已用同一个
`tool_summary`及`latestActivity`保存这个阶段，但 renderer 隐藏了`latestActivity=thinking`的正文，同时把每次带工具响应的
文本累计为`captions[]`并永久显示。长探索因此变成“一个聚合标题 + 多条先看/继续看旁白 + 工具步骤”，与阶段的实时活动
模型相反：真正的最新思考不可见，已经过去的过程旁白却不断增长并进入历史。

## Decision

1. 一个连续只读探索阶段始终使用同一个`tool_summary`。`model.requested`、当前工具全部terminal都不关闭该阶段。
2. active Thought只有一个有界活动窗口：
   - reasoning streaming只更新request缓存；completed后设置`latestActivity=thinking`并原子显示最新完整reasoning；
   - exploration tool started/progress/terminal设置`latestActivity=tool`，窗口切换为最近工具步骤；
   - 后续completed reasoning再次替换工具窗口。
3. 活动窗口正文最多显示五行。reasoning先按终端宽度软换行，超出预算时保留前五行并另加一行省略标记。
4. 带工具响应的普通文本仍通过`pendingCaption/captions`完成最终正文与探索旁白的归属、累计流去重，但不渲染，也不进入
   settled Thought历史。
5. standalone工具、人机交互、最终正文、retry/error/cancel或Turn/Run terminal关闭阶段。关闭后reasoning窗口和工具明细
   消失，只保留聚合标题；随后按ADR-0168的封口、terminal协调和整体result条件进入Static。
6. live与replay使用同一renderer。恢复历史不得重新显示活动reasoning或工具旁白。

## Alternatives

- 永久累计captions：拒绝；历史长度随模型调用次数增长，且把过程旁白误当成最终消息。
- 同时显示reasoning和工具列表：拒绝；活动区失去“当前正在做什么”的单一焦点，并重复已经汇总在题头中的历史。
- reasoning delta逐字符显示：拒绝；会放大终端重排和provider累计流重复，completed边界已足以提供稳定活动内容。
- 删除`pendingCaption/captions`状态：延期；它们仍参与工具响应文本的request归属、累计流去重和最终正文脱离，不属于本次
  展示修复范围。

## Consequences

- 用户会按时间看到`reasoning → tools → reasoning`在同一聚合块下交替，而不是看到累计旁白列表。
- 聚合题头的模型时长和工具统计继续跨调用累加；活动窗口切换不创建新block。
- Thought进入Static后只有紧凑标题，不包含reasoning、工具步骤或过程旁白。

## Rollback

恢复`ToolSummaryBlock`对captions的Markdown渲染并隐藏`latestActivity=thinking`正文，同时恢复对应布局和PTY断言。
