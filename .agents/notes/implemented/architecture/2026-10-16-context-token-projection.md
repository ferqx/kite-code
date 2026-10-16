# Agent Note: 分离实际用量与下一请求上下文预测

Status: implemented

## Problem

累计消费、最近一次请求的实际输入、之后新增工具结果构成的下一请求大小是不同指标。仅显示原输入实测数不能决定下一请求何时压缩，有限 View 也不能证明整个会话累计消费。用户确认需要统一覆盖已知和未知提供商，保留测试与文档。

## Decision

以可核实的原请求实际输入为基线，对新增消息做有界通用估算；路由、工具和原内容不能核实时全量回退。只加本次实际将采用的新增消息估算，不把报告输出和隐藏推理盲目加入输入。Core 与 Service 共用纯投影，完整累计从原 Store／Session 的 usage 叶子读取，缺失给出覆盖数。TUI 保留三个不同指标，预测不改写实际统计。当前契约由[负责文档](../../../../packages/agent/src/context-estimate.README.md)维护。

源码研究核对 [Codex](https://github.com/openai/codex/blob/4eb4a65407d98cebc4c83bf13be440b9fbc78a7c/codex-rs/core/src/context_manager/history.rs#L924-L955) 与 [OpenCode](https://github.com/anomalyco/opencode/blob/ed772f5009755b5262805a7ba07e66e1417f140a/packages/core/src/session/compaction.ts#L874-L903) 的实测与增量分层，仅借鉴机制，不直接采用其 token 字段合计口径或未知窗口策略。

## Alternatives considered

- 每家提供商加载词表：词表与服务端模板未必匹配，也不能覆盖未知模型。本次保留可替换的 cl100k 通用回退。
- 给全文估算乘历史比例：来源、语言与工具结果可能完全变化，无法保持测量与估算的可解释边界。
- 直接沿用上一请求输入或加上所有报告输出：不能反映新增材料，输出可能含不被再次发送的推理和中断内容。
- 在显示读取时捕获实时来源或装配当前模型：会扩张只读资源和生命周期边界。显示只预测已保存来源布局，实际压缩在 Core 安全边界使用真正待发消息与工具。

## Consequences

无需新增 tokenizer 下载或 SQL migration；新增只读查询和 Worker 聚合方法。预测始终近似，后来来源、设置和未提交输入仍可改变实际请求；本地值不填入 usage。未知窗口仍沿现有维护阈值，不推定远端容量。基线读取需完整原请求，错误不授予派发许可。

本决定部分替代[此前用量决定](../bug-fix/2026-10-16-provider-token-accounting.md)中有限 View 累计范围；该决定关于原始 usage、失败／取消和最近准确请求的理由继续适用。[有限分块](../bug-fix/2026-10-15-context-estimate-bounded-tokenization.md)继续约束所有本地估算。
