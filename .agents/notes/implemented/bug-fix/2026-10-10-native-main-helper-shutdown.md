# Agent Note: Native Main 所属 helper 随用户退出收束

Status: implemented

## Problem

正式 Native 的新对话分支查询／切换和文件变更／消息“查看文件”由 Main 启动 Git 与编辑器 launcher。原叶子在 timeout／error 时先返回失败，kill 请求没有证明 child 已关闭；只读分支查询不属于 sending，默认 editor IPC 也没有 Caller owner。Main 已等待 Caller 才释放数据／制品使用权，但这些 helper 没有纳入该等待，因此用户退出可能在所属进程或管道仍存在时继续。

用户后续在原40项任务完成窗口实际看到退出时的“操作未完成 / native_draining”。Main 已停止业务准入，renderer 仍把退出前读取的拒绝视为当前页面错误；原测试只核执行结果和退出，没有核该误弹。该展示归属缺口与上述实际 child 收束分别解决。

## Decision

同一 NativeCaller 持有私有 NativeProcessOwner；所有 Git 串行启动和默认 editor IPC 使用该 owner。关闭 Caller 在首次 await 前停止新准入并停止仍属它的准确 ChildProcess 句柄，finally 等实际 close。Conversation 保 sending，并等待所属只读 branch probes；迟到读取仍核 closed／原 scope。Main 原关闭顺序与两秒工作检查保持；2026-10-22 [退出决定](2026-10-22-single-confirmation-exit.md)替代二十秒等待／继续等待／明确强退界面：确认后窗口立即销毁，原 owner 在后台等实际 close。普通窗口隐藏及取消退出确认不收束 owner。

原 Git 十五秒 deadline、stdout／stderr 各1 MiB、严格 UTF-8、分支身份／保护根／活动任务／脏文件守卫保持；editor 原十秒及准确当前项目普通文件、封闭 editor 枚举、原 frame 门禁保持。timeout、启动错误或输出超限保首次 failure，实际 close 才结算；kill false／throw 仍等待，不伪造清理成功或用迟到 exit0覆盖失败。直接 ChildProcess handle 自身绑定真实启动，不按数值 PID发现或清理任意进程。

范围仅为 Main 直接拥有的 Git 与 `/usr/bin/open` launcher。系统交接的编辑器应用属于 external，不由名称扫描或强杀；该边界不构成任意 Git 后代、全部 Runtime census、Bun counters 或 RSS 稳定性资格。当前实现／验证归 [Native owner](../../../../apps/desktop/README.md#原窗口关闭与退出收尾)，准确执行归[本轮进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10native-普通用户操作的所属-helper-收尾)。

2026-10-12 补充：Main 在开始退出及取消退出时沿原固定 channel 发闭合生命周期通知。renderer 用私有 epoch 撤销旧状态、全局目录、选择和草稿读取的展示归属，暂停自动刷新；取消后沿同一 generation 恢复读取和原草稿。正在选择时的暂空输入不覆盖原缓存。资源仍由原 Caller 和 Main 顺序收束，通知没有提前 detach／close 或新业务 authority；已提交 mutation 的未知结果不纳入只读失效。

## Alternatives considered

- 只在原 timeout 回调 kill 并 reject：调用终态先于实际 child／pipe 关闭，Main 无法收束；未采用。
- 仅等待 Conversation sending：准备页只读 probe 与文件 opener 不属于该提交，不能覆盖完整原入口；使用同一个 Caller owner，并保读取的 scope 撤销。
- 按 PID／应用名发现并终止外部编辑器：超出 Main 直接所有权，且可能触及用户已有应用；只使用原可信 ChildProcess handle。
- 把每类 helper 建成新公共 Job／收据／长期测试窗口：这些是 Main 内部用户操作，现有 Caller、Node close 与原退出 settlement 已能承载；未新增公共协议或持久格式。

- 按 `native_draining` 统一吞所有错误：会掩盖当前真实故障或已提交写入的未知回执；只撤销 Main 已明确退出所失效的读取展示归属，当前错误继续报告。

## Consequences

默认 Git 与 editor 的无所属 spawn／提前失败路径退役，有限错误与完整用户入口保持。close 未到会进入原退出等待，不能提前释放依赖 lease；用户明确强退仍是结果待核实。真实 Node 测试沿实际 Caller 关闭核原 child close 和双 EOF，编辑器 executable 仅替换为本任务隔离 child，不操作个人应用或冒称 OS 编辑器窗口通过。原会话、文件目标与源码外完整窗口分别保原业务／冷读／双锁范围；完整阶段及平台条件仍独立满足。

退出误报修复保留两秒检查和使用权释放门禁；后续[退出决定](2026-10-22-single-confirmation-exit.md)明确窗口先销毁、后台清理，不追加异常提示或以二十秒强杀。原读取归属 DOM 的八项断言与新增退出／取消检查、原完整窗口分别验证展示和资源边界，历史红绿归[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-12native-退出期间操作未完成误报)。这些有限结果不授整个 Runtime 资源观测、RSS 或 Win/Linux 资格。
