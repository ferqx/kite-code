# ADR-0093：首发真实 Provider smoke 迁移到 OpenCode Go

状态：accepted
日期：2026-08-09
决策者：github:@ferqx
取代：ADR-0068 中 G1 的阿里千问 OpenAI-compatible route 选择；不改变其余 G0/G1 结论

## 背景

ADR-0068 要求 G1 对 DeepSeek 和另一条 OpenAI-compatible route 各做一次低成本真实调用，原第二条
route 使用阿里千问 Token Plan。最终候选验证中该 Token Plan route 连续返回限流错误，不能形成可发布
证据。维护者决定将第二条真实模型路径改为 OpenCode Go，同时保留两条独立 credential/endpoint 路径、
metadata-only 输出和显式 opt-in 的原有边界。

OpenCode Go 官方为 `deepseek-v4-flash` 提供 OpenAI-compatible chat completions endpoint。仓库已有同一
provider 的本机配置，因此无需扩展 core provider 类型或引入 Anthropic adapter。

## 决策

G1 的第二条真实 Provider smoke 固定为：

- provider alias：`opencode-go`；
- provider type：`openai-compatible`；
- base URL：`https://opencode.ai/zen/go/v1`；
- model：`deepseek-v4-flash`；
- CI secret：`OPENCODE_API_KEY`，本机配置 provider 默认名为 `opencode_go`；
- 每次只调用一次，60 秒 deadline，128 output token 上限。

runner 必须精确校验 HTTPS、host、path、默认端口、无 userinfo/query/fragment 和固定 model，不能把
credential 发送到其他兼容 endpoint。OpenCode Go 的该模型会生成 reasoning token，因此使用 128-token
上限保证最小调用仍有非空正文；DeepSeek 官方 route 继续关闭 thinking 并保留 16-token 上限。

stdout、stderr 和报告继续只允许 provider/model/usage/耗时、credential source 与布尔状态，不记录
prompt、response、credential、完整 endpoint 或远端错误正文。真实调用失败或正文为空时 G1 保持未验证。

## 备选方案

1. 继续等待 Token Plan 限流恢复。拒绝：这会让首发依赖当前不可用的 route，且与维护者指定的订阅路径
   不一致。
2. 使用 OpenCode Go 的 Qwen 模型。拒绝：当前官方 Qwen endpoint 使用 Anthropic Messages adapter，
   会把一次发布 smoke 迁移扩大为 core provider 能力新增。
3. 接受任意 OpenAI-compatible endpoint 或可变模型。拒绝：这会使 secret 外发边界和候选证据 identity
   不稳定。

## 影响

- G1 仍包含 DeepSeek 官方 route 与第二条独立 OpenCode Go route，不以 mock 替代真实调用。
- release workflow 的第二个 secret 从 `DASHSCOPE_API_KEY` 改为 `OPENCODE_API_KEY`。
- 发布文档、维护者检查清单和测试命令统一使用 `--provider opencode-go`。
- 不修改 core provider 抽象、默认用户模型或 Prompt Contract V2 的产品开关。

## 回滚

若 OpenCode Go route 不再可用，G1 保持 blocked。后续必须新增 ADR 选择新的精确 provider/endpoint/model
并同步 runner、workflow、测试和当前文档；不得静默回退到任意 compatible route，也不得改写本 ADR 或
ADR-0068 的历史结论。
