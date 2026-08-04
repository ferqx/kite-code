# TUI Overlay 统一设计系统实施计划

状态：archived
优先级：P1
创建日期：2026-08-04
来源：MCP Overlay 视觉审查与统一弹层预览方案
依赖：现有 `OverlayFrame`、`OverlayChoiceList`、`useOverlayHeight`

## 一、目标与验收

把当前“共享外框、页面自行布局”的 Overlay 实现收敛为一套稳定的 TUI 弹层设计系统。首个迁移对象是
`/mcp`，随后覆盖会话、模型、恢复点、帮助、斜杠建议以及审批/问答类弹层。

完成后必须满足：

1. Overlay 固定为标题区、内容区、消息区（可选）和快捷键区，不由页面重复制造外层留白；
2. 列表统一选择指示列、主文案、次级文案、尾部状态列、选中背景和分组标题；
3. 列表、详情、表单、确认、空态五类页面具有明确且可复用的布局 primitive；
4. 相同交互统一使用“导航、打开、选择、确认、继续、返回、关闭”，Esc 文案与实际 route 语义一致；
5. MCP 列表的 Server 名称和连接状态是主信息，配置路径与 capability 数量降为次级信息并安全截断；
6. 宽终端、窄终端、长路径、中英文宽字符、多状态切换和低高度视口均有 component 或 PTY 覆盖；
7. 不改变 MCP control-plane、配置 mutation、认证、审批、会话或 Runtime 行为。

## 二、范围与非目标

### 2.1 范围

- `OverlayFrame` 的区域 contract 与统一 spacing；
- 通用 section、list row、detail table、message、empty state 和 shortcut bar；
- MCP Overlay 的视图拆分与布局迁移；
- Model、Session、Checkpoint、Help、Slash Suggestion 的列表迁移；
- Approval、Plan Review、InputBlock 中 Overlay 表面的词汇和间距收敛；
- 视觉 contract 测试、真实 PTY 关键路径和对应 TUI 文档。

### 2.2 非目标

- 不改变颜色主题体系或重新设计整个 TUI；
- 不增加鼠标、全屏 alternate screen、浮动窗口或动画框架；
- 不改变快捷键绑定、业务 route、MCP 状态派生或 Core API；
- 不在本计划中重做 first-run/setup wizard；其独立 `FirstRunShell` 暂不并入 Overlay 系统；
- 不通过固定终端宽高实现像素级布局。

## 三、设计契约

### 3.1 Overlay 骨架

```text
── Title ───────────────────────── Meta ──

  Content
  Optional message

  ↑↓ Navigate  Enter Open  Esc Close
```

`OverlayFrame` 是外层垂直节奏的唯一所有者：

- Frame 与前序终端内容之间保留 1 行；
- 标题与内容之间保留 1 行；
- 内容与可见消息、快捷键之间各保留 1 行；
- Frame 统一提供水平 content inset；页面根节点不得再补同类 `marginTop`/`paddingX`；
- 不用渲染单空格 Text 的方式占据消息行；无消息时该区域不存在；
- `meta` 只承载位置、模式或短状态，不承载路径和说明正文。

### 3.2 内容 primitive

建议形成以下 App-only 组件；命名可以在 Task 1 spike 后微调，但职责不得重新散回业务页面：

| Primitive | 责任 | 禁止承载 |
| --- | --- | --- |
| `OverlaySection` | 分组标题和组间距 | 业务状态推导 |
| `OverlayList` | 可视窗口、selection 与统一行 contract | route/command 解释 |
| `OverlayListRow` | 指示列、主/次文案、尾部状态 | Core 类型 |
| `OverlayDetailList` | 对齐 label/value、换行与截断 | secret/raw error |
| `OverlayMessage` | info/warning/error/busy 文案 | 空白高度占位 |
| `OverlayEmptyState` | 空态文案和可选 primary action | 页面专属 padding |
| `OverlayShortcutBar` | 统一键名、顺序和折行 | 实际 input handler |

现有 `OverlayChoiceList` 应迁移到 `OverlayList` contract，或成为它的 action-list preset，避免普通列表、
操作列表和确认列表继续形成不同的箭头、缩进和高亮实现。

### 3.3 列表行 contract

```text
  [2 cols indicator] [flex main] [optional fixed status]
                     [secondary line]
```

- 主行只放可识别对象与关键状态；
- 路径、时间、数量、来源等放次级行；
- 长字段使用 display width 感知的尾部截断，不挤占选择指示和状态列；
- 默认选中项使用主题背景；危险项仍保留同一选中背景，并用 error 色表达危险；
- heading 不可选择，不参与可操作项编号；
- 列表有 active/current 标记时统一使用 `OverlayStatusColumn`，窄宽度可降到次级行。

