# Kite Code 首发维护者检查清单

这是一份普通单维护者检查清单。它不要求另一身份、签名、第三方评审或独立审批。

## G0：本地正确性与安全

- [x] 定向测试、默认测试、Runtime fault/soak、TUI system、typecheck、format、lint、core boundary、docs 和 `git diff --check` 全部通过。
- [x] Workspace 越界、secret、network、MCP write、destructive/unknown effect 与 Verification false pass 继续 fail closed。
- [x] 没有已知 P0/P1；P2 已修复或在已知限制中记录处置。
- [x] `bun run release:build`、`bun run release:verify`、`bun run release:smoke` 通过。
- [x] 安装、启动、第二候选安装、rollback 和 uninstall 都由真实候选包完成。

## G1：普通发布验证

- [x] GitHub-hosted macOS、Ubuntu、Windows candidate jobs 全绿并上传 artifact。
- [x] CLI help/version、TUI version 与 PTY startup smoke 通过。
- [x] DeepSeek `deepseek-v4-flash` 一次低成本真实 smoke 通过。
- [x] 阿里千问 OpenAI-compatible route 一次低成本真实 smoke 通过。
- [x] `RELEASE_NOTES.md` 与 `KNOWN_LIMITATIONS.md` 和候选版本一致。
- [x] `task-status-v2.json` 保持 83 completed、25 superseded、0 optional，没有未决路线图 Task。
- [x] 候选包没有 credential、`.env`、日志正文或真实模型 response artifact。
- [x] 回滚命令与安装 prefix 已记录并实测。

## 发布动作

- [x] PR 只包含本次共同收敛的实现和文档。
- [x] CI 链接、candidate checksum、已知限制和回滚方式已交付。
- [x] 在获得单独授权前，没有创建 GitHub Release、发布 npm 包或执行其他不可逆公开发布。
