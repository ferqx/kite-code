# Agent Note: 完整负载采集保留未具备的正式资格

Status: implemented

## Problem

V1.3完整负载与全局资源要求原8outer、九点、真实busy及零重放。Bun1.4.2的activeResources／handles API返回空数组，当前全部owned descendants亦未证明；原bounded preflight只收一轮短诊断，不能取得尚缺的完整工作量证据。compiled probe中的默认continuous还会在临时目录重新定位源码并build，脱离父runner已冻结候选。

## Decision

macOS显式 `--profile=qualification --collect-blocked`沿同一原runner执行完整固定工作量；原无flag preflight、CI、formal verifier和阈值保持。closed preflight仅接纳准确collectionMode full；已支持的检查全部通过仍blocked／inconclusive及exit1，实际失败则failed／exit1。独立采集校验分类已知资格错误，但保全部原行为、逐点身份、清理、时长和已支持numeric增长检查；同名Bun counters保持null，FD／listeners缺失亦失败。采集结果不授予发布或legacy退役资格。

父runner传入原verified Terminal root，default continuous重新核整个候选后使用同包Bun、两Service、SQLite和Shell；它不从compiled位置寻找仓库或另build。独立fixture未提供候选时保原builder入口。完整probe失败保留其私有原root，便于读取准确原Job／DB／错误，不重试效果或猜测无关进程。

默认两Service追加独立closed v1资源leaf，保原persisted native packet和v1／v2验收边界；通过原公开spawn端口获取出生身份，在原READY／preclose采当前RSS／FD，原close／exited后核同身份退出，再使用原cold读比较生成收据。有字段必须严格解码；旧缺字段不赋新资格。观察不给Runtime配置、Tool／Job／权限adapter，也不通过信号改变退出结果。它只覆盖两个原Service，不改变原全局未具备条件；SDK close可fallback，收据不声明已证明无fallback。

正式MCP stdio的原connection Job现沿独立launchd coalition关闭setsid／orphan后代，closed v2区分Service直接broker、launchd guardian及直接server；只有真正父方观察记录exit／reap，guardian保exit:null。原scope／owner重核、progress／terminal及cold零重放继续；旧v1保两进程合同，不补新树证明。该生产所有权扩展及实际失败修正见[决定](../architecture/2026-10-10-macos-mcp-owned-coalition.md)、[MCP owner](../../../../packages/agent/src/mcp/README.md#显式-stdio-guardian-port)与[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10正式-mcp-完整所属进程树与旧组路径退役)。MCP自己的完整树不补全Runtime graph；原RSS失败、activeResources／handles缺项和完整报告拒绝保持。

macOS 原 mcp_churn stdio caller 已切到实际默认 Source／Core／connection Job；原 server 脚本、Tool unknown、HTTP drift／release及所有旧断言保持。独立 closed v1 [Job交接](../../../../scripts/runtime/unified-soak-mcp-handoff.ts)消费原 ready／terminal、真实 Execution 身份及 cold 完整原结果／输出／两个Command／Run／reference、cursor与Provider零重放；纯公开 decoder 不执行原生观察。Job 独立 operation Command／runId:null 与 connect／call 原Run分别核实。READY broker 由所属 port 在核原私有身份后实际读取内核状态，不把出生记录或固定 unavailable 当成存活证明。该扩展只覆盖原 Job，完整 Runtime 与原资源拒绝不变。

平台路径在调用前明确选择：Mac 正式 owner 失败不回退；非Mac保原公开 adapter 协议诊断，不生成上述收据。正式 Source stdio 后端在非Mac仍未具备，诊断通过不取得生产资格。原跨平台函数 body、case／预算及旧expect保全；新 Mac 收据断言仅覆盖实际具备的 owner。具体生产入口归[MCP owner](../../../../packages/agent/src/mcp/README.md#显式-stdio-guardian-port)，实际失败和冻结原完整回归归[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10原-soak-stdio-caller-迁移与冷结果保全)。

持续lifecycle的滚动数组另经真实两秒probe确认会删除中段。当前按首个cycle warmup及实际窗口分布固定边界，窗口中继续原业务周期，不用等待补时；同一180秒timer涵盖整个point，报告核连续序号。原红／绿和后续原完整回归分别保留，不以修正前通过覆盖后续输入。

完成阶段复用最终报告的原保留资源增长判定，lifecycle、crash series或case matrix增长失败即返回retained_resource_growth并保留原JSON。warmup、首测基线、32MiB RSS、连续三点／六次增长规则及八轮通过要求不变。真实450秒九点负载已自然触发RSS失败；收集入口的失败处理已完成，内存增长本身尚未解决。

## Alternatives considered

- 只反复运行bounded preflight：上游指标仍缺失，也不能取得原完整负载要求的证据，因此保作默认快速拒绝而不作退出依据。
- 将FD、Core permits或单Shell coalition改名为全局handles／activeResources：语义与原验收不同，拒绝。
- 扩写已有closed native收据，或只凭PID／child.exited宣称完整退出：前者改变原持久解码边界，后者缺出生身份与kernel终态；采用独立leaf与实际原子进程身份，并保全局资格拒绝。
- 将stdio进程身份塞进原stopped监督结果或以任意getter内容确认停止：会改变旧停止合同并把观察扩成authority；保独立只读getter，lifecycle重核原Job身份，缺失／非法不改变原结果。
- 将原跨平台协议诊断无条件改成Mac-only生产Source链：现正式port在非Mac明确unsupported，会破坏原诊断合同；进入调用前分流，Mac完成实际caller迁移，其他平台保原有限诊断与生产能力缺口，不catch生产失败再fallback。
- 降低轮数、时长、增长阈值或删除断言：无法证明原稳定性要求，拒绝。
- 用JS heap或physical footprint替换RSS，或默认设置allocator purge参数：指标语义不同，且原450秒对照仍触发增长；未采用，也未将native根因假说作为修复结论。
- compiled probe再build另一候选：依赖源码且换掉冻结输入，改为明确传递并重新核同一完整候选。

## Consequences

完整采集依然可能报告真实失败；原60—168分钟及180秒operation预算没有增加。已通过的源码外两cycle／40Command编译消费者只证明固定候选接线、原行为与cold零重放，不等于完整8outer或全局资源资格。当前真实完整执行与剩余缺项归[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08macos-完整负载采集与冻结候选)，现行门禁归[Runtime资格边界](../../../../docs/active/runtime-resilience-qualification.md)。默认Shell保持macOS宿主语义，Windows／Linux按用户要求在重构完成后由GitHub Actions另验。
