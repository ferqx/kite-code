# 私有 Runtime 观测源码

本目录保存针对固定 [Bun 1.4.2 源码](https://github.com/oven-sh/bun/tree/744846f844374847c902b5e7fd59b4342a51ef99)的可审计补丁；它尚未进入正式安装、候选构建、默认测试运行时或发布资产。[补丁元数据](bun-1.4.2-resource-census.json)记录准确 base commit、SHA 与未覆盖范围，[补丁](bun-1.4.2-resource-census.patch)是实现的耐久副本，本机忽略的构建 checkout 不是唯一保存位置。补丁为零context格式，避免补丁空context前缀被误作源码尾随空格；只对元数据固定base使用 `git apply --unidiff-zero --check` 后应用。

当前原生接线登记所有 `Job<C>` 请求及 POSIX FilePoll，包括非取消任务、池外溢出对象和延迟回收。进程级同步快照只持有原生条目的身份和状态；不保 JS 值／owner 对象，锁内不调用 JS、I/O 或业务 callback。地址仅用于内部查找，输出单调 `resourceId`；重复、未知更新、溢出、分配或注销失败保 unknown，不恢复有效资格。取消链、原任务执行及 ACK 行为保持。

私有 `bun:jsc.getResourceCensus()` 输出 version、baseRevision、generation、实际条目及 live／refActive／pending／closing 计数；64 位值用十进制字符串。它不是 Node 三项空数组 API 的兼容替身。`coverageComplete` 始终为 false，timer、socket／HTTP 后台 loop、Worker、非 Job 请求／native addon 和 Windows FilePoll 尚未接齐；不能据数字填 formal 指标或宣称全资源／RSS通过。快照无法取得时字段为 null，而非支持零。

原生核心六项独立 Rust 单元测试与格式检查通过；它们不代真实 Job／FilePoll 或全部运行时集成。固定源码已完成本机 release configure；完整 native build 仍失败于所需 LLVM 21.1.8 与安装的 macOS 27 SDK 的 `stack_protector_ignore` 属性不兼容，未屏蔽原错误。空 histogram 的 NaN 返回另改用标准 `numeric_limits<double>::quiet_NaN()`，不改原返回语义。部署目标显式保原二进制的 macOS 13.0。本轮按用户要求停止额外采集与环境扩展，未生成可宣称合格的新运行时。

Darwin 累计 task 的独立入口为 [coalition sampler](../../scripts/runtime/unified-soak-coalition.ts)：只读取 `resource-usage-prefix-16`，核调用前后原 guardian 的 unique ID／pidversion／coalition ID，未知保 null。累计单位是 Mach task，包含 exec 替换，不能直接等同进程出生数。正式 Job 最终快照、连续身份事件与完整对账尚未接入；生产 Shell 的当前树清空证明保持。

当前取舍见[观测来源决定](../../.agents/notes/proposed/architecture/2026-10-13-native-resource-census.md)，资格要求归[Runtime owner](../../docs/active/runtime-resilience-qualification.md)，实际结果与收束范围归[进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13原生观测源码与性能诊断收束)。
