# Bun Runtime Kernel 代码 Agent

这是一个基于 Bun、TypeScript 和 Runtime Kernel 的独立代码 agent 参考实现。Kernel 以
`RuntimeEvent` 作为公开执行、重放和持久化协议；模型、工具和用户交互均通过其效果调度器协调。

## 功能

- 使用 Runtime Kernel 维护 `model -> approval/user_input/tools -> model` 循环。
- 支持 `read-only` / `write` 工作区访问权限；只读访问由工具执行层强制，静态系统提示和工具 schema 不随访问权限变化，以提升 provider 前缀缓存命中。
- 支持上下文预算和历史消息压缩摘要。
- 当 provider 元数据暴露缓存 token 计数时，从流式模型响应中提取 prompt cache 指标，并在 `cache_metrics` 事件内附带 coding 场景缓存命中标准评估。
- 使用 Bun 原生 SQLite RuntimeStore 持久化事件、快照与恢复点。
- 输出标准化的图事件流，包括 interrupt 和 final 事件。
- 通过 RuntimeEvent 交互事实为受保护工具执行提供人工审批；审批 payload 包含风险、预期影响和 `approvalHash`。
- 提供工作区安全的文件 patch 工具和结构化 shell 工具结果。
- 模型可见工具表面固定为 `read_file`、`edit_file`、`write_file`、`shell_execute`、`update_plan` 和 `ask_user`。
- `shell_execute` 使用 action envelope 表达命令、意图、目标、预期观察和失败策略；验证命令通过 `intent: "verify"` 表达。
- 文件定位、文本检索、目录查看和 git 只读检查统一通过 `shell_execute` 的 `intent: "inspect"` 承载；没有独立的只读 shell 或文本检索工具。
- 支持当前 thread 内的 shell 授权状态：默认可单次审批或授权同一命令，用户显式开启 `full_access` 后后续 `shell_execute` 不再请求确认。
- 提供真实配置模型的端到端测试入口。

## 源码结构

- `src/app/tui/`：基于 React Ink 的交互式 TUI（OutputArea、App 布局、reducer、键盘快捷键、斜杠命令支持）。
- `src/app/`：CLI 入口、run/resume 编排和事件流标准化。
- `src/core/runtime/`：Kernel、状态、reducer、效果调度、执行器和 RuntimeStore。
- `src/core/model/`：模型适配器工厂、provider 适配、静态 prompt、运行时上下文和上下文压缩。
- `src/tools/`：模型工具定义，以及文件、shell、patch 工具实现。
- `src/core/persistence/`：会话元数据与 RuntimeStore 持久化支持。
- `src/config/`：本地 `~/.kite-code/kite-code.jsonc` 配置加载器。
- `tests/tui-system/`：TUI E2E/PTTY 系统测试套件（真实 PTY + mock model server，覆盖终端启动、输入、Ctrl+C、审批、ask_user、多轮消息）。
- `src/shared/`：共享类型和 prompt cache 指标。

## 安装

安装依赖：

```bash
bun install
```

默认模型配置从当前用户目录读取：

```text
~/.kite-code/kite-code.jsonc
```

示例路径：Windows 为 `C:\Users\<user>\.kite-code\kite-code.jsonc`，macOS 为 `/Users/<user>/.kite-code/kite-code.jsonc`，Linux 为 `/home/<user>/.kite-code/kite-code.jsonc`。

配置结构使用命名 provider 和默认模型：

```jsonc
{
  "provider": {
    "my-provider": {
      "type": "openai-compatible",
      "apiKey": "sk-...",
      "baseURL": "https://example.com/v1"
    }
  },
  "model": {
    "default": {
      "provider": "my-provider",
      "name": "provider-model-name"
    }
  }
}
```

本项目不是 DeepSeek-only。DeepSeek 只是一个受支持的 provider。除非正在处理 provider 专有行为，否则新的模型相关改动应保持通用 OpenAI-compatible 边界。

支持的 provider `type` 值：

- `deepseek`：使用 `@langchain/deepseek`，并保留 DeepSeek reasoning-content patch。
- `openai`：使用 `@langchain/openai` 访问配置的 OpenAI API base URL。
- `openai-compatible`：使用 `@langchain/openai` 访问任意兼容 OpenAI API 的 base URL。
- `ollama`：使用 `@langchain/ollama` 的 `ChatOllama` 访问 Ollama 原生 API；省略 `apiKey` 时不使用密钥，省略 `baseURL` 时使用 `http://localhost:11434`。

为了保持向后兼容，省略 `type` 时，provider 名称 `deepseek` 仍映射为 `deepseek`，provider 名称 `ollama` 映射为 `ollama`；其他 provider 名称默认映射为 `openai-compatible`。

当需要 DeepSeek 适配器专有行为时，可以这样配置：

```jsonc
{
  "provider": {
    "deepseek": {
      "type": "deepseek",
      "apiKey": "sk-...",
      "baseURL": "https://api.deepseek.com/v1"
    }
  },
  "model": {
    "default": {
      "provider": "deepseek",
      "name": "deepseek-chat"
    }
  }
}
```

provider 专有逻辑应保持隔离。例如 DeepSeek 适配器保留 reasoning-content 回传 patch，Ollama 适配器走 `@langchain/ollama`，普通 OpenAI-compatible provider 走通用 OpenAI-compatible 适配器。

使用本地 Ollama 时，可以先拉取需要的模型，再用最小配置指向本地服务：

```bash
ollama pull qwen2.5-coder:7b
ollama serve
```

