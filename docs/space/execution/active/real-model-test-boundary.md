# 当前规则：真实模型测试边界

状态：active
最后更新：2026-04-27
最后验证：2026-04-27
范围：

- 测试发现
- package 脚本
- 真实配置模型端到端套件

读取时机：

- 修改测试命名或 package 测试脚本。
- 修改真实模型套件。
- 修改配置模型 provider 假设。

相关：

- `../completed/2026-04-26-real-model-test-boundary.md`
- `model-provider-boundary.md`

验证：

- `bun test tests/test-discovery.test.ts`
- `bun run typecheck`

## 规则

真实模型或网络端到端套件不能被裸 `bun test` 发现。

这些文件使用非默认后缀，当前为：

```text
tests/real-agent.real.ts
```

只能通过显式脚本运行：

```bash
bun run test:real
```

因为 `.real.ts` 被有意排除在 Bun 默认发现模式外，package 脚本必须传入显式路径：

```bash
bun test --concurrent --max-concurrency 3 ./tests/real-agent.real.ts
```

真实模型用例可以并发运行，但必须限制并发度。当前默认并发度为 3，用于减少等待时间，同时避免一次性把所有真实模型请求打到 provider。

package 脚本应尊重调用者的代理环境。不要增加默认 `env -u ...proxy...` 变体；用户可按本地网络需要在项目脚本外 unset 或配置代理变量。

真实套件在 `tests/real-agent.real.ts` 内按测试设置 timeout，包括多步骤 agent flow 的更长限制。不要依赖 package 级 `--timeout`。

## 理由

默认测试应是确定性的本地测试。真实配置模型套件需要本地凭证、可达网络和可用代理配置。它曾使用 `*.test.ts` 后缀，导致 Bun 默认发现把它纳入 `bun test`，从而让普通验证因为环境问题失败，而不是因为被测代码失败。

## 防护

`tests/test-discovery.test.ts` 断言包含 `real` 的文件不使用 Bun 默认 `*.test.*` / `*.spec.*` 命名模式，默认发现的测试不会直接调用配置聊天模型，并且显式 real-test 脚本指向 `tests/real-agent.real.ts`，使用受限并发，不重写代理环境。
