# ADR-0131：Sandbox 将 Workspace 作为完整授权身份

状态：accepted

日期：2026-08-24

决策者：用户直接指令

相关：ADR-0054、ADR-0097、ADR-0101、ADR-0118、`docs/active/execution-boundary.md`、
`docs/active/windows-shell-sandbox.md`

## 背景

受治理文件 Provider 已按 ADR-0118 将 canonical Workspace 视为完整信任根，但原生 Shell sandbox、
命令文本扫描、MCP executable/cwd evaluator 和 brokered-Git native profile 仍按 `.git`、`.env`、
`.agents`、`.codex` 等名称拒绝 Workspace 内路径。结果是同一已授权目录通过文件工具可读写，
通过 `ls`、Shell child 或本地进程却被二次拒绝；大小写别名和隐藏目录又扩大了三平台差异。

路径名称不是独立的授权主体。Workspace identity、整体 filesystem scope、进程能力、网络能力与
Workspace 外边界才是 sandbox 应机械执行的事实。

## 决策

1. canonical Workspace 是 sandbox 的完整授权身份。在 invocation 已拥有相应整体能力时，Workspace
   内任意 lexical/canonical 成员均不得因为 `.git`、`.env`、Agent/MCP 配置、credential、shell profile、
   additional deny 或大小写别名而被单独拒绝。该规则同时适用于 read、write 与 execute/process 路径投影。
2. `read_only | workspace_write | full_access` 仍决定整棵 Workspace 的操作上限；本决定不把 read-only
   invocation 提升为 writer，也不授予缺失的 process、network 或 child capability。
3. symlink/alias 解析后的 canonical target 不在 Workspace 内时，按 Workspace 外路径处理。Workspace 外
   credential、persistence 与关键系统 identity 继续由命令预检和原生 backend 拒绝；普通外部访问继续遵循
   approved-filesystem scope。
4. `createProtectedPathEvaluator()` 对 Workspace member 的 `read | write | execute` 全部返回 allow；兼容字段
   `additionalDeniedPaths`、`allowedPaths` 与 `protectedPathPolicy` 不得按内部名称缩小 canonical Workspace。
5. `checkDangerousPaths()` 必须接收 canonical Workspace，并忽略可证明位于其中的 literal path；动态且无法
   证明的表达式仍按外部危险路径保守处理。native sandbox 是变量拼接和间接 child 的最终边界。
6. macOS Seatbelt 不再为 Workspace member 生成 protected deny；Linux bubblewrap 不再 mask Workspace
   `.git` 或其他隐藏路径，并在 `full_access` protected mounts 中排除 Workspace member；Windows runner
   只生成 Workspace 外 deny path。Windows persistent ledger 升级并恢复、删除旧版本留下的 Workspace
   protected-path DACL snapshot，避免新策略被宿主残余 ACL 静默覆盖。
7. typed Git broker 的固定 schema、repository hostile 检查和 Shell `git` capability routing 不是
   Workspace path-name sandbox。本决定不把任意 Git argv 加入 typed broker；但 ADR-0097 要求的原生
   `.git` read/write deny 不再成立，依赖该证据的 brokered-Git production qualification 保持 excluded，
   直到后续 ADR 定义不依赖 Workspace path deny 的新资格模型。
8. 当前 production support set 仍为空。修改 backend 后必须重新取得绑定当前实现的三平台原生 evidence；
   本地单元测试不能更新既有 qualification artifact 或 runner binary digest。

## 替代关系

- 替代 ADR-0054 中把 Workspace 内 protected name 作为独立原生 deny 的部分；Workspace 外固定保护保留。
- 替代 ADR-0097 决策 1、2、11 中通用 Shell 必须原生拒绝 Workspace `.git` 才能构成边界的结论；typed
  Git capability 与 hostile repository 防护仍保留。
- 扩展 ADR-0118：完整 Workspace 信任不再只适用于五个文件工具，而是成为 sandbox 路径投影的共同规则。
- 不替代 filesystem scope、Policy/approval、network、process-tree、symlink escape、durable lifecycle 与
  Workspace 外敏感路径保护。

## 后果

- `ls -la`、`ls .agents`、读取或修改 Workspace 内 `.env`，以及 Workspace 内 executable/cwd 不再触发
  protected-path denial；真实宿主 ACL 或整体只读 scope 失败仍如实返回。
- protected-name 不再是 native brokered-Git qualification evidence；现有空生产支持集不会因此扩大。
- Windows 需要新的 canonical runner build、manifest digest 与原生 ACL migration/E2E 证据后，发行 pin
  才能兑现该行为。

## 回滚

回滚必须由新的追加 ADR 恢复 Workspace 内名称级隔离，并同步恢复三平台 profile、Windows ledger 迁移、
命令预检、共享 evaluator、active 文档和原生 evidence。不得只恢复某一平台的隐藏目录 deny。
