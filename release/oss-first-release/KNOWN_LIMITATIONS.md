# Kite Code 首个开源候选版本已知限制

- 候选包只有 SHA-256 完整性校验，没有 Sigstore/SLSA provenance、macOS Developer ID/notarization、Windows Authenticode 或企业 SBOM attestation。
- 首发预构建候选只覆盖 macOS arm64、Linux x64 与 Windows x64；其他架构需要从源码通过 Bun 运行。
- macOS、Linux、Windows 的 TUI/CLI 可发行性不代表 effectful execution capability 已准入；缺少强本机隔离时 Shell、writer、MCP write 或 effectful Skill 保持关闭。
- MCP write 的生产 route registry 为空；未知 external effect 只能 reconciliation，不能盲重放。
- Remote telemetry 默认关闭；项目不规划 external cohort、长期服务等级/error-budget、分阶段 promotion 或托管 observability 服务。
- 预构建 standalone candidate 不封装 `@napi-rs/keyring` 的 N-API binding，持久 MCP 凭据库固定 fail closed；从源码通过 Bun 运行仍使用系统 keyring。首发不会回退到文件或明文 credential 存储。
- Auto Compaction 默认关闭，不属于首版默认能力；Manual Compaction 保留。
- 第三方安全评审、独立 Release/Security 人员与 production evaluator authority 未取得，也不作为已经取得的证据展示。
- 首发只支持单个本地 OS 用户、单个已信任 Workspace、前台 TUI 与前台 Headless CLI；不支持 Web、多租户 SaaS、托管 runner、服务端 credential custody 或无人值守共享 writer。
