# 文件读取共享边界 — readTextContent 单入口设计

状态：active
范围：`src/core/tools/file.ts`、`src/core/tools/shell.ts`、`src/core/tools/path-utils.ts`、`src/core/tools/search.ts`、`src/core/harness/tool-runner.ts`、`src/core/model/runtime-context.ts`、`src/core/runtime/agent.ts`、`src/core/subagent/runner.ts`、`src/app/tui/reducers/handleEvent.ts`、`src/app/tui/reducers/agentReducer.ts`、`src/app/tui/reducers/sessionReducer.ts`、`src/protocol/events.ts`、`src/core/tools/tool-contracts.ts`、`src/core/prompts/system-prompt.txt`
读取时机：修改 `readFile`/`editFile`/`writeFile`、二进制检测、编码处理、换行正规化、MSYS2 路径转换、runtime context 路径格式、search 遍历与 `.gitignore` 过滤时必读。
验证：`bun test tests/tools.test.ts tests/tool-definitions.test.ts tests/context.test.ts tests/runtime/agent.integration.test.ts tests/subagent-runner.test.ts tests/tui-reducer.test.ts tests/tui-layout.test.tsx`

## 设计目标

在 Windows/Linux/macOS 三平台下，`readFile` / `editFile` 对同一个文件看到的内容**永远一致**，且模型不会因路径格式问题导致 file 工具调用失败。

## 根因：runtime context 教模型用 POSIX 路径

`buildCacheableRuntimeContext` 原先的逻辑：

```
Shell: bash — use bash syntax, use POSIX paths (e.g. /d/work, not D:\work)
Workspace: /d/work/my-project
```

模型忠实地对所有工具使用 POSIX 路径。这对 `shell_execute` 正确（MSYS2 bash 理解 `/d/...`），但对 `read_file` 致命（Node.js `fs` 无法解析）。

## 架构

### 三层防御

```
第 1 层（主防线）
  runtime-context.ts: Workspace 用 Windows 原生格式展示；
  POSIX 路径提示仅限 shell_execute，明确说明 file 工具用 Windows 路径。
  subagent/runner.ts: CWD 用 process.cwd() 原生格式，不再 toPosixPath。

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

会话级读取状态跟踪（`src/core/tools/read-state.ts`，ADR-0042 §1）：`read_file` / `write_file` / `edit_file` 成功后按规范化路径记录内容指纹（sha256，换行正规化后文本），tracker 以 threadId 为键（主会话与 subagent fork 共享）。`edit_file` 执行前经 `editFileSpec.preExecute` 强制校验：未读（not_read）或指纹与磁盘不一致（stale，即外部修改）时硬失败并引导重读，对齐 Claude Code 的 "File has not been read yet" / "File has been modified since you last read it" 两条工具层拒绝。跟踪 best-effort——不得因跟踪失败中断工具执行；回滚方式为还原强制校验提交（退回 old_string 自然校验）。

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

### 搜索遍历的 `.gitignore` 过滤（`search.ts`）

`search_files` / `search_content` 的工作区内遍历遵循 `.gitignore` 忽略规则（与 ripgrep 默认语义对齐）：

- **作用域为工作区根**：从工作区根到搜索根的祖先链上的 `.gitignore` 与遍历中每个子目录的 `.gitignore` 都生效；工作区之上的仓库级配置（`.git/info/exclude`、全局 excludesFile）不在范围内。
- **支持的规则子集**：空行/注释、`!` 反选、目录专用尾斜杠（`build/` 不忽略同名文件）、前导/中段 `/` 锚定、`*`、`?`、`[abc]`/`[!abc]`、`**`（前导 `**/`、尾随 `/**`、中段 `/**/`）、反斜杠转义；规则按目录叠加，后匹配覆盖先匹配。
- **被排除目录整体剪枝**：git 语义——父目录被排除后，其内部 `.gitignore` 不参与（无法用内部规则重新包含）。
- **`.git` 目录永远跳过**（与 ripgrep 一致）。
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

`truncateProjectedOutput` 对单路超过 4000 字符的输出做 head+tail 截断，中间标注省略行数；`truncateProjectedStreams` 对 stdout/stderr 两路分别套用同一规则（shell_execute、search_content、search_files 经 `spec.projectResult()` 的 `streams` 字段投影）。仅截断不改写（零幻觉），保留首尾信息。失败时两路输出都保留，Runner 只消费投影，不再自带第二份截断实现。

### rg exit code 1 ≠ error（`tool-contracts.ts`、`system-prompt.txt`）

`rg`（ripgrep）无匹配时 exit code 1，`shellTool` 判定 `ok: false`。子 agent 看到 failure 后反复重试造成恶性循环。在 shell_execute 合约和 system prompt 中显式说明：rg exit code 1 = 无匹配，非错误，不重试。

### SubAgentErrorPayload 扩展（`events.ts`、`replay-blocks.ts`）

新增 optional 字段 `summary`、`toolCallCount`、`durationMs`，与 `SubAgentDonePayload` 对齐。`parseTaskResult` JSON 失败兜底添加 `error` 字段，消除 "Unknown error" 展示。

### Runtime context 路径格式（`runtime-context.ts`、`subagent/runner.ts`）

`Workspace` 字段用 Windows 原生格式（`D:\work\my-project`）。仅在 `osPlatform === "win32"` 时追加一条 `shell_execute` 专用的 POSIX 转换提示，并明确说明 file 工具直接用 Windows 路径。

subagent CWD 使用 `process.cwd()` 原生格式，不再通过 `toPosixPath` 转换。

### MSYS2 路径转换（`path-utils.ts`）

- `msys2ToWindowsPath(path)` — 单个路径精确转换，`/d/foo` → `D:\foo`，用于 `file.ts` 防御纵深
- `normalizeMsys2PathsInText(text)` — 正则匹配全部 `/X/...` 模式并转换，用于 `shell.ts`
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

**调用方约束**：`allowExternal` 只能由 `tool-runner.ts` 的 `runApprovedTool` 设置为 `true`，且必须同时满足两个条件（经 `isExternalPathArg` 计算，先做 MSYS2 归一化再判定，见 [[tool-gated-autonomy]] 自治规则 2）：

```
isExternal = isExternalPathArg(path)   // msys2ToWindowsPath 归一化后再 isAbsolute / startsWith('~')
allowExternal = hasExecutionGrant && isExternal
```

其中 `hasExecutionGrant` 由审批管线统一计算（用户审批通过或 `full_access` 授权）。

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