### 3.4 页面类型

| 页面类型 | 内容顺序 | 默认焦点 |
| --- | --- | --- |
| List | 可选摘要 → section/list → primary action | 当前项，否则首个可操作项 |
| Detail | detail list → actions | 首个安全可用操作 |
| Form | 提示/label → input/options → validation message | 当前输入或当前选项 |
| Confirm | 影响摘要 → choices | Cancel/返回等安全项 |
| Empty | 单一说明 → 可选 primary action | primary action 或 Esc |

### 3.5 词汇与 Esc 语义

| 行为 | 中文 label | 使用场景 |
| --- | --- | --- |
| move selection | 导航 | 所有可选择列表 |
| open route | 打开 | 列表进入详情 |
| choose option | 选择 | 详情操作菜单 |
| execute decision | 确认 | 会产生决定或副作用 |
| next form step | 继续 | 多步表单 |
| pop nested route | 返回 | 子页面回到父页面 |
| dismiss root overlay | 关闭 | 关闭最外层 Overlay |

“取消”只用作可见 choice 或确实取消业务过程的动作，不再作为根 Overlay 的 Esc 提示。

## 四、实施任务

### Task OVL-1：建立 contract 测试与基础 primitive

状态：completed（2026-08-05）

- 为现有主要 Overlay 建立迁移前 component contract，记录 route、按键和业务文案而非锁死所有空格；
- 扩展 `OverlayFrame`，由它统一 title/content/message/footer 区域和 spacing；
- 建立 section、list row、detail、message、empty-state primitive；
- 将 `OverlayChoiceList` 收敛为统一 list contract 的 preset；
- 补齐 display-width 截断和窄宽度降级测试。

验证：

```bash
bun test tests/overlay-frame.test.tsx tests/overlay-choice-list.test.tsx
bun run typecheck
```

如果新测试文件最终按组件合并命名，应同步更新命令，不得省略对应 contract。

### Task OVL-2：迁移 MCP 列表与拆分视图组件

状态：completed（2026-08-05）
依赖：OVL-1

- 将 `McpOverlay.tsx` 中 list、detail、tools、tool detail、add、auth、approval、confirm 拆成同目录的纯视图组件；
- Overlay 宿主继续拥有 route、selection、draft、input 和 controller command 编排；
- Server list 改为名称/状态主行，source path/capability 次级行；
- 移除数量行、列表前留白、空白状态 Text 等重复结构；
- Add 作为列表末尾 primary action，与 Server 分组保持一个 section 间距；
- 保持稳定 option id、动态 selection、busy minimum duration 和 layered Esc 行为。

验证：

```bash
bun test tests/mcp-panel.test.tsx
bun test --parallel=1 --max-concurrency=1 tests/tui-system/scenarios/mcp-management-readonly.test.ts tests/tui-system/scenarios/slash-commands.test.ts
bun run typecheck
```

### Task OVL-3：迁移 MCP 详情、表单与确认 route

状态：completed（2026-08-05）
依赖：OVL-2

- Detail 使用统一 label/value contract，路径和 endpoint 正确换行或截断；
- Tools 与 Tool Detail 使用统一 list/detail primitive；
- Add 五步统一表单结构、validation message 和“继续/返回”；
- Authentication、Project Approval、Disable、Remove 使用统一 message 与 confirm preset；
- 危险操作默认选择安全项，busy 或 snapshot message 不再制造固定空行；
- 不改变 controller 调用、expected revision、digest、credential cleanup 或后台连接语义。

验证：

```bash
bun test tests/mcp-panel.test.tsx tests/mcp-config-repository.test.ts tests/mcp-project-approval.test.ts
bun test --parallel=1 --max-concurrency=1 tests/tui-system/scenarios/mcp-project-approval.test.ts tests/tui-system/scenarios/mcp-authentication.test.ts
bun run typecheck
```

### Task OVL-4：迁移通用选择与浏览 Overlay

状态：completed（2026-08-05）
依赖：OVL-1

- 迁移 ModelSelector、SessionSelector、CheckpointSelector、SlashSuggestionOverlay 和 HelpPanel；
- 删除页面本地复制的 indicator、selected background、外层 margin 和基础 status column 布局；
- 保留 Session 虚拟列表、搜索状态和删除确认的业务状态机；
- 保留 Slash Suggestion 的动态列计算，但让行外观遵循统一 contract；
- 帮助页使用 section/detail-row preset，不把可滚动行误作可选择列表。

验证：

