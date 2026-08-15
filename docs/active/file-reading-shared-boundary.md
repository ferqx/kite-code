# 文件读取共享边界 — readTextContent 单入口设计

状态：active
范围：`src/core/tools/file.ts`、`src/core/tools/shell.ts`、`src/core/tools/path-utils.ts`、`src/core/tools/search.ts`、`src/core/harness/tool-runner.ts`、`src/core/model/runtime-context.ts`、`src/core/runtime/agent.ts`、`src/core/subagent/runner.ts`、`src/app/tui/reducers/handleEvent.ts`、`src/app/tui/reducers/agentReducer.ts`、`src/app/tui/reducers/sessionReducer.ts`、`src/protocol/events.ts`、`src/core/tools/tool-contracts.ts`、`src/core/prompts/system-prompt.txt`
读取时机：修改 `readFile`/`editFile`/`writeFile`、二进制检测、编码处理、换行正规化、MSYS2 路径转换、runtime context 路径格式、search 遍历与 `.gitignore` 过滤时必读。
验证：`bun test tests/tools.test.ts tests/tool-definitions.test.ts tests/tool-runner.test.ts tests/policies/protected-path.test.ts tests/context.test.ts tests/runtime/agent.integration.test.ts tests/subagent-runner.test.ts tests/tui-reducer.test.ts tests/tui-layout.test.tsx tests/stream-output.test.ts`

## 设计目标

在 Windows/Linux/macOS 三平台下，`readFile` / `editFile` 对同一个文件看到的内容**永远一致**，且模型不会因路径格式问题导致 file 工具调用失败。

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

第 2 层（防御纵深）
  file.ts: resolvePath 入口调用 msys2ToWindowsPath 转换 MSYS2 路径参数。
  历史会话中缓存的 POSIX 路径、模型偶尔跨工具混用格式时自动纠正。

第 3 层（shell 输出清理）
  shell.ts: normalizeMsys2PathsInText 正则替换 stdout/stderr 中的 /X/... 路径。
  防止 shell 输出中残留的 MSYS2 路径被模型学习。
