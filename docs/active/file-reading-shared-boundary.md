# Workspace 文件系统共享边界 — Provider 单入口

状态：active
范围：`src/protocol/workspace-filesystem-provider.ts`、`src/core/execution/workspace-filesystem/`、`src/core/execution/tool-pipeline/workspace-filesystem.ts`、五个 filesystem ToolSpec、`src/core/persistence/filesystem-preimage-artifacts.ts`、`src/core/runtime/`、`src/core/model/runtime-context.ts`、`src/core/tools/path-utils.ts`
读取时机：修改 `read_file`/`edit_file`/`write_file`、filesystem Provider/grant、preimage/ready/commit、durable freshness、二进制检测、编码处理、换行正规化、runtime context 路径格式、search 遍历与 `.gitignore` 过滤时必读。
验证：`bun test tests/execution/workspace-filesystem-provider.test.ts tests/execution/workspace-filesystem-pipeline.test.ts tests/execution/workspace-filesystem-local-race-parity.test.ts tests/search-nonblocking.test.ts tests/runtime/filesystem-evidence.test.ts tests/runtime/capability-artifacts.test.ts tests/tools.test.ts tests/tool-definitions.test.ts tests/tool-runner.test.ts tests/policies/approval-policy.test.ts tests/policies/protected-path.test.ts tests/context.test.ts tests/runtime/agent.integration.test.ts tests/subagent-runner.test.ts tests/tui-reducer.test.ts tests/tui-layout.test.tsx tests/stream-output.test.ts`、`bun run check:core-boundary`。

相关：ADR-0111、ADR-0113、ADR-0118。

## 设计目标

在 Windows/Linux/macOS 三平台下，读取、编辑准备与提交使用同一 Local Provider 解码和目标身份，且任何
Workspace filesystem I/O 都不能绕过 Tool Pipeline 的 durable intent 与 purpose-bound grant。

## 当前生产权威（PS-01）

生产文件能力的唯一 seam 是 `WorkspaceFilesystemProviderV1`，其三个 purpose 隔离入口为
`observe`、`prepareMutation` 与 `commitMutation`。`LocalWorkspaceFilesystemProviderV1` 及其精确 allowlist 的
descriptor-relative internal helper 是唯一可以为受治理文件工具导入 host filesystem/native API 的生产
backend；ToolSpec、Runner、Controller 与 Registry 不直接
读写文件。原 `file.ts`/`search.ts` 已移到 `tests/helpers/legacy-workspace-filesystem-*`，只作为差分 oracle，
不能被 production 导入，也不是 Provider failure 的 fallback。

```text
read/search:
  invocation + attempt durable ack → observe grant → Local observe → terminal receipt

write/edit:
  invocation + attempt durable ack → prepare grant → zero-write identity/preimage
  → private immutable preimage Artifact → filesystem_mutation_ready durable ack
  → single-use commit grant → Local atomic commit → terminal receipt
```

grant 绑定 thread、turn、Tool Call、invocation、capability revision、effect digest、canonical Workspace、
path-policy revision、JSON-safe file boundary、approval summary、完整 operation 与 TTL，并以 HMAC seal
防篡改。Runtime v25 的 `searchBoundaryDigest` 与 protocol 的 `protectedPathRevision` 保留兼容字段名；文件
工具按 ADR-0118 固定空的 path-name deny/allow projection，其 digest 仍进入 intent/grant。purpose 不匹配、
过期、重复消费、取消、Workspace/path/operation/identity/preimage 漂移均 fail closed。commit 会在写入前重新
捕获 no-follow/followed/nearest-existing parent identity；commit 从已 pin 的 nearest-existing ancestor descriptor
逐段使用 no-follow `openat`/`mkdirat` 创建 parent，并以同一 pinned parent descriptor 完成 exclusive temp create、
`unlinkat` cleanup 与 `renameat` 发布，不再重新解析 lexical parent path。最后一次 identity 重验前发现 hardlink、
symlink swap 或 stale preimage 保持零文件写入；若攻击者恰好在 final check 后替换 parent，descriptor-relative
发布仍只会进入原先 pin 的目录，不会重定向到 Workspace 外，随后 lexical terminal evidence 失败按
commit-unknown 收敛并禁止自动重放。Windows 当前没有经验证的 handle-relative backend，因此 write/edit 在
任何 mutation write 前 fail closed；不允许回退 path-based rename。相关决策见 ADR-0113。
跨平台 Registry/Harness 回归在 Windows 必须同时证明调用确实到达 Local Provider、结果为 typed failure、
目标保持未修改且没有 host/path-based fallback；Unix 才断言 descriptor-relative mutation 成功。