```bash
bun test tests/model-selector.test.tsx tests/session-selector.test.tsx tests/checkpoint-selector.test.tsx
bun test tests/tui-system/scenarios/slash-commands.test.ts
bun run typecheck
```

实际测试文件名以仓库已有文件为准；Task 开始时先解析并固定定向命令。

### Task OVL-5：收敛交互型 Overlay 与词汇

状态：completed（2026-08-05）
依赖：OVL-1、OVL-4

- 迁移 ApprovalBlock、PlanReviewBlock、InputBlock 和 InputLine 中的 Overlay 表面；
- 统一 footer 顺序为 move/input → primary → secondary/back/close；
- 按 3.5 统一中文 label，确保文字与 handler 语义一致；
- 审批、问答和 plan review 的取消/拒绝语义保持现状，不把视觉整理变成 Runtime 行为变化；
- 对窄终端下 shortcut wrap 和中英文宽字符进行 PTY 验证。

验证：

```bash
bun test tests/approval-block.test.tsx tests/plan-review-block.test.tsx tests/input-block.test.tsx
bun run typecheck
```

### Task OVL-6：文档、全量回归与完成记录

状态：completed（2026-08-05）
依赖：OVL-2、OVL-3、OVL-4、OVL-5

- 在 `docs/active/` 新增 TUI Overlay 当前 contract，更新 book 07/08 的 UI 结构与交互词汇；
- 按 `docs/documentation-map.json` 校正文档影响范围；
- 运行 TUI component、PTY、类型、格式、边界和文档门禁；
- 记录窄/中/宽终端的验收证据并创建完成记录；
- 将本计划更新为 archived，并更新计划注册表。

验证：

```bash
bun run typecheck
bun run check:core-boundary
bun run check:docs-impact
bun run check:docs
git diff --check
```

提交、推送或创建 PR 前，必须完整执行项目 `document-before-commit` Skill。定向测试或文档门禁失败时，
不得提交，也不得把本计划标记为完成。

## 五、Task 执行矩阵

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| OVL-1 | — | Overlay frame/list/section/detail/message primitives 与 contract tests | Overlay component tests、typecheck | 先保持现有 props adapter；可逐组件回退 |
| OVL-2 | OVL-1 | MCP list 与视图组件拆分 | MCP panel、只读管理 PTY | 不动 controller/Core；可恢复旧 renderer |
| OVL-3 | OVL-2 | MCP detail/form/confirm 迁移 | MCP component、approval/auth PTY | route 与 command 保持；可按 route 回退 |
| OVL-4 | OVL-1 | Model/Session/Checkpoint/Slash/Help 迁移 | 对应 component、slash PTY | 每个 Overlay 独立迁移和回退 |
| OVL-5 | OVL-1、OVL-4 | Approval/Plan/Input Overlay 与词汇统一 | 交互 component、typecheck | 不改 Runtime 结果；按表面回退 |
| OVL-6 | OVL-2、OVL-3、OVL-4、OVL-5 | active/book/map/完成记录与全量门禁 | docs-impact、docs、boundary、diff | 文档随最终实现同步；未收敛则 blocked |

## 六、实施顺序与并行边界

```text
OVL-1 ──┬── OVL-2 ── OVL-3 ──┐
        └── OVL-4 ── OVL-5 ──┼── OVL-6
```

OVL-2/3 与 OVL-4/5 可在 OVL-1 contract 固定后并行，但不得同时修改同一个基础 primitive。基础 contract
如需变更，必须先回到 OVL-1 更新测试，再继续迁移，避免由某个业务页面反向塑造全局 API。

## 七、风险与回滚

| 风险 | 控制 |
| --- | --- |
| Ink/Yoga 空白行或高度计算变化 | component frame + 真实 PTY 双层验证，覆盖低高度终端 |
| 文案变更导致脆弱断言大量失败 | 先区分行为断言与视觉 contract；不降低关键文案覆盖 |
| 通用 List API 被业务需求污染 | primitive 只接收展示中立 row model，route/controller 留在页面 |
| MCP 拆分引入 stale closure 或 selection 回归 | 宿主保留状态与 input 编排，视图保持纯渲染 |
| 长路径和宽字符破坏列对齐 | 统一使用 display-width 工具并增加中英文/emoji case |
| 一次性迁移过大 | 按 Task 独立验证；adapter 在最终收敛前保留 |

本计划不需要 Runtime feature flag。开发中保持旧 props adapter，使每个 Overlay 可以独立迁移；若某一迁移失败，
回退该页面 renderer 即可，不回退已经稳定的基础 primitive。合并态不得长期保留两套同义 List 组件。
