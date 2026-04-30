# Space 索引

最后更新：2026-04-30

这是 `docs/space/` 的导航入口。默认不要读取所有记录；应根据下面的范围和“读取时机”只拉取当前任务需要的上下文。

`docs/space/` 不存储每次运行的 `graph.state.plan`。运行时计划仍属于 checkpoint 状态；本索引只跟踪持久项目记录。

状态含义：

- `active`：当前有效规则，会约束其范围内的改动。
- `completed`：历史实现记录和验证证据。
- `understanding`：设计背景或理由。
- `reference`：外部资料摘要。
- `generated`：派生材料，权威性较低。

## 当前规则记录

| 记录 | 状态 | 范围 | 读取时机 |
| --- | --- | --- | --- |
| `execution/active/plan-state-reminder.md` | active | 模型上下文构建、计划投影、缓存敏感 prompt 布局 | 修改 `src/model/context.ts`、`src/model/runtime-context.ts`，或修改计划/上下文投影相关测试。 |
| `execution/active/model-provider-boundary.md` | active | 模型 provider 配置、适配器、provider 专有行为、真实配置模型测试 | 修改 `src/config`、`src/model`、provider 文档或真实模型套件。 |
| `execution/active/tool-gated-autonomy.md` | active | 图路由、审批边界、工具 gating、最终答案自主性 | 修改 `src/harness/graph.ts`、`src/harness/routes.ts`、`src/harness/tool-policy.ts`、`src/harness/tool-runner.ts`，或修改审批/最终路由相关测试。 |
| `execution/active/real-model-test-boundary.md` | active | 测试发现、真实模型端到端套件、package 脚本 | 修改测试命名、`package.json` 测试脚本或真实模型套件。 |
| `execution/active/documentation-language.md` | active | 文档语言、Markdown 内容标准、文档测试 | 创建或修改 README、AGENTS、`docs/space` 或其他 Markdown 文档。 |

## 理解记录

| 记录 | 状态 | 用途 |
| --- | --- | --- |
| `understanding/space-system-design.md` | understanding | 定义 `docs/space` 如何作为仓库本地记录系统工作。 |
| `understanding/2026-04-26-plan-state-context-projection.md` | understanding | 解释为什么将 `graph.state.plan` 作为运行时状态投影，而不是依赖工具消息历史或 system prompt。 |

## 完成执行记录

| 记录 | 状态 | 用途 |
| --- | --- | --- |
| `execution/completed/2026-04-26-plan-state-reminder.md` | completed | 记录把计划状态移动到尾部合成用户侧提醒的实现和验证。 |
| `execution/completed/2026-04-26-remove-stop-check.md` | completed | 记录移除最终答案 stop-check 和非危险模式确认门。 |
| `execution/completed/2026-04-26-remove-internal-ledgers.md` | completed | 记录移除 evidence/progress 账本和 watchdog 式进度推断。 |
| `execution/completed/2026-04-26-real-model-test-boundary.md` | completed | 记录真实模型测试从 Bun 默认发现中隔离，以及显式真实测试脚本修复。 |
| `execution/completed/2026-04-27-harness-engineering-doc-hygiene.md` | completed | 记录 `docs/space` 索引和生成文档边界的默认测试覆盖。 |
| `execution/completed/2026-04-27-documentation-language-standard.md` | completed | 记录仓库 Markdown 文档以中文为标准，并增加中文元数据检查。 |

## 参考资料

| 记录 | 状态 | 来源 |
| --- | --- | --- |
| `references/openai-harness-engineering.md` | reference | OpenAI 关于 Codex harness engineering 和仓库知识系统的文章。 |
| `references/opencode-codex-plan-handling.md` | reference | Opencode 与 Codex 计划处理方式的本地对比。 |

## 生成材料边界

| 记录 | 状态 | 用途 |
| --- | --- | --- |
| `generated/README.md` | generated | 定义生成材料的较低权威性和晋升规则。 |

## 维护规则

- 保持 `AGENTS.md` 简短，把它作为指向本索引的地图。
- 可能影响未来实现的记录必须包含状态、范围、相关记录和验证说明。
- 只有在形成具体本地规则，并且可行时配套测试后，才能把 generated 或 reference 记录晋升到 `execution/active/`。
- 退役过期 active 规则时，应更新记录状态，必要时移出 active，并补充说明理由的 completed 记录。
