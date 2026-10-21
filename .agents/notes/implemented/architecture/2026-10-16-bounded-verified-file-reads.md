# Agent Note: 完整文件验证与有界读取工作内存

Status: implemented

## Problem

用户要求多主／子Agent与真实Shell并发时降低内存，并保持16路Model、16个Shell、120轮会话切换的流渲染、取消和真实进程清理。原启动文件身份校验整块读取约59MiB的Bun文件，宿主与每个guardian反复产生大Buffer；小Model segment的Artifact读取却每轮和EOF均分配64KiB，再保chunk列表并concat，累计分配远大于正文。降低并发或输出内容不能消除这些内部放大，也不能替代完整新鲜度和出处证明。

## Decision

启动校验在原no-follow FD上使用单个至多1MiB、随小文件大小收缩的局部scratch计算完整SHA，空文件用1字节探测真实EOF。每次仍读完整文件，前后核regular-file、dev／ino／mode／size／mtime／ctime及当前canonical对象，增长早拒，不缓存digest，也不改broker／guardian／coalition身份或停止证明。

POSIX Artifact三类消费共用原文件验证：公开chunk独占且按剩余大小分配；纯verify私有复用最多64KiB scratch；完整read只持准确目标buffer并直接填充。达到声明大小后以1字节实际EOF探测发现增长，完整hash／size／ctime和原引用授权保持。私有复用的buffer不逃逸到公开生成器，提前return／throw和失败仍关闭原FD。Windows原生路径及完整read本轮保持原样，不能外推优化或平台资格。

只减少工作分配，不增加新的累计内容cap或借缓存授予读取权。需要完整连续字节的便利入口仍受运行时自身Buffer能力限制；流式入口仍可完整读更大合法内容。活动输出与原引用、队列背压、业务取消及末端完成条件保持各自合同。

## Alternatives considered

1. 缓存启动文件digest或省略guardian复核：会把历史字节当作当前新鲜度，未采用。每次完整hash的计算与IO继续存在。
2. 复用已经yield给调用者的公共chunk：调用者仍可持有或修改原字节，后续读取会破坏所有权，未采用。只有内部verify／whole消费者可复用私有存储；[按预算完整校验](2026-10-21-nonblocking-complete-tool-verification.md)将这项所有权约束延续到内部合作分片读取，私有scratch仍不逃逸。
3. 将chunk列表、concat及每次64KiB EOF分配保持原样，仅缩小并发或强制GC：不能解决实际放大，也会改变可用并发或将负担转为停顿，未采用。
4. 本轮合并或替换Shell监督进程：涉及父死亡、原birth、coalition与真实回收合同，当前两处IO分配优化不需要改变该拓扑，未纳入本轮。

## Consequences

启动校验工作buffer与单次Artifact验证scratch有明确上限；完整read保留一份必需的结果载荷，进程heap／RSS／footprint仍不受这些局部上限直接约束。未将局部分配降幅承诺为完整应用物理内存降幅。Native外部采样从原Job proof加入launchd guardian，以原birth复核角色；联合footprint、RSS加总和每PID历史峰值分别报告，不把不同时发生的峰值求和。

[启动回归](../../../../packages/agent/test/isolated/jobs/launch-identity-bounded.test.ts)与[Artifact回归](../../../../packages/agent/test/isolated/artifacts/artifact-files.test.ts)分别核分配、完整字节、竞态拒绝及FD关闭；真实Shell的取消／父EOF／SIGKILL／setsid和原scope仍由原owner测试核实。本轮同负载的准确前后结果及限制由[Native owner](../../../../apps/desktop/README.md#native-当前会话环境信息与子详情)维护，原[完整制品分块SHA决定](2026-10-04-native-complete-closure-and-cli-registration.md)继续仅适用于其Service资产核验路径，不授跨租约缓存或替代本leaf新鲜度。
