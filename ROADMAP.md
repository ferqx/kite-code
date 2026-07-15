# Kite Code 路线图

最后更新：2026-07-15

## 已完成基础

- protocol/core/app 分层与 Runtime Kernel 切换；
- LangGraph/LangChain 运行时依赖移除，模型迁移到 AI SDK；
- Plan Artifact、interaction mode、authorization、approval 与 sandbox；
- MCP revisioned catalog、turn binding、执行记录与恢复；
- Skill Workflow Contract、Activation、Capability Ceiling 与 fork；
- 分级 Verification、repair/replan/waiver/compensation；
- Capability progressive disclosure；
- Runtime Event Store、Snapshot、多会话与 PTY 测试体系。

## 当前维护重点

1. 保持 active/book/root 文档与源码一致；
2. 扩展 golden/replay 和跨平台执行验证；
3. 提升 TUI 稳定性与 session 恢复体验；
4. 收敛 feature flags，在稳定后移除迁移开关；
5. 强化 MCP/Skill 真实边界测试和可观测性。

## 候选方向

- 后台 Subagent 与更细粒度并发调度；
- Web Search（当前已有 Web Fetch）；
- 可选 OpenTelemetry 导出；
- 自定义 Subagent、Hooks 与更多 Artifact 展示；
- 显式、隔离、非默认发现的真实 provider 测试。

候选方向不构成已实现能力或承诺。实施状态以 [`docs/space/plans/index.md`](docs/space/plans/index.md) 为索引，以源码、测试和 `docs/active/` 为当前事实。