`read_file` 只有在成功 terminal receipt 提交后，才把 actor、lexical/canonical target identity 与 content
的 digest-only observation 写入 Runtime。`edit_file` 在 prepare 后读取同一 actor、同一 lexical target 的
最新 committed observation：缺失返回 `read_required`，content digest 与 preimage 不同返回 `stale_read`。
Parent、child 与 sibling actor 不能互借 freshness。mutation 成功后提交新的 observation。Runtime 不保存
filesystem 正文、grant 或 filesystem intent/ready 中的原始路径；preimage 正文只在 owner-only 私有
Artifact 中。既有 `tool.queued` arguments 与 `tool.finished.resultMeta` 仍可包含已经投影给模型的路径，
但它们不构成 Provider grant、target identity 或 freshness authority；旧 rewind checkpoint 只是
best-effort 次级投影，不授权 commit。

## 根因：runtime context 教模型用 POSIX 路径

`buildCacheableRuntimeContext` 原先的逻辑：

```
Shell: bash — use bash syntax, use POSIX paths (e.g. /d/work, not D:\work)
Workspace: /d/work/my-project
```

模型忠实地对所有工具使用 POSIX 路径。host MSYS2 bash 原生理解 `/d/...`；Windows restricted-token
使用的 isksh 不提供 drive mount，因此其 adapter 把字面量 shell path token 转为 `D:/...` 后执行。
这两种 `shell_execute` 路径都有效，但 `read_file` 直接调用 Node.js `fs`，无法解析 `/d/...`。

## 架构

### 三层防御

```
第 1 层（主防线）
  runtime-context.ts: Workspace 用 Windows 原生格式展示；
  POSIX 路径提示仅限 shell_execute，明确说明 file 工具用 Windows 路径。
  subagent/runner.ts: Workspace 与 CWD 共用 resolve(input.workspace) 的规范绝对路径。

第 2 层（Provider identity）
  Local Provider 将 operation path 解析为 lexical/resolved/canonical/no-follow identity，
  并按 sealed pathScope 与 canonical Workspace 验证；Tool Pipeline 绑定 protected-path revision。

第 3 层（shell 输出清理）
  shell.ts: normalizeMsys2PathsInText 正则替换 stdout/stderr 中的 /X/... 路径。
  防止 shell 输出中残留的 MSYS2 路径被模型学习。
```

### 单一边界 `LocalWorkspaceFilesystemProviderV1`

读取、search content、mutation preimage 与 commit stale 检查共享 Local Provider 的 decode/identity 规则；
禁止 production 调用方自行导入旧 `readTextContent` 或 filesystem adapter。

五个 filesystem ToolSpec 的 `execute` 只把结构化 operation 交给 Pipeline 注入的 dispatcher。读取与搜索
可以把 Workspace 外路径密封为 `pathScope=external_read`，不需要 approval；该 scope 只允许 observe，不能
进入 prepare/commit。Workspace 外 mutation 只有在 Policy 已批准且 sealed operation 为
`pathScope=approved_external` 时可由 Provider 接受。Workspace 内 mutation 使用 `workspace_only`，Workspace
物理位置和 `.git`/`.env`/`.ssh`/`.codex`/`.agents` 等名称不产生第二次拒绝。Provider 不从 mode、用户
字符串或未受治理的 boolean 自行扩大 mutation scope。

旧进程内 `read-state` 不再是生产 freshness authority。freshness 来自 Runtime capability invocation 的
digest-only `filesystemObservation`，只有成功 terminal receipt 才会由 reducer 提升。restore 后仍由当前
RuntimeState 严格重建，不从 transcript、路径字符串或 legacy checkpoint 补造。current-format codec 与
snapshot invariant 会严格重算 intent/ready digest；新 attempt 开始前清除旧 attempt 的 intent/ready。
带 observation 的成功 receipt 在 production restore、verification 与后续 edit freshness 消费前，还必须把
Artifact owner、result/evidence digest 与 observation exact 绑定；任一损坏或不匹配都 fail closed。
`filesystemObservation` 为 Pipeline 保留字段：MCP/adapter 不得通过 `CapabilityResult.structuredContent`
提供该字段，receipt 归一对此 fail closed。Runtime 仅从有匹配 filesystem intent 且 capability/effect/
receipt family 精确为内建 `read_file|write_file|edit_file` 的成功 receipt 提升或消费 observation；
其他 Capability 即使构造出合法 digest 形状也不能获得 read-before-edit authority。该 evidence 还必须保留
Workspace filesystem dispatcher 签发的进程内对象身份；签发 authority 使用不可序列化的 `WeakMap`
绑定 invocation、attempt、intent/operation digest、capability/effect、actor 与全部 target/content digest。
dispatch 还把 authority 固定到同一冻结的 `ToolExecutionResult` 对象；adapter 顶层伪造、复制或替换真实
result/observation、替换 recorded invocation/attempt 或跨进程恢复该对象都不能
通过 receipt normalizer。write/edit 的 terminal observation 还必须与同 attempt 的 durable mutation-ready
intent/operation 精确相符；read observation 不得携带 mutation-ready，且所有 observation 的 lexical target
必须与 durable intent 一致。

