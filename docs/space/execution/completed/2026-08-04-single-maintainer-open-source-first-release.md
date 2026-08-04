# 单维护者开源首发路线图完成记录

状态：completed
日期：2026-08-04
关联计划：[`2026-07-29-agent-production-readiness-roadmap.md`](../../plans/2026-07-29-agent-production-readiness-roadmap.md)
关联决策：ADR-0068、ADR-0069
关联 PR：[ferqx/kite-code#31](https://github.com/ferqx/kite-code/pull/31)

## 结论

路线图原范围已完成，108 个历史 Task 终态为 83 completed / 25 superseded / 0 optional，
不存在 pending 或 in-progress Task。G0/G1、统一 Review、文档门禁、真实 Provider 与
三平台候选验证全部收口。

公开 GitHub Release、tag、npm publish、签名、notarization 和 attestation 从不属于该路线图
的完成条件，本记录不宣称已执行这些动作。

## Review 收口

- P0：0。
- P1：2 项全部修复；候选制品绑定精确 PR head，安装后 standalone TUI 通过真实 PTY startup。
- P2：路线图索引、Qwen 精确路由、DeepSeek thinking 预算、managed tree 验证、发布说明和
  归档可复现性等问题全部修复并由回归测试锁定。

## 本地验证

- 默认 suite：2891 pass、6 skip、0 fail；5 个 process-isolated 文件全部通过。
- Runtime fault：33 pass、0 fail；soak：7/7 scenario 通过且 cleanup confirmed。
- TUI system：38 个独立 PTY scenario 文件通过。
- typecheck、format、lint、core boundary、docs impact、docs governance 和 `git diff --check` 全部以 0 退出。
- DeepSeek `deepseek-v4-flash`：607 ms，10 input / 4 output / 14 total tokens，正文非空。
- Qwen `qwen3.6-flash`：1249 ms，16 input / 209 output / 225 total tokens，正文非空。
- 两条 Provider runner 都保持 `contentLogged=false`，未输出 credential 或 response 正文。

## GitHub-hosted 证据

- Required workflow [30915426607](https://github.com/ferqx/kite-code/actions/runs/30915426607)：成功。
- Candidate workflow [30915426783](https://github.com/ferqx/kite-code/actions/runs/30915426783)：成功。
- PR checks：21 pass、0 fail、1 个无 secret 的 live-provider job 按预期 skipped。
- macOS arm64：candidate `26a56586a1ffe8f3f9979288`，SHA-256
  `3d5d5290ceb9738f24b976c23460fe9c5558001bfe9e4f968ff7a157e2cbc511`。
- Linux x64：candidate `ec747d597d5dda815c33d8f0`，SHA-256
  `88841a7080414ade49abb5e64a336a71966d2b8c743e6ae5263d98f37e1cfe6c`。
- Windows x64：candidate `168f315eca4c125d64479a36`，SHA-256
  `02d10d891d04217cb202e942a5b05dc8fd932bf904fc6724a5a81a554d227b68`。
- 三个 artifact 均绑定 `bcc488d77c04513f646e05715744d5c7a559c8a9`，`sourceDirty=false`，
  sidecar、manifest、target 和 payload checksum 独立复核通过。

## 交付边界

- 首发预构建平台为 macOS arm64、Linux x64 和 Windows x64。
- 候选包为 unsigned SHA-256 integrity artifact；Auto Compaction、effectful capability 和 remote telemetry
  默认关闭。
- standalone 候选中的持久 MCP credential storage 因 N-API keyring binding 未嵌入而 fail closed；
  源码 Bun 运行继续使用系统 keyring，不回退到明文或文件存储。
- 已记录并实测回滚命令：
  `bun run release:install -- rollback --prefix "$HOME/.local/share/kite-code"`。
