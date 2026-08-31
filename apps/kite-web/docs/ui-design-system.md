# Kite Web UI Design System

状态：active

读取时机：修改Web全局样式、布局、主题、Sidebar、Timeline、状态反馈、可访问性或新增展示组件时。

验证：`bun run --cwd apps/kite-web typecheck`、`bun run --cwd apps/kite-web test`、
`bun run --cwd apps/kite-web build`，以及1280×800、1024×768、390×844的Light/Dark真实Browser检查。

## 产品气质

Kite Web采用“Quiet Technical Workspace”：技术上精确，视觉上安静，阅读上温和。它借鉴成熟AI产品共同的内容优先、低干扰、
语义化状态和自适应布局原则，但不复制任何公司的Logo、字体、品牌色或trade dress。

参考边界：

- OpenAI Design Guidelines中的“技术精确与人性化温度”只作为排版和气质参考；不得使用其商标与品牌资产。
- Fluent 2的Built for focus、平台自然适配、global/alias token分层与无障碍原则用于系统化约束。
- Material 3的adaptive layout、component state与motion原则用于响应式和交互完整性；Kite不采用高饱和Expressive外观。

## 设计原则

1. **内容先于容器**：Session History是主视觉，边框和卡片只用于表达真实分组。
2. **层级来自空间**：优先用间距、字号、字重和surface层级，不用连续分割线制造后台管理感。
3. **状态必须可读**：connected、running、waiting、failed、read-only同时使用文字、图标和语义色，不能只靠颜色。
4. **密度服务扫描**：目录使用紧凑密度，正文使用舒适行高；同一页面不强迫所有区域共享一种密度。
5. **渐进披露**：Thinking、Tool result与Checkpoint metadata可以折叠，但关键失败和当前状态不能隐藏。
6. **确定性视图**：相同数据状态产生相同DOM层级，不使用随机布局、不可读Canvas或只在hover中出现的关键能力。
7. **主题同源**：Light/Dark使用相同semantic token，不在组件中硬编码主题颜色。

## 信息架构

当前只读产品保持双栏，不为尚未实现的控制能力预留空Inspector：

```text
304px Workspace / Session directory | fluid Session header + History / Runtime logs tabs
```

- Desktop ≥ 1024px：304px Sidebar；中等宽度降为272px。
- Mobile < 768px：Sidebar进入modal drawer；主Timeline保持单列。
- Timeline正文最大宽度780px，长工具输出在自身容器内滚动。
- Runtime logs正文最大宽度980px；摘要优先扫描，展开后显示事件含义、原始event type、sequence、时间、分类、状态与安全字段。
- Model Context使用有真实prepared invocation消费者的临时右侧modal Inspector；不预留常驻通用Inspector栏，也不为未来Checkpoint/Run
  控制能力增加空面板。

## Semantic tokens

组件只能消费语义名，不能直接消费品牌或灰阶编号。

| Domain | Tokens | 用途 |
| --- | --- | --- |
| Surface | `canvas/sidebar/surface/surface-subtle/surface-raised/surface-selected/overlay` | 页面、导航、卡片、选中和modal遮罩 |
| Text | `foreground/copy/muted-foreground/terminal-copy` | 标题、正文、辅助文字和代码输出 |
| Stroke | `border/border-strong/ring` | 普通边界、选中边界和键盘焦点 |
| Action | `accent/accent-foreground` | 品牌动作与选中强调；每屏避免多个竞争accent |
| Status | `running/info/warning/danger` | 运行、信息、降级和失败 |
| Elevation | `shadow-soft` | 选中卡片与必要强调；普通页面不使用大面积阴影 |

基础间距遵循4px网格；常用半径为8、10、12、16px。Pill只用于状态，不用于普通按钮或所有容器。

## Component grammar

- **Product mark**：单色前景块，不使用渐变、霓虹或第三方AI品牌符号。
- **Workspace trigger**：一行结构，图标、名称和数量对齐；展开不是独立卡片。
- **Session row**：选中使用surface、strong border和3px accent inset；running额外显示状态色。名称固定单行ellipsis，item不得把
  ScrollArea固有宽度撑大；完整名称继续由accessible name与`title`提供。
- **Header**：Session identity优先；连接状态是有文字的status chip；Docs与Theme保持次级。Browser session随页面生命周期自动清理，
  不提供刷新后立即重建连接的手动Disconnect动作。
- **User message**：使用轻量surface bubble，宽度不超过正文的88%。
- **Agent message**：开放布局，减少重复容器，让长答案形成连续文档。
- **Thinking/Tool**：Thinking使用subtle surface；Tool activity使用info tint；Tool result使用terminal surface。
- **Session tabs**：History是默认阅读视图；Runtime logs是按需诊断视图。Tab必须使用`tablist/tab/tabpanel`语义并显示明确文字。
- **Log row**：收起态显示sequence、event type、category、status、时间和摘要；展开态同时提供人类可读解释与原始字段名，长字段在自身
  terminal surface内滚动，不把任意JSON直接倾倒到页面。
- **Model Context Inspector**：由prepared model invocation显式打开右侧modal Inspector；顶部始终标识`Local diagnostic`，内容分为Overview、
  System prompt、Messages、Tools与Request settings。Prompt、message part与tool schema使用可滚动terminal surface；任何truncation必须显示文字提示。
  Inspector支持Escape、backdrop与Close按钮关闭，关闭后不保留第二份context state。
- **Empty/Error**：一个图标、一个标题、一段说明、至多一个主要动作。

## Agent-operable view contract

GUI未来允许Agent操控时，视图层必须保持：

- 交互元素具备稳定role、accessible name和当前状态；图标按钮必须有`aria-label`。
- 选择态使用`aria-current`，drawer使用`aria-expanded`，连接降级使用`role=status`。
- 关键动作不能仅在hover后出现；颜色不是唯一状态信号。
- loading、empty、error、selected、disabled和connected在DOM中有可读取的文本事实。
- motion不改变事实顺序；`prefers-reduced-motion`下所有非必要动画近似关闭。
- 不把Agent需要理解的数据画进Canvas，不使用坐标作为主要交互identity。

## 非目标

- 本阶段不新增Browser mutation、prompt输入、Session create、Run control或持久UI偏好。
- 不引入第二套component framework、CSS-in-JS runtime、外部字体下载或远程设计资产。
- 不为Desktop、mobile native、通用Inspector或未来控制面预建空抽象；Model Context Inspector只服务当前明确的诊断consumer。