Local Provider 的所有文本观察共享同一 `decodeText` 核心（编码检测、二进制检测、换行正规化行为一致）：

| 入口 | I/O | 使用场景 |
|------|-----|---------|
| `observe(read_file/search_content)` | Local Provider | 只在 observe grant 验证后读取并返回有界 observation |
| `prepareMutation` | Local Provider | 零写入捕获目标 identity 与完整 preimage |
| `commitMutation` | Local Provider | 重验 prepare identity/preimage 后使用同目录临时文件和 rename 原子发布 |

处理顺序（不可调换）：

```
Provider descriptor 读取字节 → 编码检测(BOM) → 解码+剥离BOM → 二进制检测(无BOM时) → normalizeEOL → 返回
```

Local Provider 的搜索遍历使用同一 no-symlink-follow 目录身份规则，并设置 observation byte/match 上限；
遍历目录、entry 与 content file 之间协作式让出 event loop，避免大型生产搜索独占 TUI/Runtime loop。
`.gitignore` 语义过滤后，`search_files` 结果稳定排序；`.git` 不再被文件 Provider 硬跳过，模型传入的 search glob 保留既有 brace
alternatives（例如 `*.{log,txt}`）。旧 async search 实现只保留为测试 oracle，生产 nonblocking 保证由
Local Provider 自身提供。ancestor 与 local `.gitignore` 都在 sealed boundary 判定后以 `O_NOFOLLOW` 打开，
绑定 regular-file identity，并采用 1 MiB 上限读取；symlink、identity 漂移、越界 canonical target 或超限
metadata 都使搜索 fail closed。

文件 path evaluator 仍复用 `canonicalPathForComparison()` 解析最近存在祖先与 symlink identity，并保留
lexical Workspace identity，但其授权语义按 operation 分开：read 对所有有效路径 allow；write 对 canonical
Workspace 内目标 allow、对外部目标返回 prompt；execute 继续使用 release-owned protected 名称与 additional
deny/allow。因而当前受信任 Workspace 可位于任意宿主目录，且其中 `.git`、`.env`、`.ssh`、`.codex`、
`.agents` 等内容可由文件工具读写；宿主祖先名称不能降低 Workspace 信任。

Registry 最终 gate 与 Pipeline 仍会在异步审批后重新捕获 canonical target。外部 read 使用只读
`external_read`，外部 mutation 必须有 exact approved invocation 才能形成 `approved_external`；已批准 mutation
不会再因文件名或宿主祖先触发 protected-path 二次拒绝。Local Provider 不导入 Policy，只机械执行空的文件
path-name projection与 scope、canonical/no-follow identity、preimage/stale/ready/commit 约束。symlink/parent
swap若把 `workspace_only` 目标移到 Workspace 外会拒绝；若仍解析到 Workspace 内的另一路径，则按当前受信任
Workspace 语义继续执行并由 freshness/TOCTOU evidence 约束。Shell、MCP executable/cwd、typed Git 与原生
sandbox 仍使用独立的 execute/process protected boundary，不受文件工具开放影响。

### 搜索遍历的 `.gitignore` 过滤（Local Provider）

`search_files` / `search_content` 的工作区内遍历遵循 `.gitignore` 忽略规则（与 ripgrep 默认语义对齐）：

