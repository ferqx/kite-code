# Agent Note: 完整负载采集保留未具备的正式资格

Status: implemented

## Problem

V1.3完整负载与全局资源要求原8outer、九点、真实busy及零重放。Bun1.4.2的activeResources／handles API返回空数组，当前全部owned descendants亦未证明；原bounded preflight只收一轮短诊断，不能取得尚缺的完整工作量证据。compiled probe中的默认continuous还会在临时目录重新定位源码并build，脱离父runner已冻结候选。

## Decision

macOS显式 `--profile=qualification --collect-blocked`沿同一原runner执行完整固定工作量；原无flag preflight、CI、formal verifier和阈值保持。closed preflight仅接纳准确collectionMode full；已支持的检查全部通过仍blocked／inconclusive及exit1，实际失败则failed／exit1。独立采集校验分类已知资格错误，但保全部原行为、逐点身份、清理、时长和已支持numeric增长检查；同名Bun counters保持null，FD／listeners缺失亦失败。采集结果不授予发布或legacy退役资格。

父runner传入原verified Terminal root，default continuous重新核整个候选后使用同包Bun、两Service、SQLite和Shell；它不从compiled位置寻找仓库或另build。独立fixture未提供候选时保原builder入口。完整probe失败保留其私有原root，便于读取准确原Job／DB／错误，不重试效果或猜测无关进程。

默认两Service追加独立closed v1资源leaf，保原persisted native packet和v1／v2验收边界；通过原公开spawn端口获取出生身份，在原READY／preclose采当前RSS／FD，原close／exited后核同身份退出，再使用原cold读比较生成收据。有字段必须严格解码；旧缺字段不赋新资格。观察不给Runtime配置、Tool／Job／权限adapter，也不通过信号改变退出结果。它只覆盖两个原Service，不改变原全局未具备条件；SDK close可fallback，收据不声明已证明无fallback。

正式MCP stdio的原connection Job另沿port／guardian私有nonce／sequence帧保存guardian和server的libproc出生身份／PPID、原ChildProcess exit／reap和kernel终态；同步getter仅供lifecycle严格核原六字段绑定及owner后写progress／terminal details。沿现有两个用户整例核真实Tool／取消／维护恢复和installed明确连接／Service退出／冷读，不另建journal或控制authority。缺失、throw、非法或暂不可读保有限不可用，原supervision／远端Tool未知不改变。已知两进程的事实不能补成全Runtime后代；原setsid限制、activeResources／handles缺项和完整报告拒绝保持。具体当前实现归[MCP owner](../../../../packages/agent/src/mcp/README.md#显式-stdio-guardian-port)，实际结果及原失败归[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10正式-mcp-连接的进程身份与冷退出证据)。

持续lifecycle的滚动数组另经真实两秒probe确认会删除中段。当前按首个cycle warmup及实际窗口分布固定边界，窗口中继续原业务周期，不用等待补时；同一180秒timer涵盖整个point，报告核连续序号。原红／绿和后续原完整回归分别保留，不以修正前通过覆盖后续输入。

完成阶段复用最终报告的原保留资源增长判定，lifecycle、crash series或case matrix增长失败即返回retained_resource_growth并保留原JSON。warmup、首测基线、32MiB RSS、连续三点／六次增长规则及八轮通过要求不变。真实450秒九点负载已自然触发RSS失败；收集入口的失败处理已完成，内存增长本身尚未解决。

## Alternatives considered

- 只反复运行bounded preflight：上游指标仍缺失，也不能取得原完整负载要求的证据，因此保作默认快速拒绝而不作退出依据。
- 将FD、Core permits或单Shell coalition改名为全局handles／activeResources：语义与原验收不同，拒绝。
- 扩写已有closed native收据，或只凭PID／child.exited宣称完整退出：前者改变原持久解码边界，后者缺出生身份与kernel终态；采用独立leaf与实际原子进程身份，并保全局资格拒绝。
- 将stdio进程身份塞进原stopped监督结果或以任意getter内容确认停止：会改变旧停止合同并把观察扩成authority；保独立只读getter，lifecycle重核原Job身份，缺失／非法不改变原结果。
- 降低轮数、时长、增长阈值或删除断言：无法证明原稳定性要求，拒绝。
- 用JS heap或physical footprint替换RSS，或默认设置allocator purge参数：指标语义不同，且原450秒对照仍触发增长；未采用，也未将native根因假说作为修复结论。
- compiled probe再build另一候选：依赖源码且换掉冻结输入，改为明确传递并重新核同一完整候选。

## Consequences

完整采集依然可能报告真实失败；原60—168分钟及180秒operation预算没有增加。已通过的源码外两cycle／40Command编译消费者只证明固定候选接线、原行为与cold零重放，不等于完整8outer或全局资源资格。当前真实完整执行与剩余缺项归[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08macos-完整负载采集与冻结候选)，现行门禁归[Runtime资格边界](../../../../docs/active/runtime-resilience-qualification.md)。默认Shell保持macOS宿主语义，Windows／Linux按用户要求在重构完成后由GitHub Actions另验。
