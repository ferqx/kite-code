# ADR-0087：TUI 启动期静默沙箱预热与退出/并发语义

状态：accepted

日期：2026-08-07

相关：ADR-0076、ADR-0077、ADR-0080、ADR-0084

## 背景

ADR-0076 把 backend qualification 约束在"first input-capable render 之后开始"，preflight 探针因此
在主界面 mount 后才触发。Windows 上全新二进制的首次执行会被 OS 实时扫描（Defender 等）拦截数秒到
十余秒；该一次性成本落在首条命令的计时窗口内，被用户读成"命令慢"。这一成本按"机器 × 二进制版本"
一次性发生，产品代码无法在不签名、不配置 AV 排除的前提下消除它，只能选择它在哪个时刻被支付。

同时，预热窗口内可能发生 TUI 直接退出，或多个 TUI 实例并发启动，两者都不得留下残留 ACL、孤儿
runtime 目录或重复提权安装。

## 决策

1. 静默预热在 Workspace trust 与 config 解析完成后立即触发（TUI 进程启动期），异步执行，不阻塞
   首帧渲染、typing、timer 或 Working animation。预热成功不产生任何 UI 输出；backend 可用性结论
   （host Shell downgrade / denied）仍由原有 prepare 消费方照常提示。
2. 本条修订 ADR-0076 的时序约束：qualification/prewarm 允许在 first input-capable render 之前
   开始。startup downgrade 状态机对用户脚本的语义不变——脚本交付后 fail closed、绝不 host replay、
   production composition 不获得 host fallback。
3. 退出语义：退出协调器在会话 abort 之后调用执行器的 `abortPreparation()`。中止沿探针调用的
   AbortSignal → cancel 帧 → runner stdin EOF 通道传达；runner 清空 Job、回收 ephemeral ACL 后
   退出。被中止的 prepare 不缓存，下一次 prepare() 重新探测。
4. 孤儿清理：TUI 启动时清扫 OS 临时目录下属于 `kite-code-sandbox-preflight-*` 契约、且修改时间
   超过 10 分钟的目录。年龄下限保护并发实例正在使用的活探针目录；清扫严格尽力，失败不是错误。
5. 并发语义：preflight 探针进程无共享状态（独立 ephemeral SID 与临时目录），并发启动只共享 OS
   扫描队列；真实 Workspace ledger 的并发语义维持既有 per-Workspace mutex。Windows setup gate 在
   用户确认的时点 re-check 受管联网状态，若并发实例已完成 setup 则静默放行，不触发冗余提权安装；
   提权安装器本身仍由 machine-wide mutex 串行且幂等。

## 非目标

- 不提供预热进度 UI 或通知；
- 不跳过每次启动的结构探针——它仍是 availability downgrade 的裁决依据，热态约 200ms；
- 不消除 AV 扫描本身（发布签名、AV 排除属于发布与运维决策，不在本 ADR 范围）；
- 不改变 CLI foreground 路径的 prepare 语义。
