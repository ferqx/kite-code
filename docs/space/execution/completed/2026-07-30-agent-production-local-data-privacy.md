# Agent 生产化 Phase 1A Task 1A.1/1A.2/1A.3/1A.4/1A.5 完成记录

状态：completed
日期：2026-07-30
更新：2026-07-31（补充 Task 1A.3/1A.4）
计划：
[`2026-07-29-agent-production-local-data-privacy.md`](../../plans/2026-07-29-agent-production-local-data-privacy.md)
执行者：`github:@ferqx`
实现提交：
`1A.1=4b8eec058df0af545675fc0e1c4135ee855848fd`；
`1A.5=1e21055eb8b2579d710eb566728294f2ad8b2621`；
`1A.2/1A.5-hardening=d0bd571e6a937aac55850bcc09df6f41bf95ac99`；
`1A.3=2e1a2721b1c7e3c17a483a3d33bcd503a6a777ee`；
`1A.4=bb1a6c7049284723958ca42a417411fac1a76e62`；
`1A.4-hardening=302112e696d1dde1e31a1e652fef4b9e5a91c548,a935b2ea1b0dea5e51ea68062b8fdf77b948ccd9,a4bdf22aa7c2a987734524c278c4750e7b9faa96,1063e879933f3e1b0cf8c0958363c999bb2696ab`

## Task 1A.1

- 固化 `SessionLoggingPolicyV1`、`ProviderDataPolicyV1`、canonical route identity、
  `WorkspaceDataLabelV1` 和空的 D-14 approved bundle。
- `sessionLoggingPolicyV1`、`providerDataPolicyV1` 默认关闭；关闭时不恢复未治理正文日志或
  Provider 外发路径。

## Task 1A.5

- 新增仓库 bundle registry/loader、registry digest、route/data/payload admission 和脱敏状态
  投影。
- `limited` unknown/missing/expired/drift route fail closed；unknown custom endpoint 仅允许
  `internal_experimental` 且正文分类不高于 internal。
- secret label、credential/private-key marker 和 protected-path marker 在 Provider dispatch
  前阻断；mock Provider 请求数保持为零。
- Model Controller 在 `providerDataPolicyV1=true` 时强制要求注入 immutable gate；缺 gate 不
  回退开发配置。
- follow-up 将 release-pinned gate 收敛到普通模型、compaction、Sub-agent、auto review 和
  Verification reviewer 的最终 dispatch 边界；组合 Verification 已执行前序 check 后遇到本地
  reviewer denial 时保留 unknown，不把整个 reservation 伪装成未执行后退款。

## Task 1A.2

- 新增从结构化 RuntimeEvent 直接构造的 metadata allowlist mapper，不经过“完整序列化后
  scrub”路径；动态 MCP 名称和未知工具名收敛为低基数 kind。
- 永久排除 user/model/reasoning/summary 正文、tool args/stdout/stderr、MCP content、
  workspace/file path、命令、原始异常和 Provider body。
- `SessionLogCollector` 固化 `off | metadata | content` 模式；Runtime flag 关闭时 `off`
  不创建日志目录，开启时只写 metadata。
- revision/cohort/digest/release version/profile 在写入前使用长度、字符集和封闭枚举校验；
  secret/path/command/source marker fixture 证明 metadata 全文不泄露。

## Task 1A.3

- App 配置边界合并 artifact policy、用户显式 opt-in 和项目收紧规则，再向 Runtime 注入唯一
  resolved logging policy；project config 不能开启 content。
- `off` 不创建 writer、目录或正文缓存；metadata 只使用 allowlist mapper；content 只接受
  用户消息、模型可见回答和最终回答的专用 mapper。
- content 正文必须先取得 Runtime secret detector 的结构化 `clear`；missing/unknown/secret/
  throw 全部 fail closed，reasoning、tool/file/approval/Plan/Sub-agent 正文永久拒绝。
- CLI/TUI 显示 resolved mode 和 content 披露；writer 构造、异步排队写入或 finalize 失败只
  报告一次脱敏诊断，不影响 Agent terminal outcome，也不落到不安全 fallback。

## Task 1A.4

- POSIX 使用 `0700/0600`，Windows 使用 owner-only、禁继承 ACL；目录链、文件 descriptor、
  symlink/reparse point 与 hardlink identity 均 fail closed。
- durable lease、admission/operation record 和 terminal marker 防止并发回收；PID/start
  identity、wall-clock 回拨或未知状态均保守保护。
- retention 使用 512 条硬上限及 POSIX 50ms/Windows 30 秒时间预算，部分扫描不删除；Windows
  ACL PowerShell 子进程另有 10 秒硬 timeout，超时 fail closed。
- [Session Log ACL Smoke run 30580337754](https://github.com/ferqx/kite-code/actions/runs/30580337754)
  绑定最终加固提交，macOS/Ubuntu/Windows 均验证 directory/file isolation、link rejection 与
  atomic terminal。artifact archive digest 分别为 macOS
  `sha256:553a89b7e6992efca330fd875cefe4c06905c62e5f3528d434b500805b5bc570`、
  Ubuntu `sha256:3a75101d969ececc1ad0ce0f6ccc7ed9a2983ff131441d92dc829930e8953c34`、
  Windows `sha256:54d47a14caa4a8988a90c2f29b54319a47e3416687112277e699a8e03f607e02`。

## 验证

- 独立只读复核：1A.3 GO，无 P0/P1；与 1C.6 联合定向回归 333 pass/0 fail；
- 标准默认套件：2067 pass/6 skip/0 fail；
- content 真实 Runtime composition、hostile allowlist、任意 secret exact match、writer queued
  failure/finalize failure 和 TUI status PTY：通过；
- `bun run check:docs-impact`、`bun run check:docs`、`bun run check:core-boundary`、
  `bun run typecheck`、Biome 和 `git diff --check`：通过；
- pre-commit golden：10 pass。
- 1A.4 独立只读复核：最终 P1 已关闭，无剩余 P0/P1；相关安全/retention 回归 25 pass；
  三平台最终 ACL workflow 全部通过。

## 回滚与限制

- 回滚设置 `providerDataPolicyV1=false`；production route 全部关闭，旧 qualification 不恢复。
- 当前 approved route bundle 为空，因此本记录不产生 production-qualified route，也不产生
  `MS:1A-DONE`。
- remote MCP content egress 仍等待 1A.6。
- Phase 2 Release Profile/Gate 尚未组合，本记录只证明内部实现完成，不产生 production
  artifact、external qualification 或 Release/Security 签署。