```jsonc
{
  "provider": {
    "ollama": {}
  },
  "model": {
    "default": {
      "provider": "ollama",
      "name": "qwen2.5-coder:7b"
    }
  }
}
```

## 运行

启动一次任务：

```bash
bun run agent run --thread demo --user local --task "Create hello.txt with exact content \"hello\""
```

默认 `auto` 使用 `write` 工作区访问权限，由模型自主决定是否调用 `update_plan`。如需强制只读访问，可使用 `--mode read-only`，也可以继续使用兼容入口 `--mode plan` 或任务前缀 `/plan`：

```bash
bun run agent run --mode read-only --thread demo --user local --task "Inspect the change and propose a plan"
```

`read-only` 访问状态会作为尾部合成运行时消息注入，而不是切换另一套 system prompt。只读访问下写入、删除和执行类工具即使被模型调用也会被工具执行层拒绝；`write` 访问下这些受保护工具仍需要审批。`--mode plan` / `--mode builder` 是兼容旧入口，内部会分别映射到 `read-only` / `write`。

当事件流发出受保护工具的 `interrupt` 事件时，可以审批并恢复执行：

```bash
bun run agent resume --thread demo --user local --approve
```

推荐把 interrupt 中的 `approval.approvalHash` 一并带回，确保恢复时审批的是同一个工具请求：

```bash
bun run agent resume --thread demo --user local --approve --approval-hash "<hash-from-interrupt>"
```

如果需要调整待执行命令，可以在同一次恢复中替换命令。替换后的命令仍会经过工具安全策略判定：

```bash
bun run agent resume --thread demo --user local --approve --approval-hash "<hash-from-interrupt>" --replace-command "bun test tests/graph.test.ts"
```

如果希望当前 thread 后续重复执行完全相同的 shell 命令不再请求确认，可以使用同命令授权。匹配规则是同一 workspace/thread 下 `command.trim()` 完全一致，和模型解释文本或 `prefix_rule` 无关：

```bash
bun run agent resume --thread demo --user local --approve-same-command --approval-hash "<hash-from-interrupt>"
```

如果用户明确允许当前 thread 后续所有 `shell_execute` 命令直接执行，可以开启 `full_access`。该授权只保存在当前 thread checkpoint 中，新 thread 不继承；开启后包括原本 destructive 分类的 shell 命令也不会再进入审批或默认拒绝：

```bash
bun run agent resume --thread demo --user local --full-access --approval-hash "<hash-from-interrupt>"
```

当模型在规划时调用 `ask_user` 并发出 `kind: "user_input"` 的中断事件时，可以传入用户选择或自由文本恢复执行：

```bash
bun run agent resume --thread demo --user local --answer "使用最小实现，暂不支持批量配置"
```

默认情况下，CLI 会把 checkpoint SQLite 文件写入当前工作区的 `.kite-code/` 目录。可以用 `--checkpoints` 覆盖路径。

### 缓存命中标准

`cache_metrics` 事件以 provider 返回的 token 计数为事实来源。DeepSeek 返回的 `prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens` 会被归一化为 `cacheHitTokens`、`cacheMissTokens` 和 `hitRate`。

事件内的 `standard` 字段用于判断 coding 场景是否达到缓存目标：

- 目标命中率为 `0.95`。
- 每个 run / resume 流的第一条缓存指标视为 warmup，不计入达标判断。
- 计入标准的输入 token 累计至少达到 `8000` 后才判断是否达标；样本不足时 `meetsTarget` 为 `null`。
- 后续指标按 token 加权累计，使用 `cacheHitTokens / inputTokens` 计算汇总命中率。
- `standard.summary.meetsTarget` 在没有足够计入样本时为 `null`，样本足够后表示当前累计结果是否达到目标。

## 测试

默认测试，不包含真实模型/网络套件和 PTY 系统套件：

```bash
bun test
```

TUI E2E/PTTY 系统测试（真实终端 + mock server，无需 API 密钥）：

```bash
bun run test:e2e
```

```bash
bun run test:tui:system
```

PTY 层覆盖真实终端启动、输入链路、Ctrl+C、审批、ask_user 和同 session 多轮消息。旧 `tests/tui-integration/` e2e harness 已退役；组件级 Ink 单测仍保留在 `tests/tui-*.test.tsx`。

真实配置模型端到端测试：

```bash
bun run test:real
```

可以在运行真实测试时临时覆盖默认 provider 和模型。除内置 `ollama` provider 会使用本地默认连接参数外，provider 名称必须已经存在于 `~/.kite-code/kite-code.jsonc` 的 `provider` 配置中；命令行只覆盖选择哪个 provider 和哪个模型，不传递密钥：

```bash
bun run test:real --provider=ollama --model=gemma4:31b-cloud
```

`bun test` 本身不会把自定义 `--provider` / `--model` 参数暴露给测试文件，因此 provider/model 覆盖必须通过 `bun run test:real` 入口传入。

真实测试套件位于 `tests/real-agent.real.ts`，因此不会被 Bun 默认测试发现机制拾取。`test:real` 入口会解析 `--provider` 和 `--model`，再用 `--concurrent --max-concurrency 3` 启动真实模型用例，以缩短等待时间并避免过高并发压到 provider。它默认调用配置的默认模型；传入 `--provider` 或 `--model` 时使用命令行覆盖后的模型。真实套件覆盖当前全部模型可见工具：`read_file`、`edit_file`、`write_file`、`shell_execute`、`update_plan` 和 `ask_user`，同时覆盖受保护工具审批、shell 授权和 checkpoint 数据库检查。脚本会沿用当前 shell 的代理环境；如果网络需要代理或需要取消代理，请在项目脚本外部配置环境变量。
