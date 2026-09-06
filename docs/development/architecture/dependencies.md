# 依赖方向与职责边界

包边界用来防止职责渗透，不要求读者先记住所有包名。下面按作用定位；准确 exports 与依赖见对应 workspace README 和 manifest。

| 职责 | 模块 | 禁止越界 |
| --- | --- | --- |
| 纯业务决策 | agent-kernel | 无 workspace、I/O 或 TUI 依赖 |
| 通用执行协调 | runtime-host | 不解释具体 Tool/Prompt，不持有 SQLite driver |
| 具体能力语义 | builtin-runtime | 不直接依赖 Host/Kernel/App 实现 |
| 注入接口 | runtime-spi | 不引入 Provider concrete handle 到 Kernel facts |
| 持久适配 | runtime-storage-sqlite | 不替 Kernel 决定业务恢复或自动重放 |
| 中立 Runtime 结构 | runtime-contract | 不执行命令、不持有 UI 或 Store |
| 严格 wire | runtime-protocol | 不创建 transport、不提供业务 authority |
| Runtime 访问 | runtime-client / runtime-server | 通过注入边界协作，不互相依赖 concrete implementation |
| Native 与控制 | kite-local-runtime / kite-app-contract | 不为 TUI 暴露 raw Repository/Store |
| Browser API | agent-api-contract / agent-api-client | browser-safe，客户端不能引入 Native/Service |
| 组装 | kite-service | 负责具体依赖与公开入口的组合 |
| 展示 | kite-cli / kite-web / kite-desktop | 不组合第二个 Kernel/Host/Store；desktop renderer 只通过环境无关协议组合与受限 IPC 接入原生宿主 |

## 跨边界修改

新增输入或事件时，先确定 producer 和 consumer，再核对 schema/codec、projection、调用与测试。不能用宽泛继承、any、动态代理或复制内部类型绕过边界。

同一事实经不同投影进入 TUI/Web，展示差异不应扩大后台权限。需要新增机制时先检查现有 port 和事务 owner，避免平行 registry、queue 或 writer。

规范见[Runtime 跨包架构](../../active/six-concept-runtime-architecture.md)。验证入口：[runtime package gate](../../../scripts/check-runtime-packages.ts)、[API package gate](../../../scripts/check-agent-api-packages.ts)、[core boundary](../../../scripts/check-core-boundary.ts)。
