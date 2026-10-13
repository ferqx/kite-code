# 私有 Runtime 观测源码

当前状态：部分实施，来源扩展收束。按用户最新要求，本轮只处理正常运行、内存稳定及已定位源码修复，不继续系统采集或扩大观测类别；原失败、partial 和 unknown 不解除，完整资格仍未取得。准确范围归[当前执行范围](../../docs/plans/unified-agent-refactor-v1-progress.md#当前-goal-收尾范围2026-10-13)。

本目录保存针对固定 [Bun 1.4.2 源码](https://github.com/oven-sh/bun/tree/744846f844374847c902b5e7fd59b4342a51ef99)的可审计补丁；它尚未进入正式安装、候选构建、默认测试运行时或发布资产。[补丁元数据](bun-1.4.2-resource-census.json)记录准确 base commit、SHA 与未覆盖范围，[补丁](bun-1.4.2-resource-census.patch)是实现的耐久副本，本机忽略的构建 checkout 不是唯一保存位置。补丁为零context格式，避免补丁空context前缀被误作源码尾随空格；只对元数据固定base使用 `git apply --unidiff-zero --check` 后应用。

当前原生接线登记所有 `Job<C>` 请求及 POSIX FilePoll，包括非取消任务、池外溢出对象和延迟回收；另接 EventLoopTimer 的真实 heap／Immediate／imminent 准入、调度、取消及最终 Drop。Timer 使用移动稳定 token，未 armed 的内嵌 placeholder 不登记资源；已准入后 Dormant 仍保至最终释放，heap 与 imminent 独立合并 pending。进程级同步快照只持有原生条目的身份和状态；不保 JS 值／owner 对象，锁内不调用 JS、I/O 或业务 callback。地址仅用于内部查找，输出单调 `resourceId`；重复、未知更新、溢出、分配或注销失败保 unknown，不恢复有效资格。取消链、原任务执行及 ACK 行为保持。

私有 `bun:jsc.getResourceCensus()` 输出 version、baseRevision、generation、实际条目及 live／refActive／pending／closing 计数；64 位值用十进制字符串。它不是 Node 三项空数组 API 的兼容替身。`coverageComplete` 始终为 false，非 JS 内置 timer 的独立 ref、socket／HTTP 后台 loop、Worker、非 Job 请求／native addon 和 Windows FilePoll 尚未接齐；不能据数字填 formal 指标或宣称全资源／RSS通过。快照无法取得时字段为 null，而非支持零。

原生核心九项独立 Rust 单元测试通过。原 build 的 SDK27／LLVM21.1.8 不兼容现已按真实配置缺口修复：原生 Darwin 尊重已有 `--macos-sdk` 选项，显式复用本机已安装且 Bun 固定使用的 SDK26.5；默认检测、macOS13.0 部署目标和原 Werror 保持，不下载 SDK 或屏蔽错误。当前含 Timer 修复的完整 native build 实际0，产物及构建 log SHA 归元数据；它只证明当前部分源码可构建，不授完整资源资格。空 histogram 的 NaN 仍用标准 `numeric_limits<double>::quiet_NaN()`，原语义保持，前三次失败记录不删除。

[真实运行时验证入口](verify-runtime.ts)由这个部分构建产物执行，核异步文件 PoolJob、子进程 pipe FilePoll、最终释放、实际 child exit 与双 EOF，不强制 GC。当前真实观察 8 个 pending Job、3 个 FilePoll，live 从原2回到2、generation从2增至56；两个常驻计时来源保留，不推定不存在。原释放断言保持：新增 Timer 接线曾把未启用 timeout 的 Subprocess 字段误登记，实际4→5失败；lazy admission 修复后同入口实际0，不排除 Timer。入口对原 Bun 缺私有来源明确拒绝，输出 `fullResourceQualified:false` 与 `completeProcessBirths:false`；这个局部通过不能替代完整资源、出生或 RSS。

Darwin 累计 task 的独立入口为 [coalition sampler](../../scripts/runtime/unified-soak-coalition.ts)：只读取 `resource-usage-prefix-16`，核调用前后原 guardian 的 unique ID／pidversion／coalition ID，未知保 null。累计单位是 Mach task，包含 exec 替换，不能直接等同进程出生数。正式 Job 最终快照、连续身份事件与完整对账尚未接入；生产 Shell 的当前树清空证明保持。

[Endpoint Security 能力入口](endpoint-security-probe.c)只创建／删除客户端、不订阅事件；当前普通 UID 实际得到 `ERR_NOT_PRIVILEGED`。用户随后要求停止过度采集，未执行的系统校准辅助脚本已删除，不再请求 root 会话或继续采集。完整出生 provider、ready／flush 与独立对账仍未实现；此能力检查不授任何完整出生资格。

当前取舍见[观测来源决定](../../.agents/notes/proposed/architecture/2026-10-13-native-resource-census.md)，资格要求归[Runtime owner](../../docs/active/runtime-resilience-qualification.md)，实际结果与收束范围归[进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13原生观测源码与性能诊断收束)。
