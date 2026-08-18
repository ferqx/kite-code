# 当前规则：项目约定

状态：active
最后更新：2026-08-18
最后验证：2026-08-18
范围：

- 所有 Markdown 文档与注释
- 测试行为与纪律
- CLI 接口与行为
- Git 提交、分支合并策略与仓库卫生
- TypeScript 类型安全

读取时机：

- 修改文档、注释、测试行为、CLI 或提交规范时。
- CLAUDE.md 中引用本文件作为补充约定的场景。

相关：

- `model-provider-boundary.md`
- `documentation-language.md`
- `docs/space/execution/completed/2026-04-27-harness-engineering-doc-hygiene.md`

验证：

- `bun test tests/docs-space.test.ts`

> CLAUDE.md 之外的补充约定。需要时查阅，不占用每次会话的上下文。

## 文档与注释

- 创建或修改 Markdown 文档以中文为标准；命令、路径、配置键、provider 类型等机器可读 token 保留原文。
- 注释只写在「不看上下文就难以理解」的地方，避免把显而易见的代码翻译成注释。
- 修改文档文件（README、AGENTS.md、注释）时不夹带功能性代码改动（除非任务明确要求）。

## 模型与 Provider

- **模型服务不是 DeepSeek-only**：修改 `src/core/config`、`src/core/model`、真实模型测试或 provider 文档前，先读 `docs/active/model-provider-boundary.md`。
- 不要把真实模型端到端测试当成默认验证手段；只有改动涉及真实模型链路或用户明确要求时才运行。
- 真实模型测试文件命名不能是 `*.test.ts` / `*.spec.ts`，避免裸 `bun test` 误触发。

## 测试纪律

- 不在未说明原因的情况下跳过相关测试。
- 不要为让测试通过而改弱约束；优先修正实现，使行为继续满足既有测试语义。
- 如果现有测试和实现冲突，先确认哪一边表达的是当前真实规则，再决定修改测试还是实现。

## CLI 与接口

- 改了 CLI 行为或参数必须同步更新 `README.md` 和相关测试。

## 仓库卫生

- 不要提交本地 checkpoint、临时文件、密钥配置或 `tests/.tmp-*` 下的运行产物。
- 不要创建 `docs/superpowers/` 或 Superpowers 计划文档；需要当前持久规则时使用 `docs/active/`，计划与执行记录使用 `docs/space/`。
- 不要把 `tests/.tmp-*` 下的文件当成正式源码或稳定夹具。

## 分支合并策略

`man` 是受保护分支：本地 Lefthook 的 `pre-commit` 会拒绝普通直接提交，CI 也会拒绝推送到 `man` 的单父提交。变更必须先在独立分支提交，再通过 Pull Request 合并；合并提交和 cherry-pick 由本地守卫允许，远端仓库仍应将 `man` 配置为禁止直接 push、要求 Pull Request。

Required workflow 的其他独立 job 不改变上述分支控制语义。当前 `model-replay-required` 只运行受批准
manifest 的 keyless/no-egress replay，不接收 credential、不录制 baseline，也不回退真实 Provider；其失败与
其他 Required job 一样阻止合并。Linux runner 在依赖安装后显式安装 `bubblewrap`，仅用它为该 replay
command 建立独立 PID/network namespace、只读必需系统根/checkout/Bun executable 与私有 HOME；这项 CI 依赖不表示 production
sandbox support，也不改变受保护分支的合并规则。

合并远程分支到当前工作分支时，使用 `-X theirs` 确保远程代码不被本地代码覆盖：

```bash
git merge -X theirs origin/<branch> --no-edit
```

- `-X theirs`：冲突时优先采用被合并分支（远程）的版本，避免本地已有代码覆盖远程修复。
- `--no-edit`：使用默认合并信息，不弹出编辑器。
- 合并前先 `git fetch origin <branch>` 确保拿到最新远程提交。
- 合并后必须通过 `bun run typecheck` 零错误验证，远程分支可能带有未修复的类型错误。

## 提交粒度

- 只改完成当前任务所必需的内容，避免顺手重构无关模块。
- 如果只是帮助理解代码而不改变行为，可以只补注释，但不要顺手改写逻辑。

## TypeScript 类型安全

类型断言（`as`）和 `any` 是代码结构设计问题的信号，不是常规编码手段。

### 禁止

