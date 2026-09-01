# Builtin Runtime

## 定位

`@kite-ai/builtin-runtime` 是 Kite-specific capability、模型、工具、MCP、Sandbox、Subagent 与 Verification 语义 owner。

## 拥有职责

- 通过 `createBuiltinRuntimeModules()` 注册唯一 Builtin operation owner 与 executor。
- 从一个 frozen SPI snapshot 投影 parser、schema、description、availability、effects、traits 与 revision。
- 实现具体 filesystem、git、model、planning、sandbox、MCP、Skill、Subagent 和 Verification mechanism。
- 拥有Model/Plan/Capability/filesystem preimage/Sandbox/Subagent private Artifact的schema-aware reader/writer；持久层由App注入，
  Builtin不发现SQLite、Kite Home或第二storage authority。

## 不拥有职责

- 不依赖 Kernel、Host、SQLite 或 App。
- 不持久化 Kernel State，不决定 authorization，不创建第二 dispatcher。
- 不把 `mcp:dynamic_tool` 或 `builtin:ask_user` 暴露为普通模型工具。

## 允许依赖

只允许 workspace 依赖 `@kite-ai/runtime-contract` 与 `@kite-ai/runtime-spi`；外部依赖只服务具体 Builtin mechanism。

## 公开入口

根入口只负责 module composition 和跨域 capability；filesystem、git、mcp、model、planning、sandbox、skills、subagent、verification 使用已声明 subpath。

## 关键不变量

- 当前 snapshot 固定包含 19 个 model-visible tools 和 9 个 internal operations；`git_inspect`只保留为internal Runtime
  capability，模型发出的Git、构建、测试、package-manager与project script统一经过`shell_execute`。
- `shell-semantics.ts`拥有唯一冻结的v1语义注册表。registry digest进入`shell_execute` capability revision；新增普通
  只读program修改descriptor，参数敏感program由descriptor选择局部inspector，未命中保持unknown。
- App/Host/catalog/executor 必须使用同一个 snapshot。
- 任何 terminal uncertainty 不转换为成功或 fallback。
- `PrivateImmutableArtifactStorage`必须在App注入backend与filesystem root之间二选一。single-Service production固定使用typed DB backend且不
  fallback；filesystem root只保留给显式旧owner和owner-local测试。ref derivation、canonical JSON、schema、digest、size与owner验证在两种backend间一致。
- Skill activation 默认生成高熵 identity；Runtime command planner 可以注入经过有界字符集校验的、
  不含用户内容的确定性 `activationId`，使同一逻辑 command 的重试保持同一 activation identity。
  无效注入在 activation 建立前 fail closed，不能回退生成另一个 identity 后继续执行。
- Git broker仍用标准`<primary>/.git/worktrees/<id>`、`commondir`与reciprocal backlink校验transaction authority；
  独立的Workspace scope discovery只canonicalize Git实际读取的外部`gitDir/commondir`，不授予权限。App必须先经
  Workspace Trust确认exact external-read scope，Sandbox才可向Seatbelt/bubblewrap投影对应只读root；该规则不依赖命令名。
- Planning中的可证明只读Shell组合（包括`git status/log/diff`、只读pipe、`head/tail/echo`和`2>/dev/null`丢弃输出）
  保持read-only baseline直接执行。Git另接受零操作数`git branch --show-current`、无pattern的branch列表
  （零参数或`-a/--all/-r/--remotes/--list/--no-color`组合）以及零参数或`-v/--verbose`的remote列表；
  受限Workspace inventory `for`循环仅允许relative literal/glob iterator、唯一loop
  variable展开，以及逐段通过同一只读grammar的body/trailing pipeline。`/dev/null`重定向不是Workspace mutation，不能
  触发用户审批或写风险文案；动态iterator、外部路径、写入、命令替换或未验证suffix仍不能取得read-only分类。
  VCS mutation classifier必须先复用同一个完整read-only grammar结果：任何已证明read-only的Git组合（包括
  `git branch --show-current 2>/dev/null`、`git branch -a --no-color`和`git remote -v`）都不能同时返回mutation；
  branch创建/删除/重命名与remote add/remove/rename/set/update/prune仍保持VCS mutation。
- 未通过只读grammar且无法完整确定effects的Shell固定编译为exact真人审批；Auto/Full不绕过这次确认。危险程序名只在
  executable位置匹配，参数或输出中的`format`/`diskpart`等词不能生成destructive事实。审批仍绑定原sandbox scope，
  不因effects未知自动取得网络、Workspace外路径或Full authority。
- Windows managed sandbox runner discovery只接受v2 managed-install marker、唯一`active` regular-file pointer与
  完整candidate identity（marker、pointer、`.candidate-id`、manifest digest必须一致）。Runner、Shell runtime与
  Coreutils均须是no-follow regular files；running process固定stable launcher显式pin的candidate，不从cwd、PATH或
  ambient home fallback。Windows ACL/locked-directory publication与三平台安装证据仍由release qualification负责，不能由本地测试代替。
- Windows locked-directory publication接受UTF-8文本或原始bytes，在pinned non-reparse目录内写入，可按owner分别要求
  write-through handle、显式`FlushFileBuffers`与write-through atomic replace。Workspace写入保留完整durability；release installer对
  launcher、pointer与marker统一使用ordinary atomic publish，任一部分发布由marker/pointer/checksum交叉验证fail closed；release不把
  Windows虚拟磁盘的高延迟write-through当作安装正确性前提，Bun `fsync`也不是Windows发布owner。

## 测试

`bun test packages/builtin-runtime/test`

## 文档影响

模块局部变化更新本 README；授权、Model、MCP 或 Tool Pipeline 跨包语义同时更新对应 `docs/active/` authority。
