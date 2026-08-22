# RMV1-01 Baseline 与 Manifest 完成记录

状态：completed

日期：2026-08-20

关联计划：[`2026-08-19-kite-runtime-modularization-v1-implementation.md`](../../plans/2026-08-19-kite-runtime-modularization-v1-implementation.md)

基线 HEAD：`af5a512305207dcaaeb40c334d0b914befbc3598`

## 结论

RMV1-01 已建立可重复生成的 Runtime State/Event/Store/package/export 源码事实、人工维护的
owner/delete/source/exception 意图清单，以及同时验证二者完整性的 verifier。当前源码的 29 个 operation、
17 个责任项、408 个生产 TypeScript 文件、415 个测试消费者和 12 个根 public export 均有唯一登记。

本阶段没有创建 workspace package、移动 production owner 或改变生产行为。Runtime State 仍为 schema 25，
Runtime Store 仍为 schema 4，epoch 仍为 `kite-runtime-2026-08-18`；没有创建 Project identity、统一
sealing、cross-Host fence、State 26、Store 5 或其他 RAV1 产物。RAV1 继续 blocked。

## 生成事实

生成清单都绑定生成器与输入源码 digest，并由独立进程重新生成、逐字节对比：

| 清单 | 事实 | canonical digest |
| --- | --- | --- |
| `runtime-state-shape.generated.json` | 30 个顶层字段、125 个 reachable declaration、25 个输入源码 | `sha256:8153a486de8cc433d50dbf760d07433a2848bb1c6e8cdd4df5cf56d975d9f385` |
| `runtime-event-shape.generated.json` | 136 个 union member 与 136 个 codec discriminant 精确闭合 | `sha256:deabd2670581e453634fe8c912fc140a5da4db8e5156c45b78f0164ba890b2cb` |
| `store-schema.generated.json` | 8 个表、3 个显式 index、Store 4 marker 与当前 epoch | `sha256:160b70cf16af1d60e0437fc4b98942775be2e41d19e60685543893c87ea671b5` |
| `package-graph.generated.json` | 当前 1 个 private package、36 个声明 entrypoint | `sha256:046422c7dc4753b684476c66f6754a52e15b758c7d2d54b1d43122b1360a7e81` |
| `public-exports.generated.json` | `src/index.ts` 的 12 个 export | `sha256:ec49ef17a9f7b480a18eaee9d4700cc82db700827e676d8adea5bd91a611cba7` |

package baseline 同时记录了 `web`、`web:dev`、`web:seed` 指向当前不存在的
`src/web-server/index.tsx`；这是声明入口的现状事实，不把它们误记为已解析的 production root。

## 人工意图

- `operation-owner.json`：9 个 owner profile、17 个责任项、9 个 operation group；当前 20 个 builtin tool
  与 MCP/Model/Verification/Subagent 动态 operation 各有一个 production owner。
- `legacy-delete.json`：29 个当前 Legacy seam 和 3 个计划引入后再删除的过渡 seam，均绑定 RMV1 Task。
- `source-migration.json`：43 条互斥生产源码规则、1 条测试消费者规则和 4 组 public export disposition；
  verifier 要求所有当前源码、测试消费者和根导出恰好命中一次。
- `architecture-exceptions.json`：当前为 0；RMV1-01 没有预先登记宽泛兼容例外。

## Gate 证据

| 命令 | 结果 |
| --- | --- |
| `bun run typecheck` | passed |
| `bun run format:check` | passed；仅报告既有 `tests/session-manager.test.ts` 的 16 条 `any` warning |
| `bun run check:core-boundary` | passed |
| `bun run test` | 主套件 3739 pass、11 skip、0 fail；5 个隔离文件另有 52 pass、0 fail |
| `bun run test:tui:system:core` | 14 个隔离 PTY 场景文件、32 pass、0 fail |
| `bun run eval:replay:required` | `ModelReplayRequiredGateReportV1` passed；macOS seatbelt 网络隔离 |
| `bun run test:runtime:fault` | 33 pass、0 fail |
| `bun run test:runtime:soak` | CI profile 7/7 pass；orphan PID/worktree/residual path 均为 0；report digest `sha256:bd3e3d82153ebb83c54b41dbd78c860c3e2567eb10b1839fe763aaf9c212d5eb` |
| `bun run scripts/check-runtime-modularization-manifests.ts` | 5 个生成清单可重复；全部人工清单闭合 |
| `bun test tests/scripts/runtime-modularization-manifests.test.ts` | 2 pass、0 fail；包含两次 TypeScript program 生成的确定性回归 |
| `git diff --check` | passed |

CI soak 是本地 CI profile smoke，`qualificationMetricsSupported=false` 符合该 profile 的既有边界；本记录不把它
提升为正式 56-probe release qualification。

## 阶段边界

RMV1-01 Gate 到此 stop-and-report。RMV1 总计划仍为 active，下一阶段 RMV1-02 尚未开始；只有 RMV1-16
完成并形成总 completion evidence 后，才可解除 RAV1 blocked。
