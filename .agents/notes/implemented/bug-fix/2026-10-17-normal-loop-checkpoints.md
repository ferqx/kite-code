# Agent Note: 正常指令发现与 Loop 检查点继续

Status: implemented

## Problem

真实模型执行“了解当前项目”时，同批读取 package.json、apps、packages、docs；docs 首次发现局部 AGENTS.md 后，四个尚未派发的调用全部被记录为失败，并由下一模型完整重发。来源请求在原模型之后被整批扩张，使无关调用也承担新目标的来源差异。正常探索被错误解释为失败，Desktop 再把准备失效计入实际读取和失败次数。

整体检查另外发现：有序派发时输入取代会错误取消整批并使 Run 失败；完成治理工具的正常刷新直接终止 Run；条件读取和最终提交之间的合法并发变化也没有局部重新评估。

用户进一步确认长期多轮使用不应因正常锁竞争、内部队列拥塞或历史累计数中断，且修复不得引入新的锁循环。真实回归还发现成功执行历史4096条、Session取消256个后代、child创建256个累计身份等总量门槛；MCP长连接持有普通process槽导致Shell饥饿。解锁异常曾先删除记录或置closed，再遗留真实OS锁与永久等待。来源请求在每个Model重复保存完整历史，压缩后仍有累计重复封存成本。

## Decision

Core 在 Model 来源捕获时冻结原 source requests。每个 Tool 检查原模型完整请求集加本次准确输入；其他兄弟的新目标只保留到下一 Model 和持久 continuation，不扩张当前调用的检查范围。

可信文件工厂只为 read/list/glob/search 声明 `contextDiscovery=read_only`。差异仅为宿主捕获的低权限项目指令新增、原模型所有来源未变且按原请求重新捕获仍一致时，读取正常完成。新指令和实际结果进入下一 Model，旧 Model 不被追溯改写。扩展自报来源、未知工具、不透明新增、旧来源修改或删除以及副作用不取得该资格；独立权限、目标范围和最终派发检查保持。

治理准备前固定输入、能力和来源，准备后及最终派发前复核同一依据，不能把准备期间到达的新输入当作旧参数的版本基线。完成条件评估后的 steer 在处理 unsatisfied 之前应用并进入新模型，旧评估不能直接结束原 Run。

Core 独立派发事实证明未执行的输入取代正常释放有序 admission。完成治理遇到同类未派发刷新后回到 Model 和条件边界，重新准备 directive，不复用旧参数。条件评估只对 Core 内部实际发现的读集变化让出调度后重读；扩展抛出的同名错误或自报读集冲突不是重试证据。最终完成事务拒绝旧条件证明时，只对比 Core 实际观察的当前 Run 义务、相关记录和执行安全版本；只有这些事实相对本次评估变化，才在同一 settle 边界重评。其他会话推动全局游标不构成进展，静态过期义务继续保留失败。纯条件重评不重放模型、工具、审批或外部副作用；新输入或来源需要模型重新决策时，仍产生准确的新 Model Execution。

Desktop 只有核实原 Message/Execution、未派发事实、Core 的未尝试标记和准确刷新结果后，才投影中性的“此次未执行／重新评估”。持久 ledger 保原事实，真正失败、未知和缺证据的历史不降级。

正常写竞争只在Core确认首个BEGIN尚未进入事务回调时，用私有证明退回原Worker类别队首并短暂让出；保持原ID、容量和close barrier，不设累计等待期限。已进入回调、先前提交或未知结果没有重排资格。清理失败必须给原ID失败ACK，不能丢请求或重放业务。启动/初始化仍保持[原生等待决定](2026-10-07-bounded-sqlite-writer-lock-wait.md)的有界路径。

累计成功历史用完整流式检查与原canonical增量hash处理，取消在原事务内分页取得完整权限与效果域，子树去重并核root/Workspace；child不按历史Session数拒绝，原并发和单Run30分钟期限保持。MCP长连接不占普通Shell短任务槽。Workspace和Session owner均在实际解锁确认后再删持有记录；SQL逻辑释放独立结束执行权，剩余准确物理解锁可以重试，永久故障明确失败，不重开业务/disposer。

有Artifact时来源continuation以v3增量链封存每批首次出现的完整输入，后继只引用链头。恢复完整核原引用、hash、scope、Run和无环顺序；旧v1/v2保持兼容。Model快照共享Core冻结值，宿主捕获接收独立副本。原captureBatch合同仍保留一个完整准确集合；不丢早期依据，也不承诺常量RSS。