- **`as any`**：生产代码中禁止。外部 API 约束导致不可避免时，必须注释说明原因。
- **`as unknown as T` 双重转换**：禁止。应优先使用类型守卫（`in` 操作符、`typeof` 检查、自定义 type guard 函数）。仅在类型守卫不可行且有明确外部约束时允许，必须注释。
- **`catch (e: any)`**：应改为 `catch (e: unknown)`，配合 `e instanceof Error` 或类型守卫处理。`any` 会绕过所有类型检查，丢失错误信息的类型安全。
- **用 `as any` 绕过联合类型收窄**：应提取局部变量使 TypeScript 自动收窄，或用 `if` 守卫区分变体。典型错误：`state.blocks[i].content`（`OutputBlock` 联合类型不保证有 `content`）→ 提取 `const blk = state.blocks[i]; if (blk.kind === "text") blk.content`。
- **用内联 `import()` 规避循环依赖**：`import("@/core/foo").Bar` 不应作为逃避架构问题的手段。如果 `protocol/` 需要引用 `core/` 的类型，说明类型定义放错了层级——应移到 `protocol/`。

### 允许（需注释）

- **`any[]` 缓存变量**：当 `ReturnType<typeof fn>` 导致循环类型引用时，可用 `any[]` 打破循环，但必须注释说明原因。`unknown[]` 会导致返回类型收窄为 `unknown[]`，不可用。
- **外部 SDK 类型不完整时的断言**：如 MCP SDK 返回类型不精确，可断言但需注释标注 SDK 限制。
- **测试中的 mock 断言**：测试代码中 `as unknown as MockType` 可接受，因为 mock 不需要完整实现接口。

### 类型定义层级规则

- **协议层类型**（事件 payload、状态快照接口）定义在 `src/protocol/`，不定义在 `src/core/`。
- **核心层类型**（工具接口、模型类型、配置类型）定义在 `src/core/` 对应模块。
- 依赖方向：`app/` → `core/` → `protocol/`，不允许反向依赖。
- core 层禁止导入 `app/tui/` 的任何符号，禁止做展示层文本格式化（截断+省略号+展示文案）。
- 详细的分层边界强制规则见 `layer-boundary-enforcement.md`。
- 同层模块之间的类型引用用正常 `import`，不用内联 `import()`（除接口字段定义中的紧凑写法外）。

### 模式枚举常量

有限枚举值的业务模式（如 `InteractionMode`、`AuthorizationMode`），禁止在代码中使用裸字符串常量进行判断或赋值。必须通过常量对象引用：

```typescript
// ✅ 正确：使用常量对象
if (state.interactionMode === InteractionMode.Auto) { ... }
dispatch({ type: 'SET_INTERACTION_MODE', mode: InteractionMode.Full });

// ❌ 错误：裸字符串
if (state.interactionMode === 'auto') { ... }
dispatch({ type: 'SET_INTERACTION_MODE', mode: 'full' });
```

模式常量定义在 `src/protocol/events.ts`，使用 `as const` 对象同时提供运行时常量和 TypeScript 类型。如需封装判断逻辑（如"是否为全自动模式"），提炼为函数，例如 `isFullAccessMode()`，不得在各处重复字符串比较。

```typescript
export const InteractionMode = {
  Ask: 'ask',
  Auto: 'auto',
  Full: 'full',
} as const;
export type InteractionMode = (typeof InteractionMode)[keyof typeof InteractionMode];

export function isFullAccessMode(mode: InteractionMode): boolean {
  return mode === InteractionMode.Full;
}
```

> 规则动机：模式名一旦需要改名，只需改常量对象的值，所有引用自动跟随。裸字符串散落在各处会导致改名遗漏和类型不一致。

### 联合类型访问规则

`OutputBlock` 等判别联合类型必须通过 `kind` 收窄后访问特有字段：

```typescript
// ✗ 错误 — TypeScript 无法通过索引访问收窄联合类型
state.blocks[i].content

// ✓ 正确 — 提取局部变量，收窄后访问
const blk = state.blocks[i];
if (blk.kind === "text") blk.content

// ✓ 正确 — 测试中断言已知类型
(state.blocks[0] as { content: string }).content
```

### 检查命令

```bash
bun run typecheck          # 零错误
grep -rn "as any" src/     # 生产代码中应为 0（外部约束除外）
grep -rn ": any" src/      # 仅允许 catch(e: any) 和外部 API 签名约束
```