- **作用域为工作区根**：从工作区根到搜索根的祖先链上的 `.gitignore` 与遍历中每个子目录的 `.gitignore` 都生效；工作区之上的仓库级配置（`.git/info/exclude`、全局 excludesFile）不在范围内。
- **支持的规则子集**：空行/注释、`!` 反选、目录专用尾斜杠（`build/` 不忽略同名文件）、前导/中段 `/` 锚定、`*`、`?`、`[abc]`/`[!abc]`、`**`（前导 `**/`、尾随 `/**`、中段 `/**/`）、反斜杠转义；规则按目录叠加，后匹配覆盖先匹配。
- **被排除目录整体剪枝**：git 语义——父目录被排除后，其内部 `.gitignore` 不参与（无法用内部规则重新包含）。
- **`.git` 没有硬编码跳过**：只有匹配实际 `.gitignore` 规则时才剪枝，可显式搜索 Git metadata。
- **没有 protected-name 额外剪枝**：Agent/MCP 配置、credential-looking 文件和 additional execute deny root
  都属于受信任 Workspace 的可搜索内容。
- **显式单个文件目标不做忽略过滤**（显式路径优先）；工作区外搜索使用 `pathScope=external_read`，不加载 Workspace 的 ignore 规则。

### 编码检测与二进制检测的优先级

**编码检测在前，二进制检测在后**。UTF-16 文件 NUL byte 比例天然高（ASCII 字符每两字节一个 NUL），先做二进制检测会误杀。

**有 BOM 的文件跳过启发式二进制检测**。BOM 显式声明了文本编码，现实中不存在带 BOM 的二进制文件。

编码优先级：

| BOM | 编码 | 剥离 |
|-----|------|------|
| `FF FE` | UTF-16LE | U+FEFF |
| `FE FF` | UTF-16BE（byte swap 后以 utf16le 解码） | U+FEFF |
| `EF BB BF` | UTF-8 | U+FEFF |
| 无 BOM | UTF-8 | 无 |

### 字节分类（Local Provider `decodeText`）

| 区间 | 判定 | 说明 |
|------|------|------|
| `0x00-0x08` | 非文本 | NUL 等控制字符 |
| `0x09` (TAB) | 文本 | |
| `0x0A` (LF) | 文本 | |
| `0x0B` (VT) | **非文本** | 垂直制表符，现代文件几乎不存在；遗留文件可由内部调用方传 `force: true`（该选项属内部接口，不暴露到模型工具表面） |
| `0x0C` (FF) | **非文本** | 换页符，同上 |
| `0x0D` (CR) | 文本 | |
| `0x0E-0x1F` | 非文本 | 其余控制字符 |
| `0x20-0x7E` | 文本 | 可打印 ASCII |
| `0x7F` (DEL) | 非文本 | |
| `0x80-0xFD` | 文本 | UTF-8 多字节（`0x80-0xBF` continuation + `0xC0-0xFD` leading） |
| `0xFE-0xFF` | 非文本 | UTF-8 中无效字节 |

采样前 8KB，非文本字节超过 30% 则拒绝。

### 换行正规化（Local Provider）

读入后统一 `\r\n → \n`、`\r → \n`。`editFile` 的 `old_string` / `new_string` 同步做相同正规化，保证匹配一致性。

### edit_file 精确匹配（Local Provider）

`edit_file` 只按换行正规化后的 `old_string` 做精确匹配，不自动 trim 行尾或逐行空白。零命中返回
`old_string` 未找到；多命中且未设置 `replace_all=true` 时返回模糊匹配错误；显式
`replace_all=true` 才替换全部精确命中。宽松匹配不是 production fallback。

### 工具输出截断（`src/core/tools/registry/projection.ts`）

Shell execution adapter 在命令运行期间先以每路 256 KiB 的固定内存 head+tail capture 持续 drain stdout/stderr，防止最终投影前出现无界完整输出副本；capture 超限会写入明确 omission marker。其后 `truncateProjectedOutput` 对单路超过 4000 字符的模型输出继续做 head+tail 截断，中间标注省略行数；`truncateProjectedStreams` 对 stdout/stderr 两路分别套用同一规则（shell_execute、search_content、search_files 经 `spec.projectResult()` 的 `streams` 字段投影）。失败时两路输出都保留，Runner 只消费该模型投影，不再自带第二份模型截断实现。

`read_file` 同时应用源行分页与模型结果硬上限。模型省略 `limit` 时，`readFile()` 默认只选择
2000 个源行；显式 `limit` 仍可请求更小或更大的行区间，但 `readFileSpec.projectResult()` 产生的
完整模型可见字符串（包括截断 marker）不得超过 64 KiB 字符。投影优先保留完整行，并返回
`continue with offset=N`，其中 `N` 必须是最后一个完整可见源行的下一行；模型可用该 offset
继续读取。若单个源行本身超过 64 KiB，该行只暴露有界前缀，marker 必须明确 `line N clipped`
以及现有 line offset 无法在行内无损续读，不能虚构 continuation offset。

