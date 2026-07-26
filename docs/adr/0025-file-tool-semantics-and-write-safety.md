# ADR-0025：文件工具规则对齐 Claude Code 成熟模型

状态：accepted
日期：2026-07-25

## 背景

当前文件工具集为 `read_file` / `write_file`（`mode: 'overwrite' | 'append'`，默认覆写）/ `edit_file`（`old_string`/`new_string` 精确替换，支持 `replace_all`）/ `apply_patch`。实际使用中暴露四类问题：

1. **软约束无强制**："先读后写"、"edit 优先"只存在于契约文本，模型违反时工具层照常执行成功，无反馈回路。
2. **展示与事实不符**：tool_card 动词曾静态固定为 `Create`。已通过 `writeFileActionName(summary, args)` 从结果推导（覆写→Write、新建→Create、追加→Append）修复。
3. **append 被误用**：观察到模型在非日志型文件上选择 `mode: 'append'`，产生非预期追加。
4. **盲写不可逆**：默认 accept-edits 模式下工作区写入自动放行，覆写未读/被外部修改的文件会静默丢失变更，且无撤销手段。

草案曾设计"write_file 默认仅创建 + overwrite/append 显式逃生门 + 新鲜度校验"方案，与成熟产品对比后放弃：机制过重（写入侧拒绝 + 新鲜度 + 逃生门三件套），而防护职责与"edit 侧强制 + 可逆性"重叠。

参考基线 Claude Code 的规则组合：Write 创建或覆写、无 mode/append、写入侧不做新鲜度校验；Edit **强制本会话先读、强制读后未过期**（两条工具层硬失败）；追加由 Edit 尾部匹配或 shell 表达；acceptEdits 的低摩擦由**自动 checkpoint + rewind** 兜底。本仓库权限分层（default/accept-edits/plan/full）已与其对齐，缺的是 edit 侧强制与可逆性两块。

## 决策

### 1. edit_file 硬强制：先读后改 + 过期拒绝（核心引进）

`edit_file` 在工具层增加两条 fail-fast 校验：

- **未读拒绝**：目标文件在本会话未经 `read_file` 读取 → 拒绝执行，错误信息引导先读（对齐 Claude Code "File has not been read yet"）；
- **过期拒绝**：读取后文件被外部修改（mtime/内容哈希变化）→ 拒绝执行，要求重新读取（对齐 "File has been modified since you last read it"）。

实现依赖会话级读取状态跟踪（path → 读取时 mtime/哈希），由 tool-runner 在 `read_file` 成功时记录。`old_string` 匹配失败仍是既有的自然校验，两条新校验在其之前生效。

契约文本软约定保留（edit 优先、同一 turn 不对同一文件多次调用、old_string 必须来自已核实内容），硬强制使其成为闭环。

### 2. write_file 保持创建/覆写统一语义，移除 append 模式

- `write_file` 维持创建或整文件覆写，**不引入存在性拒绝**——写入侧破坏性由权限层 + §4 可逆性兜底（Claude Code 同款取舍）。
- **移除 `mode: 'append'`**：追加场景由 `edit_file` 匹配文件尾部（`old_string` = 末尾内容，`new_string` = 末尾内容 + 新增）或 shell 重定向表达。消除 append 误用类别，而非规范它。
- schema `mode` 参数删除；契约文本重写为：write_file 用于创建新文件或整文件重写（重写前应先 read_file——对已有文件的重写同样受权限层把关）；小修改一律 edit_file。

### 3. 权限层维持现状（已对齐）

default 需审批 / accept-edits 工作区写入自动放行 / plan 阶段拒绝写入 / 工作区外路径任何模式审批——与 Claude Code 权限模型同构，不作改动。

### 4. 可逆性一等化（accept-edits 的安全底牌）

`write_file` / `edit_file` / `apply_patch` 执行前，将目标文件原像（pre-image）持久化到 checkpoint（复用现有 checkpoint DB 与其清理生命周期）；提供"回滚到上一检查点"的一等操作（对齐 Claude Code 自动 checkpoint + rewind）。

**本条是 §2 不加写入侧拒绝的前提**：没有可逆性，"Write 自由覆写 + 自动放行"的组合不成立。实施次序上 §4 应先于或与 §2 同期落地。

### 5. 展示层：标签从结果推导（保留既有实现）

TUI 工具结果展示反映**实际发生的事**，不回显模型声明的意图：

- 卡片动词由 `writeFileActionName` 从 summary 推导（已实现）。append 移除后收敛为：新建→Create，覆写→Write，内容未变→Write 且显式 no-change；Append 分支退役。
- 该规则固化到 `docs/active/`。

### 6. 批量编辑能力（可选演进）

MultiEdit 风格的一次调用多段替换，解决"同一 turn 对同一文件多次 edit"问题（当前仅契约文字约束）。是否实施取决于 §1 上线后观察到的模型行为数据，不在本决策强制范围。

## 备选方案

- **默认仅创建 + overwrite/append 显式逃生门（本 ADR 前一版草案）**：放弃。三套机制（存在性拒绝、新鲜度校验、逃生门）职责与"edit 侧强制 + 可逆性"重叠，复杂度高；成熟产品已验证更简组合足够。
- **保留 append 模式并收窄（未读警告 + 末尾上下文）**：放弃。Claude Code 以"不存在此功能"消除误用类别；若移除后数据显示 edit 尾部匹配成本过高，可按 ADR 流程恢复。
- **overwrite 侧新鲜度校验（盲覆写标记）**：放弃为独立机制。其防护目标由 §4 可逆性（事后可回滚）与 §1 edit 侧强制（常规修改路径受控）共同覆盖；write_file 整文件重写的残余风险由权限层承担。
- **全量乐观并发（每次写入携带 expected hash）**：拒绝作为默认，摩擦与遵从成本过高。
- **纯契约软约束（当前状态）**：拒绝，即本 ADR 要解决的问题。

## 后果

- `edit_file` 新增会话级读取状态跟踪与两条前置校验；模型初期 edit 失败率上升（未读即改被拒），错误信息引导自纠，形成强制惯例闭环——这是 Claude Code 的设计意图而非缺陷。
- `write_file` schema 删除 `mode` 参数，tool-runner 移除 append 分支与 `Appended …` 摘要格式；展示层 `writeFileActionName` 的 Append 分支退役。
- checkpoint 存储新增文件原像（增量磁盘占用，生命周期随现有 checkpoint 清理）；回滚操作成为新的一等交互。
- 展示层动词推导已实现并有组件级与 e2e 测试覆盖（append 相关用例随 §2 调整）；edit 硬强制、append 移除、checkpoint/rewind 为后续实施项，各实现单独评审，建议次序：§4 → §1 → §2（先有兜底，再加强制，最后收口 schema）。

## 回滚

各规则可独立回退：edit 侧两条校验为工具层开关，禁用后退回当前 old_string 自然校验；append 可按旧 schema 恢复；checkpoint 预像为存储附加项，禁用不影响主流程（但 §2 的无拒绝写入失去兜底，应视为组合回退）；展示层可随时退回静态 `ACTION_NAMES`。
