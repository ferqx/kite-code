# 完成记录：真实模型测试边界

日期：2026-04-26
状态：completed
相关 active 规则：`../active/real-model-test-boundary.md`

## 变更

将真实配置模型端到端套件移出 Bun 默认测试发现范围，并修复显式真实测试脚本。记录写成时本地配置 provider 是 DeepSeek；当前 active 规则已经改为 provider-neutral。

实现形态：

- 将 `tests/real-agent.test.ts` 重命名为 `tests/real-agent.real.ts`。
- 更新 `test:real`，以显式 Bun 路径传入套件：`./tests/real-agent.real.ts`。
- 移除会 unset 代理的 `test:real:direct` 变体。项目脚本应尊重调用者的代理环境。
- 移除 package 级 `--timeout`；真实套件在需要更长时间的场景旁按测试设置 timeout。
- 新增 `tests/test-discovery.test.ts` 断言：
  - 默认测试文件不包含 `real` 套件。
  - 默认测试文件不直接调用 `createDeepSeekModel(...)`。
  - 显式真实测试脚本指向 `./tests/real-agent.real.ts`。
- 更新 `README.md` 和 `AGENTS.md`，让默认测试和真实模型测试成为分离流程。

## 理由

真实配置模型套件依赖凭证、网络可达性和本地代理行为。它不应成为裸 `bun test` 的一部分。

文件重命名为 `.real.ts` 后，Bun 要求 package 脚本使用 `./tests/real-agent.real.ts` 显式路径传入文件。没有前导 `./` 时，Bun 会把它当作过滤器，并报告没有匹配测试文件。

代理清理是环境问题，不是项目脚本默认行为。有些本地或 CI 环境需要代理才能访问配置的模型 provider，另一些环境则需要禁用代理。脚本不应强制任何一方。

## 验证

已验证：

```bash
bun test tests/test-discovery.test.ts
bun run test:real
bun test
bun run typecheck
git diff --check
```
