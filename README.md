# Bun LangGraph 代码 Agent

这是一个基于 Bun、TypeScript、LangGraph.js 和 LangChain 聊天模型适配器构建的独立代码 agent 参考实现。

## 功能

- 使用 LangGraph `StateGraph` 维护 `agent -> approval/user_input/tools -> agent` 循环。
- 支持 `read-only` / `write` 工作区访问权限；只读访问由工具执行层强制，静态系统提示和工具 schema 不随访问权限变化，以提升 provider 前缀缓存命中。
- 支持上下文预算和历史消息压缩摘要。
- 当 provider 元数据暴露缓存 token 计数时，从流式模型响应中提取 prompt cache 指标。
- 使用 Bun 原生 SQLite checkpointer 持久化短期 thread 状态。
- 输出标准化的图事件流，包括 interrupt 和 final 事件。
- 通过 LangGraph `interrupt()` 和 `Command({ resume })` 为受保护工具执行提供人工审批，并为规划不确定性提供用户澄清输入。
- 提供工作区安全的文件 patch 工具和结构化 shell 工具结果。
- 提供真实配置模型的端到端测试入口。

## 源码结构

- `src/app/`：CLI 入口、run/resume 编排和事件流标准化。
- `src/harness/`：LangGraph 控制循环、状态、路由、审批和工具分发。
- `src/model/`：模型适配器工厂、OpenAI-compatible provider 适配、DeepSeek 专用 patch、静态 prompt、运行时上下文和上下文压缩。
- `src/tools/`：模型工具定义，以及文件、shell、patch 工具实现。
- `src/persistence/`：Bun SQLite LangGraph checkpointer。
- `src/config/`：本地 `~/.openpx/openpx.jsonc` 配置加载器。
- `src/shared/`：共享类型和 prompt cache 指标。

## 安装

安装依赖：

```bash
bun install
```

默认模型配置从当前用户目录读取：

```text
~/.openpx/openpx.jsonc
```

示例路径：Windows 为 `C:\Users\<user>\.openpx\openpx.jsonc`，macOS 为 `/Users/<user>/.openpx/openpx.jsonc`，Linux 为 `/home/<user>/.openpx/openpx.jsonc`。

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

为了保持向后兼容，省略 `type` 时，provider 名称 `deepseek` 仍映射为 `deepseek`；其他 provider 名称默认映射为 `openai-compatible`。

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

provider 专有逻辑应保持隔离。例如 DeepSeek 适配器保留 reasoning-content 回传 patch，而普通 OpenAI-compatible provider 应走通用 OpenAI-compatible 适配器。

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

当模型在规划时调用 `ask_user` 并发出 `kind: "user_input"` 的中断事件时，可以传入用户选择或自由文本恢复执行：

```bash
bun run agent resume --thread demo --user local --answer "使用最小实现，暂不支持批量配置"
```

默认情况下，CLI 会把 checkpoint SQLite 文件写入当前工作区的 `.openpx/` 目录。可以用 `--checkpoints` 覆盖路径。

## 测试

默认测试，不包含真实模型/网络套件：

```bash
bun test
```

真实配置模型端到端测试：

```bash
bun run test:real
```

真实测试套件位于 `tests/real-agent.real.ts`，因此不会被 Bun 默认测试发现机制拾取。`test:real` 使用 `--concurrent --max-concurrency 3` 并发运行真实模型用例，以缩短等待时间并避免过高并发压到 provider。它会调用配置的默认模型，覆盖受保护工具审批、文件写入和 checkpoint 数据库检查。脚本会沿用当前 shell 的代理环境；如果网络需要代理或需要取消代理，请在项目脚本外部配置环境变量。
