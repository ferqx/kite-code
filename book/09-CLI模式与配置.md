# 第九章 CLI 模式与配置系统

## 9.1 CLI 入口

CLI 提供 `run`（首次运行）和 `resume`（恢复运行）两种模式，适合脚本/CI 场景。

### 用法

```bash
# 首次运行
openpx run "帮我重构这个函数" --workspace ./my-project

# 恢复运行（从 checkpoint）
openpx resume --thread-id run-abc123 --action approve --grant full-access
```

### CLI 与 TUI 的区别

| 维度 | CLI | TUI |
|------|-----|-----|
| 事件消费 | NDJSON 输出到 stdout | React Ink 渲染 |
| 用户输入 | stdin 读取 | 交互式 UI |
| 会话管理 | 单次运行 | 多会话并发 |
| 适用场景 | CI/CD、脚本 | 日常开发 |

## 9.2 配置系统

### 配置文件位置

| 文件 | 位置 | 用途 |
|------|------|------|
| 全局配置 | `~/.openpx/openpx.jsonc` | 模型、provider、MCP 服务器 |
| 项目配置 | `<workspace>/.openpx/openpx.jsonc` | 项目级覆盖 |

### 配置 Schema

```jsonc
{
  // Provider 配置（支持多个）
  "provider": {
    "deepseek": {
      "type": "deepseek",
      "apiKey": "sk-...",
      "models": [
        { "name": "deepseek-chat", "default": true },
        { "name": "deepseek-reasoner" }
      ]
    },
    "openai": {
      "type": "openai",
      "apiKey": "sk-...",
      "models": [{ "name": "gpt-4o" }]
    },
    "ollama": {
      "type": "ollama",
      "baseURL": "http://localhost:11434",
      "models": [{ "name": "llama3" }]
    }
  },

  // 主题
  "theme": "dark",  // "dark" | "light"

  // MCP 服务器
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "risk": "read"
    },
    "github": {
      "type": "http",
      "url": "https://mcp.github.com/sse",
      "headers": { "Authorization": "Bearer ..." },
      "timeout": 30000  // 可选：单次工具调用超时（毫秒）
    }
  }
}
```

### 多 Provider 支持

| Provider | 类型 | 模型适配器 |
|----------|------|-----------|
| DeepSeek | `deepseek` | `@langchain/deepseek` ChatDeepSeek |
| OpenAI | `openai` | `@langchain/openai` ChatOpenAI |
| OpenAI-compatible | `openai-compatible` | ChatOpenAI (自定义 baseURL) |
| Ollama | `ollama` | `@langchain/ollama` ChatOllama |

### 配置加载流程

```
loadAgentConfig()
  → 读取 ~/.openpx/openpx.jsonc（全局）
  → 读取 <workspace>/.openpx/openpx.jsonc（项目级，覆盖全局）
  → Zod schema 校验
  → 返回 AgentConfig
```

## 9.3 路径管理

| 路径 | 用途 |
|------|------|
| `~/.openpx/openpx.jsonc` | 全局配置 |
| `~/.openpx/checkpoints.db` | SQLite checkpoint 数据库 |
| `~/.openpx/sessions/<date>.md` | 导出的会话文件 |
| `<workspace>/.openpx/openpx.jsonc` | 项目配置 |
| `<workspace>/.openpx/skills/` | 项目级 Skills 目录 |
| `~/.openpx/skills/` | 用户级 Skills 目录 |