截断只改变模型投影：Provider observation 的 `rawContent` 保留换行正规化后的完整文件文本，供
Pipeline 生成 digest-only observation，但正文不得进入 RuntimeState 或 transcript。`resultMeta.truncated` 区分完整与部分投影，
`rawResultDigest` 对截断前的本次行号化结果取摘要。带尾随换行的文件不得把终止空字符串计为
额外源行，保证 `toLine` 与 continuation offset 不超过 `totalLines`。

### rg exit code 1 ≠ error（`tool-contracts.ts`、`system-prompt.txt`）

`rg`（ripgrep）无匹配时 exit code 1，`shellTool` 判定 `ok: false`。子 agent 看到 failure 后反复重试造成恶性循环。在 shell_execute 合约和 system prompt 中显式说明：rg exit code 1 = 无匹配，非错误，不重试。

### SubAgentErrorPayload 扩展（`events.ts`、`replay-blocks.ts`）

新增 optional 字段 `summary`、`toolCallCount`、`durationMs`，与 `SubAgentDonePayload` 对齐。`parseTaskResult` JSON 失败兜底添加 `error` 字段，消除 "Unknown error" 展示。

### Runtime context 路径格式（`runtime-context.ts`、`subagent/runner.ts`）

`Workspace` 字段用 Windows 原生格式（`D:\work\my-project`）。仅在 `osPlatform === "win32"` 时追加一条 `shell_execute` 专用的 POSIX 转换提示，并明确说明 file 工具直接用 Windows 路径。

Subagent 在入口处将 `input.workspace` 经 `resolve()` 规范化；模型可见的 `Workspace`、`CWD` 与所有工具执行根目录共用该绝对路径，不读取启动进程的 `process.cwd()`。

### MSYS2 路径转换（`path-utils.ts`）

- `msys2ToWindowsPath(path)` — 单个路径精确转换，`/d/foo` → `D:\foo`；PS-01 后只用于明确的兼容/测试边界，生产 filesystem operation 使用 runtime context 指示的原生路径
- `normalizeMsys2PathsInText(text)` — 正则匹配全部 `/X/...` 模式并转换，用于 `shell.ts`
- `normalizeMsys2DrivePathsInShellCommand(command)` — 只把 Windows shell token boundary 上的字面量
  `/X/...` 前缀转换为保留正斜杠的 `X:/...`，供 restricted-token isksh adapter 使用；不转换 URL、
  `/dev/null` 或相对路径
- `canonicalPathForComparison(path)` / `isPathInsideWorkspace(workspace, target)` — 对已存在的最近祖先调用 `realpath`，再拼回尚未创建的后缀；Approval Policy、file 边界与 search 遍历共同使用，确保 macOS `/var` 与 `/private/var`、符号链接 workspace 等文件系统别名不会被误判为外部路径，同时仍能识别通过符号链接逃逸工作区的目标。

前两个 MSYS2 转换函数均以 `process.platform !== "win32"` 短路，Linux/macOS 完全透传。

## 跨平台行为

| 功能 | Linux | macOS | Windows |
|------|-------|-------|---------|
| `msys2ToWindowsPath` | 透传 | 透传 | `/d/foo` → `D:\foo` |
| `normalizeMsys2PathsInText` | 透传 | 透传 | 正则替换全部 `/X/...` |
| `normalizeEOL` | 无 CR，无操作 | 同左 | CRLF → LF |
| Provider 文本字节分类 | 字节级，平台无关 | 同左 | 同左 |
| BOM 检测 | `FF FE` / `FE FF` / `EF BB BF` | 同左 | 同左 |
| Provider target identity | lexical/resolved/canonical/no-follow | 同左 | 同左，operation 使用原生路径 |
| Provider mutation publish | pinned parent `openat`/`renameat` | 同左 | 无 handle-relative backend，write/edit fail closed |
| runtime context Workspace | 标准路径 | 同左 | Windows 原生格式 |

### `pathScope` — 受控外部路径访问

