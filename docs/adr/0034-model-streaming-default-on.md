# ADR-0034: 模型流式响应默认开启

**Status**: accepted
**Date**: 2026-07-26
**Decision makers**: @chenchao

## Context

ADR-0031 将缺失的 streaming 能力保守解析为 `false`。这使历史配置和手写配置即使使用支持 AI SDK `doStream` 的内置 Provider adapter，也会静默走 `generateText`；只有额外配置 `streaming: true` 才能得到 TUI 的实时输出。该配置负担与 TUI 默认应提供流式反馈的产品行为不符。

## Decision

1. 正常 Agent 模型调用的 `ResolvedModelCapabilities.streaming` 缺省为 `true`。
2. 用户不需要配置 streaming。模型条目、adapter metadata 或兼容 `modelKwargs` 中显式的 `streaming: false` 仍可关闭流式并回退 `generateText`。
3. TUI Setup Wizard 不写入冗余的 `streaming: true`。
4. summary、reviewer 等内部模型调用仍不使用 TUI streaming 路径。

该决定取代 ADR-0031 中“streaming 缺失时默认 false”的回退条款。

## Consequences

- 历史和新建配置在未声明 streaming 时立即获得实时文本与 reasoning。
- 不支持流式协议的自定义 Provider 必须显式设置 `streaming: false`。
- streaming 的显式配置与 adapter metadata 优先级保持不变；默认值不伪造 capability source。

## Verification

- capability 测试验证缺失 streaming 时解析为 `true` 且没有 source。
- 显式 `false` 的优先级测试继续验证 `generateText` 回退能力。
- TUI PTY streaming 与断线重连场景继续覆盖默认流式管线。