```

### 单一边界 `readTextContent`（`file.ts`）

`readFile` 和 `editFile` 均通过 `readTextContent` 读取文件，禁止各自独立调用 `readFileSync`。

`read_file` / `search_content` / `search_files` 工具调用的编排已迁入 ToolSpec Registry dispatch（`dispatchRegisteredTool`，ADR-0043 S1.2）：各 spec 的 `execute` 仍调用 `readFile` / 原生搜索，字节级单入口 `readTextContent` 与本边界全部规则不变；外部路径 grant 检查经 `ToolExecutionContext.allowExternalPaths` 注入。

读取状态跟踪（`src/core/tools/read-state.ts`，ADR-0042 §1、ADR-0102）：`read_file` / `write_file` / `edit_file` 成功后按规范化路径记录内容指纹（sha256，换行正规化后文本）。tracker 在 session 内按 actor 隔离：Parent 使用稳定的 session scope，每个 Subagent 使用 Runtime 签发且在审批暂停/恢复间不变的 child id；Parent、child 和 sibling 不能互相出借 freshness。tracker 仅存内存，进程重启后未恢复的状态必须 fail closed 为 `not_read`。`edit_file` 执行前经 `editFileSpec.preExecute` 强制校验：当前 actor 未读（not_read）或指纹与磁盘不一致（stale，即外部修改）时硬失败并引导重读。

边界提供两个入口，共享同一个 `decodeTextBuffer` 解码核心（编码检测、二进制检测、换行正规化行为完全一致）：

| 入口 | I/O | 使用场景 |
|------|-----|---------|
| `readTextContent` | `readFileSync` | 单文件工具（read_file / edit_file / write_file 旧内容 diff） |
| `readTextContentAsync` | `fs.promises.readFile` | 批量读取（`search_content` 遍历工作区），避免同步 I/O 长时间占用事件循环、阻塞 TUI 动画渲染 |

处理顺序（不可调换）：

```
读取字节(同步或异步) → 编码检测(BOM) → 解码+剥离BOM → 二进制检测(无BOM时) → normalizeEOL → 返回
```

同理 `search.ts` 的目录遍历全部走 `node:fs/promises`（`readdir`/`stat`），每次 `await` 让出事件循环；结果顺序与遍历语义保持与历史同步实现一致（readdir 目录序 + 深度优先递归，`search_files` 结果排序）。

sealed execution boundary 下，解码/读取之前还有独立的 protected-path V1 gate。它复用
`canonicalPathForComparison()` 解析最近存在祖先与 symlink identity，同时保留 lexical Workspace
identity，并按结构化 operation 区分 read/write/execute。因此 `.git`/`.env` 即使向内链接普通文件
仍按 protected 名称拒绝；内建名称还使用保守的 ASCII 大小写不敏感比较，`.GIT`、`.Agents`、
`.ENV.*` 等 filesystem alias 同样拒绝。Runner 在异步 `beforeDispatch` 后、`write_file`/`edit_file` 旧内容读取和
pre-image capture 之前重检；Registry dispatch 再次检查。显式搜索 protected root 会拒绝，workspace-wide search 则在
进入目录或读取文件前剪枝 protected descendants，因而 `.env`、`.kite-code` 等内容不会成为
搜索结果。该密封边界优先于外部路径 grant；未携带 execution boundary 的开发入口仍维持下文
`allowExternal` 兼容行为。

### 搜索遍历的 `.gitignore` 过滤（`search.ts`）

`search_files` / `search_content` 的工作区内遍历遵循 `.gitignore` 忽略规则（与 ripgrep 默认语义对齐）：

- **作用域为工作区根**：从工作区根到搜索根的祖先链上的 `.gitignore` 与遍历中每个子目录的 `.gitignore` 都生效；工作区之上的仓库级配置（`.git/info/exclude`、全局 excludesFile）不在范围内。
- **支持的规则子集**：空行/注释、`!` 反选、目录专用尾斜杠（`build/` 不忽略同名文件）、前导/中段 `/` 锚定、`*`、`?`、`[abc]`/`[!abc]`、`**`（前导 `**/`、尾随 `/**`、中段 `/**/`）、反斜杠转义；规则按目录叠加，后匹配覆盖先匹配。
- **被排除目录整体剪枝**：git 语义——父目录被排除后，其内部 `.gitignore` 不参与（无法用内部规则重新包含）。
- **`.git` 目录永远跳过**（与 ripgrep 一致）。
- **sealed protected path 额外剪枝**：共享 evaluator 拒绝的 Agent/MCP 配置、credential、shell
  profile 与 additional deny root 不进入遍历；deny 优先于 allow。
- **显式单个文件目标不做忽略过滤**（显式路径优先）；工作区外搜索（`allowExternal`）不做过滤。

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

### `isTextByte` — 字节分类（`file.ts:47`）

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

### 换行正规化（`file.ts:11`）

读入后统一 `\r\n → \n`、`\r → \n`。`editFile` 的 `old_string` / `new_string` 同步做相同正规化，保证匹配一致性。

### edit_file 三级自动回退（`file.ts:269-304`，2026-06-23）

`editFile` 的 `old_string` 匹配在精确失败后自动尝试两级宽松匹配：
1. trimEnd（去除 old_string 行尾空白）
2. 逐行 trim（old_string 和文件内容均逐行去前导/尾随空白后比较）

模型不再需要显式 `matchMode: 'trimmed'` 来处理常见空白不匹配。仅在多行且多命中时返回模糊错误。

### 工具输出截断（`src/core/tools/registry/projection.ts`）

Shell execution adapter 在命令运行期间先以每路 256 KiB 的固定内存 head+tail capture 持续 drain stdout/stderr，防止最终投影前出现无界完整输出副本；capture 超限会写入明确 omission marker。其后 `truncateProjectedOutput` 对单路超过 4000 字符的模型输出继续做 head+tail 截断，中间标注省略行数；`truncateProjectedStreams` 对 stdout/stderr 两路分别套用同一规则（shell_execute、search_content、search_files 经 `spec.projectResult()` 的 `streams` 字段投影）。失败时两路输出都保留，Runner 只消费该模型投影，不再自带第二份模型截断实现。

`read_file` 同时应用源行分页与模型结果硬上限。模型省略 `limit` 时，`readFile()` 默认只选择
2000 个源行；显式 `limit` 仍可请求更小或更大的行区间，但 `readFileSpec.projectResult()` 产生的
完整模型可见字符串（包括截断 marker）不得超过 64 KiB 字符。投影优先保留完整行，并返回
`continue with offset=N`，其中 `N` 必须是最后一个完整可见源行的下一行；模型可用该 offset
继续读取。若单个源行本身超过 64 KiB，该行只暴露有界前缀，marker 必须明确 `line N clipped`
以及现有 line offset 无法在行内无损续读，不能虚构 continuation offset。

截断只改变模型投影：`rawContent` 仍保存换行正规化后的完整文件文本，供 actor-scoped
read-state 计算内容指纹，但不得进入 transcript。`resultMeta.truncated` 区分完整与部分投影，
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

- `msys2ToWindowsPath(path)` — 单个路径精确转换，`/d/foo` → `D:\foo`，用于 `file.ts` 防御纵深
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
| `isTextByte` | 字节级，平台无关 | 同左 | 同左 |
| BOM 检测 | `FF FE` / `FE FF` / `EF BB BF` | 同左 | 同左 |
| `resolvePath` | 标准 `path.resolve` | 同左 | +MSYS2 转换 |
| runtime context Workspace | 标准路径 | 同左 | Windows 原生格式 |

### `allowExternal` — 受控外部路径访问（2026-07-12）

`resolvePath` 新增 `allowExternal` 可选参数。当 `true` 时跳过工作区边界检查，允许读写工作区外的路径。

**调用方约束**：`allowExternal` 只能由 `tool-runner.ts` 的 `invokeGovernedTool` 设置为 `true`，且必须同时满足两个条件（经 `isExternalPathArg` 计算，先做 MSYS2 归一化再判定，见 [[tool-gated-autonomy]] 自治规则 2）：

```
isExternal = isExternalPathArg(path)   // msys2ToWindowsPath 归一化后再 isAbsolute / startsWith('~')
allowExternal = hasExecutionGrant && isExternal
```

其中 `hasExecutionGrant` 由审批管线统一计算（用户审批通过或 `full_access` 授权）。

若当前配置携带 production `executionCapabilitySurface`，该 surface 是审批之前的上限：所有带
Workspace 外 path 参数的进程内文件工具都会在 Runner dispatch 前直接拒绝，不能通过
`hasExecutionGrant`、`same_command` 或 `full_access` 把 production boundary 提升为外部访问。
上述 `allowExternal` 公式只适用于未携带该 production surface 的开发入口。

**所有路径类工具保持一致** — 5 个工具均在 handler 中计算 `isExternal` / `allowExternal` 并透传至实现层：

| 工具 | 实现层边界检查 | allowExternal 透传 |
|------|--------------|-------------------|
| `read_file` | `readTextContent` → `resolvePath` | ✅ |
| `edit_file` | `readTextContent` → `resolvePath`（读/写各一次） | ✅ |
| `write_file` | `readTextContent`（旧内容 diff）+ `writeFile` → `resolvePath` | ✅ |
| `search_content` | `walkFiles`（目录边界）+ `readTextContentAsync`（文件读取） | ✅ |
| `search_files` | `walkFiles`（目录边界） | ✅ |

**双层防御**：
1. 策略层（`evaluateToolApproval` + `modePolicy.shouldApproveTool`）：执行前检查 `externalWrite` 效果，无授权则拒绝
2. 路径层（`resolvePath` / `walkFiles`）：`allowExternal` 为 `false` 时强制边界检查，防御策略层疏漏

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

- [[shell-platform-compatibility]] — bash 选择策略、MSYS2 DLL 依赖
- [[tool-description-contracts]] — 工具 ACI 契约
- [[layer-boundary-enforcement]] — core 层边界约束
- [[tui-reference-stability]] — useStaticContent 引用稳定性方案