每个 Provider operation 显式携带封闭的 `workspace_only | external_read | approved_external` path scope。
`external_read` 是默认免审的 observe-only scope；Pipeline 对 mutation 使用它会在 intent/Provider I/O 前
拒绝。`approved_external` 只来自已经分类、授权且 durable recorded 的 mutation invocation；Local Provider
只验证并执行 grant，不能从 `full_access`、命令字符串或旧 `allowExternal` boolean 自行扩大 mutation scope。

五个路径类 ToolSpec 都只通过注入的 filesystem dispatcher 调用 Provider。策略层只为 external mutation
计算 approval；Provider 层再验证 canonical Workspace、target identity、scope 和 no-follow 边界。读取的
路径位置不形成 approval blocker；mutation 的任一治理层缺失仍 fail closed。sealed production process
capability surface 不得把文件工具读取误分类为原生进程 external-path capability。

## 验证

```bash
bun run typecheck
bun test tests/tools.test.ts
bun test tests/tool-definitions.test.ts tests/tool-policy.test.ts tests/runtime/agent.integration.test.ts tests/subagent-runner.test.ts tests/context.test.ts
bun test tests/subagent-approval.test.ts
bun test tests/tui-reducer.test.ts tests/tui-layout.test.tsx tests/session-manager.test.ts
```

### LOAD_SESSION 未设置 nextBlockId + blockIndex 删除（`sessionReducer.ts`、`handleEvent.ts`、`helpers.ts`）

`LOAD_SESSION` 从 DB 加载会话的 turns/blocks 后未更新 `nextBlockId`，新事件创建的
block 与已加载 block ID 冲突 → `replaceBlockById` 的 `findIndex` 替换了 wrong block → `tool_done` 永远找不到目标。

修复：
- `LOAD_SESSION` 中加入 `nextBlockId: Math.max(state.nextBlockId, maxBlockIdInTurns(loadedTurns) + 1)`
- `SWITCH_SESSION` 原先已有此逻辑，提取 `maxBlockIdInTurns` 到 `helpers.ts` 复用
- 彻底删除 `blockIndex` 手动缓存（`callId→blockId` 映射，6 处同步点），换用 `findBlock`/`hasBlock` 全量扫描，消除所有缓存一致性 bug 类别

### 子 agent 取消/异常收尾（`agentReducer.ts`、`subagent/runner.ts`、`SubAgentBlock.tsx`）

- `cancelRunningBlocks`：Esc 取消时在 `running: false` 之前同步将 running subagent/tool_card 标记为 `"Cancelled"`，防止状态被 `<Static>` 永久冻结
- `AbortError` 识别为 `"Cancelled"` 而非 `"The operation was aborted."`
- `subagent_error` 事件携带 `summary`/`toolCallCount`/`durationMs`，TUI 与 `subagent_done` 一样展示步骤全景
- done/error/cancelled 三态统一用 `●` 圆点（与 `tool_card` 一致），running 态用 `⠋` spinner

### Runtime 工具结果渐进展示

- Runtime 可将连续、免审且已证明无副作用的内置读取组成最多 4 项的并行批次；每项仍独立
  投影工具生命周期事件，TUI 在并发执行期间按实际 started/progress/terminal 事件渐进刷新。
- `tool.queued` 只保留为 Runtime 调度事实，不创建可见工具块；启动前取消的读取不展示
  Cancelled；只有开始执行，或开始前直接失败且需要展示诊断时才进入消息列表。审批目标只在
  Footer 展示待授权命令，不因等待审批而物化。用户拒绝或取消任一工具审批会中止整个当前
  turn：未开始读取保持不可见，已开始读取按 cancelled 收尾（ADR-0049）。
- task 子 agent 与普通工具都通过 Runtime/Tool Controller 调度，不建立 UI 专用执行通道。
- `tool_done` handler 的 `elapsedMs` 优先保留首次计时，避免后续投影覆盖。

### `<Static key={blockFingerprint}>`（`useStaticContent.tsx`、`App.tsx`）

- `<Static>` item key 从 `block.id` 改为 `blockFingerprint(block)`，status 变化时 Ink 视为新 item 正确重渲染
- settled turns 缓存从纯计数改为 fingerprint 驱动，捕获取消后 block 状态变更

## 关联文档

- [Shell 平台兼容性](shell-platform-compatibility.md) — bash 选择策略、MSYS2 DLL 依赖
- [工具描述契约](tool-description-contracts.md) — 工具 ACI 契约
- [分层边界强制](layer-boundary-enforcement.md) — core 层边界约束
- [TUI useStaticContent 引用稳定性](tui-reference-stability.md) — useStaticContent 引用稳定性方案
