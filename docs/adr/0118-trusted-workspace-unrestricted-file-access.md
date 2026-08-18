# ADR-0118：受信任 Workspace 的无差别文件访问

状态：accepted

日期：2026-08-18

决策者：github:@ferqx

相关：ADR-0042、ADR-0054、ADR-0097、ADR-0100、ADR-0101、ADR-0111、ADR-0113、ADR-0117、
`docs/active/file-reading-shared-boundary.md`

## 背景

既有 protected-path 规则同时服务原生 Shell、MCP executable/cwd 与五个受治理文件工具。它把 `.git`、
`.env`、`.ssh`、`.codex`、`.agents` 等名称视为统一的拒绝身份，并把 Workspace 外读取送入审批。该模型
在进程执行边界上仍有价值，但不适合用户已经选定的受信任 Workspace：项目位于
`~/.codex/worktrees/...` 等宿主目录时，祖先名称会误伤普通 `package.json`、`AGENTS.md`；项目自身的
配置、Git metadata 与环境文件也无法由文件工具直接检查或修正。

文件 Provider 已经具备 canonical/no-follow identity、read-before-edit、preimage、stale check、单次 grant、
descriptor-relative publication、大小限制与 typed failure。文件访问授权可以与进程执行保护分离，而不
删除这些技术安全与恢复保证。

## 决策

1. 内建 `read_file`、`search_content`、`search_files` 对任何语法有效、Provider 可表示的路径默认免审读取。
   绝对路径、`..`、symlink 解析后的 Workspace 外目标和 `~` 路径使用只读 `external_read` scope；它不是
   mutation approval，不能签发 prepare/commit grant。
2. 当前 Workspace 是用户已经选定的完整信任根，物理位置与祖先目录名称不改变该事实。五个文件工具可
   读取所有 Workspace 内容；在 Building 阶段，`accept_edits` 可直接写入 Workspace 内任何路径，包括
   `.git`、`.env`、`.ssh`、`.codex`、`.agents` 及其大小写别名。Planning 的只读 ceiling 保持不变。
3. Workspace 外 `write_file`/`edit_file` 在 `accept_edits` 下必须获得绑定当前 Tool invocation 与目标 operation
   的批准。Auto 可按既有 auto-review 路由产生同等单次批准；显式 Full 按其既有授权语义处理。批准后
   Pipeline 密封 `approved_external` scope，文件 protected-path 名称、additional deny 或宿主祖先名称不得
   再次否决同一 mutation。
4. 文件 Provider 仍机械验证 capability/tool/attempt/effect/Workspace/operation/TTL、canonical/no-follow
   identity、preimage、freshness、ready ack、single-use commit、取消、大小/编码/二进制限制和原子发布。
   授权不伪造成功：不存在目标、权限/ACL、磁盘、stale/TOCTOU、unsupported native backend 或 I/O 错误仍
   返回真实 typed failure。
5. 文件搜索不再硬跳过 `.git`，也不因 protected 名称剪枝。`.gitignore` 继续作为查询语义生效；它不是
   授权规则。显式文件目标继续不应用 ignore 过滤。
6. 本决定不扩大 `shell_execute`、typed Git、MCP transport/executable/cwd、Skill reference、Plan Artifact
   或原生 sandbox 的权限。进程执行仍可在审批前拒绝 destructive、提权、关键系统删除、credential/
   persistence 等极高风险形态，并受 native sandbox。文件工具不得被用作通用 process capability。
7. `WorkspaceFilesystemProtectedBoundaryV1` 为兼容当前 v25 协议继续存在，但文件工具投影为空的 path-name
   deny/allow 集合；其 digest 仍与 intent/grant 绑定。Runtime schema、format epoch 与 Store schema 不变。

## 替代关系

- 替代 ADR-0042 §3 中“工作区外路径任何模式审批”的读取部分；外部 mutation 在 `accept_edits` 下仍审批。
- 替代 ADR-0100 决策 1、5、6 及后果中关于内建文件 read/search 的审批与危险路径前置拒绝；ADR-0100 的
  Shell/native per-invocation capability 保持有效。
- 收紧 ADR-0111 决策 3 的解释：Filesystem seam 不是无治理任意路径 API，但 read-only `external_read` 是
  默认 admitted scope；只有 mutation 的 `approved_external` 表示用户批准。
- 不替代 ADR-0054、ADR-0097、ADR-0101 的原生进程、Git 与极高风险操作保护。

## 后果

- 项目可位于任意当前受信任 Workspace；Codex-managed worktree 不再因 `~/.codex` 祖先误拒普通文件。
- 文件读取不再产生 `externalRead` approval blocker；CompletionGuard 不再需要为这类审批等待。
- 外部 mutation 的批准具有可兑现语义：批准后不会再被文件 protected-path policy 二次拒绝。
- 文件与进程使用不同的 path authorization projection，文档和测试必须明确区分，不能把文件开放误述为
  Shell/MCP/Git 开放。

## 回滚

回滚必须整体恢复旧文件 path policy、两态 path scope 与对应 active 文档/测试；不得只在 Provider 重新加入
名称 deny，造成“审批已通过但执行期二次拒绝”的双权威。
