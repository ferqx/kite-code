# Kite Code 0.1.0 开源候选版本说明

这是面向单个本地用户的首个开源候选版本，提供 macOS、Linux 与 Windows 的 Bun standalone
`kite` CLI 和 `kite-tui`；首发预构建架构为 macOS arm64、Linux x64 与 Windows x64。候选包包含严格
manifest、逐文件 SHA-256、archive SHA-256 与维护者文档；仓库提供 managed install/upgrade/rollback/
uninstall 工具，并在三平台 GitHub-hosted smoke 中对真实候选包执行完整生命周期。

首发安全标准保留 Workspace、secret、network、MCP write、destructive/unknown effect 与 Verification
fail-closed 边界。Capability profile 只能收紧 embedded ceiling。MCP write、effectful Skills、remote
telemetry 和 Auto Compaction 默认关闭。

生产路线图已按 ADR-0069 收敛为终态：108 个历史 Task 中 83 个完成、25 个被取代、0 个 optional。
项目不保留 external cohort、长期服务等级/error-budget、分阶段 rollout/promotion 或 enterprise GA
后续资格路线；旧 verifier 仅作为 fail-closed 负向安全资产。

真实模型发布 smoke 覆盖 DeepSeek `deepseek-v4-flash` 与阿里千问 Token Plan
OpenAI-compatible route 的 `qwen3.6-flash`，各只运行一次低成本最小调用。credential 只从
环境变量或本机配置读取，不进入源码、日志或 artifact。

本候选没有代码签名、notarization、provenance 或 attestation；SHA-256 只用于完整性校验。完整限制见
`KNOWN_LIMITATIONS.md`。正式 GitHub Release 与 npm publish 不在候选 workflow 中执行。

预构建 standalone candidate 的 MCP 持久凭据库固定返回 unavailable；源码 Bun 模式继续使用系统
keyring。候选不提供文件或明文 credential fallback。