MCP只回收已确认ended、Core dispose成功且无transition proof引用的Entry，ticket最终释放断开旧holder回链；live删除核原对象，unknown不冒充回收。Artifact保原8/6活动与64/32正式票据、16MiB排队预算，溢出等待共享容量而不直接失败；字节便利入口同步私有snapshot保调用时封存，等待不持writer/目录句柄，实际活动消费后清理。关闭未确认保资源/Profile并明确失败，正常拥塞不授予重放权。这部分取代[Artifact接纳](../architecture/2026-10-15-artifact-admission-backpressure.md)的超预算直接拒绝，以及[MCP metadata](../architecture/2026-10-05-original-mcp-tool-metadata-artifacts.md)的累计历史准入门槛，其他原理由保持。

Store取消先排除旧ID重放，仅对本实例准确身份的已有handle做本机收缩，再等待原耐久取消写；祖先观察失败不扩域且不阻止事务自身验证。SQL回滚保业务和收尾双错误，真实事务未结束则隔离连接，禁止后继正常读写或业务重放。仅Core实际事务状态的私有品牌允许Runtime在外部清理全部确认后进入原Store strict close，DB/Worker真正关闭才释放锁，不补写旧ledger。恢复lease、局部失败锁及migration的收尾均保原物理capability，逻辑释放结束旧执行权，不能先删记录再假称成功。

## Alternatives considered

- 只隐藏失败计数：能缓解误导，不能消除正常探索的重复模型决策和整批退回。
- 只缩小到相关目录仍然退回该只读调用：保留了首次正常发现就失败的问题，因此为可信只读观察提供严格受限的增量发现。
- 发现任意新来源后直接执行全部旧调用：可能让未读的新指令支配有副作用的旧决策，也可能接受扩展伪造，未采用。
- 仅凭错误字符串重试或标记成功：适配器可以返回同名失败；使用 Core 独立派发事实和私有的条件冲突类型，并保留真实结果。
- 完成附近发生竞态就重跑整轮：可能重复已执行工作；仅重读条件或重新准备尚未派发的治理决定。
- 扩大固定历史配额或默认进程槽：仅推迟同一问题，不能支持长期重复使用。
- 对所有SQLite错误自动重发：会重放已提交或未知效果，仅接纳Core证明尚未进入首事务的竞争。
- 在压缩后删除旧来源输入：会丢失既有新鲜性与恢复依据，采用增量引用减少重复封存。
- 新增全局锁、持父许可等待子许可：会引入新的串行瓶颈和循环等待，不采用。
- 产物超载时延迟复制调用方可变bytes：破坏调用时封存；立即复制任意溢出载荷又放大内存，采用无等待句柄的私有snapshot。
- 每次连接结束立即删Entry：重连ticket可能仍消费原stop/publication证明，只在证明不再引用后回收。
- 回滚失败后只返回原业务错误或继续连接：会泄漏脏读和写锁；保双错、隔离，再以严格关闭确认交接。

## Consequences

只读发现属于正常 Loop，不产生原来四次刷新失败。已使用来源变更的失效检查、五次真实失败保护、拒绝与未知效果边界仍成立。没有新增 SQL 状态、公开 HTTP 控制、调度器或产品调试入口。

[混合批次](../../../../packages/agent/test/isolated/context/tool-batch-freshness.test.ts)、[有序派发](../../../../packages/agent/test/isolated/execution/tool-dispatch-admission.test.ts)、[完成重评](../../../../packages/agent/test/isolated/execution/completion-refresh.test.ts)、[无关会话不构成进展](../../../../packages/agent/test/isolated/execution/completion-unrelated-progress.test.ts)及[真实 SIGKILL 恢复](../../../../packages/agent/test/isolated/recovery/source-discovery-resume.test.ts)分别证明对应边界。实现及限定验证归[Agent owner](../../../../packages/agent/README.md)，展示归[Desktop owner](../../../../apps/desktop/README.md)。这些回归不承诺任意外部工具、网络或模型永远成功。

本决定仅收窄[完整来源捕获](../architecture/2026-10-10-complete-checkpoint-source-capture.md)和[持续执行](../architecture/2026-10-15-long-running-agent-continuation.md)中整批新增目标参与所有兄弟复核的范围，完整原来源、权限、真实失败和恢复理由继续适用；压缩与最终回复仍按[准确回复边界](2026-10-17-compression-reply-boundary.md)。

正常竞争、累计历史、资源回收与未来重构规范归[跨包边界](../../../../docs/active/unified-agent-boundary.md)及各owner；本机加速累计与故障回归没有执行数天/数周soak，不代表全部平台资源资格。
