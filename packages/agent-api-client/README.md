# Kite Agent API Client

## 定位

`@kite-ai/agent-api-client`是browser-safe、request/response-only的本机Agent API typed HTTP client。当前production consumer只有
`apps/kite-web`。

## 拥有职责

- Browser logout；
- ServerInfo capability读取；
- Workspace、Workspace Session、Session、History、Checkpoint list/preview request；
- identifier、page cursor、filter与非负`after_sequence`编码；
- success/Problem Public codec及API version、artifact digest、content type、`no-store`响应校验；
- `AbortSignal`透传。

## 不拥有职责

- 不发现、ensure或停止Service，不读取Native endpoint；
- 不保存cookie、bearer、Workspace path或client state；
- 不实现retry daemon、offline cache、SSE、WebSocket、poll scheduler、generation reducer或恢复策略；
- 不导入Service、Runtime、Host、Store、SQLite、Node或Bun I/O。

## 允许依赖

唯一dependency是browser-safe `@kite-ai/agent-api-contract`。

## 公开入口

只导出根入口`@kite-ai/agent-api-client`。它提供`createAgentApiBrowserClient`、closed method interface与typed error；没有deep export。

## 关键不变量

- fetch固定`credentials: include`、`cache: no-store`、`redirect: error`与`referrerPolicy: no-referrer`；
- Browser凭据只由HttpOnly cookie自动携带，源码不读取或保存cookie；
- `afterSequence`必须是非负safe integer；分页续页只发送cursor，不与`after_sequence`混用；
- response contract header或codec漂移立即失败，不silent fallback。

## 测试

```text
bun run --cwd packages/agent-api-client test
bun run --cwd packages/agent-api-client typecheck
bun run --cwd packages/agent-api-client build
bun run check:agent-api-packages
```

## 文档影响

client operation、认证、分页或错误语义变化更新本README与`docs/active/agent-api-contract.md`；Web消费策略另同步
`apps/kite-web/README.md`。
