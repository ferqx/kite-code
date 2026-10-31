# Agent Note: 工具结果保留 Agent Loop 的解释能力

Status: implemented

## Problem

统一浏览器任务中，额外 5 秒页面句柄等待在原 Browser Job 尚待自动审批时先取消它，产生 `browser_not_ready`。排查又确认，Loop 将人工拒绝和未知结果当作必须抛出的异常；同参五次失败会取消 Run。工具结果因此可以阻止模型解释原失败，用户无法从完整回复分清未授权、未执行、未知效果和实际运行故障。另一个独立边界是代码 Job 和 Browser Job 均占 process slot：总容量只有 1 时去掉额外超时会形成自身等待。

用户于 2026-10-29 明确要求：任何工具异常不得打断 Agent Loop，必须把准确原结果交回模型；这不授权被拒绝效果或未知效果重放，也不允许把存储／authority 故障伪装成工具成功。

## Decision

- UnifiedExecution 先保存原 Tool Execution 和配对消息。Tool failed、人工／自动拒绝、execute 抛异常形成的保守 unknown，以及显式 unknown 都交给下一 Model 解释。Loop 不再因这些已结算结果或同参五次 failed 硬退出，不添加工具自动重试。
- 人工 deny 保 `approval_denied`，停止当前批次后继效果并等已开始调用清理，不提交 `cancelCommand/cancelRun`。自动 reject 仍只拒绝准确未派发目标，保留原原因和零 adapter 事实；后续调用各自核权限，不得换工具或路径绕过拒绝。明确用户取消仍停止。
- adapter返回值在其catch内形成独立纯JSON快照，拒绝循环、BigInt、非有限值、accessor和可执行toJSON，不调用getter／toJSON；后续status、content、artifact校验与持久结果只用该快照。非法返回以原已尝试执行的unknown／invalid_tool_result交回下一Model，终态Store写入仍在该catch外。
- executeTool 的返回表示原结果与消息已达持久边界；无法保存结果、真实 authority 或 Store 损坏仍 reject 并停止推进，Loop 不补造 ToolResult。并行后发保存失败不能被更早的业务失败或未知结果覆盖。
- SQLite finishRun 仅对准确 run_id 内已落定 Tool unknown 允许解释 Run completed，不改原 status/result/revision/引用，也不代表效果已解决。同范围 Model／Job unknown 与活动执行继续阻完成；nested Job 的实际监督、资源、关闭及恢复资格继续由原 owner 核实。
- 可信 ToolContext.resourceCapacity 来自 ExecutionResources 的冻结总容量，既不报告当前空闲量，也不授派发权限。browser.execute 在创建代码环境和申请两个 Job 前要求 process 总容量至少 2；不足时准确返回 browser_resource_capacity_unavailable，零 Job／进程。容量足够时保留原排队、取消和仍活许可，不增加调度框架。
- browser.open 的后续等待核准确原 Browser Job、browserId 和 generation，不以额外 5 秒期限取消仍待审批或资源的申请。原真实启动期限、取消、失败／unknown 与源封印保持，取消排队申请不得迟到启动。

[2026-10-25 自动拒绝决定](../bug-fix/2026-10-25-automatic-rejection-preserves-authorized-work.md)中，自动拒绝只作用于准确未派发目标、反馈原因和禁止绕过的理由仍适用。本次部分替代其人工 deny 结束原工作，以及通用五次失败硬退出的结论；不改写原运行证据。[2026-09-04 人工拒绝决定](../bug-fix/2026-09-04-approval-rejection-terminates-tool-batch.md)中未开始兄弟停止、已开始调用清理与原拒绝事实继续适用；整轮结束且不得再调用模型的部分不再适用当前 V1.3。

## Alternatives considered

- 只修 browser.open 的 5 秒等待：能解除原错误取消，但保留了 Tool unknown／人工 deny／五次失败中断 Loop 的共同问题，未采用为全部修复。
- Loop 吞下所有 executeTool reject 并制造失败结果：会掩盖原终态无法提交或 authority 损坏，破坏持久 call/result 配对，未采用。
- 把JSON.stringify留在Store提交参数中：循环或自定义序列化异常会在调用Store前逃出adapter边界，误终止Run；先验证原对象再重复序列化也会重复运行getter／toJSON。采用无访问器执行的独立数据快照，并让后续路径共用，未把真正Store故障纳入该兜底。
- 把 unknown 改成普通 failed 或 succeeded：会虚构外部效果，放宽恢复及重复执行边界，未采用。
- 人工 deny 仍取消 Run、由客户端补一句解释：模型不能取得原配对结果，且把授权否决与停止整轮混同，未采用。
- 为容量 1 临时释放仍活代码进程 slot，或新增 group 调度器：前者破坏实际资源计数，后者扩大本次范围；采用总容量前置拒绝。

## Consequences

工具失败后的解释与原效果状态分别保存。已停止 nested Browser Job 的未知效果可以进入正常完成的解释回复，原 unknown 保持；仍活或停止未确认的 Job 继续保 permit／binding、busy、关闭失败和冷恢复门禁，不从 Run completed 推导资源已停止。拒绝不扩大授权，未知不会由 Core 自动重放，用户取消仍是明确独立控制。

当前实现和验证归 [Agent owner](../../../../packages/agent/README.md)、[权限 owner](../../../../packages/agent/src/permissions/README.md)、[生命周期 owner](../../../../packages/agent/src/lifecycle.README.md)和[跨包授权合同](../../../../docs/active/authorization.md)。本次不升级工具或协议版本，不建立新的恢复／调度框架。

## Verification

实际运行的逐文件隔离测试使用真实 Runtime、SQLite、固定模型与可控 adapter：[Loop 原结果](../../../../packages/agent/test/isolated/execution/loop-tool-results.test.ts)、[并行清理与保存故障](../../../../packages/agent/test/isolated/execution/parallel-tools.test.ts)、[顺序准入](../../../../packages/agent/test/isolated/execution/tool-dispatch-admission.test.ts)、[长任务](../../../../packages/agent/test/isolated/execution/long-running.test.ts)、[授权检查](../../../../packages/agent/test/isolated/execution/authorization-check.test.ts)、[Browser 因果](../../../../packages/agent/test/isolated/browser/execute.test.ts)和[容量与资源](../../../../packages/agent/test/isolated/resources/serial.test.ts)。它们核准确原结果、下一 Model 配对／解释、用户取消、零迟到效果、真实保存失败，以及容量 1 零 Job 和容量 2 外部占位取消。定向通过不代替真实付费模型、Native 全过程或其他平台资格；仍活 unknown 与结束监督的 fixture 必须分开判断。


## Durable counter compatibility

失败序列仍是原事实，不再是停止阈值。当前封存计数接受非负安全整数，不能因大于旧五次阈值就拒绝恢复；数值饱和只为安全整数表示，不形成执行配额。真实SIGKILL在第七个失败工具结算后接续，保原七条效果与结果，只新增一次调用，再由模型说明并completed；旧legacy失败序列回归保持。没有重放旧工具或升级持久／Tool版本。

非法返回补验使用同一真实Runtime／SQLite文件：先红7类，再绿16项133断言；循环、BigInt、非有限、accessor及toJSON均只执行原adapter一次，getter／toJSON为0，排队后继为0，下一Model有原call／result。原终态SQL trigger失败仍fatal，用户取消仍无下一Model。合法inline／artifact模型结果3项77断言、正式PNG到下一Model1项9断言及Agent类型通过；均为受控模型，不代替客户端实机。


## Browser failure explanation and recovery authority

关闭／缺失页面、变址、失效引用、连接中断和旧状态未解决必须让下一模型理解原因，不能只丢出错误码。当前统一入口采用最终ToolResult的纯展示转换，保原outcome、派发事实、Operations和嵌套原结果，另存原内容及诊断码；只读固定宿主envelope，不从网页文本或任意错误对象推断关闭者。unknown说明最后动作可能已执行，解释不产生重试、新建、刷新、导航或释放资格。缺页／变址的existing-only绑定仍在原Main硬准入前拒绝；VM准入前原unknown也保留可信原因进入下一模型，不借格式化绕过fence。

真实隔离worker／Runtime／固定模型的两Run缺页／变址、执行中输入失联及首次导航未确认失联回归，核下一模型实收说明与机器码、零替代页／零重放、原child unknown及结果修订不变。相关集合67项806断言和Agent类型通过；对话框决定可能已生效而原生清理未确认的说明也不赋予旧ref处理新框的资格。实际Native关页过程仍沿Desktop真实验收，不以受控模型替代。


007真实模型输入复核另发现，Runtime把原BrowserJob停止未确认包装为job_stop_unconfirmed，已有browser_stop_unconfirmed留在details.actualResult，未进入此前说明分支。当前宿主只在Core原Execution证明browser.session@1、builtin.browser及ref／execution匹配后，为新信封附准确身份，展示层再读取这一个固定wrapper／actualResult组合；原wrapper码、结果、修订与unknown保留，不从任意nested正文泛搜或补造丢失startup原因。技术browser.code_session仍cancelled，说明只界定代码环境清理，用户是否取消与网页结果继续沿原Task／Browser operation核实，不改变自动通知／取消生命周期。

007同型包装先红后绿，完整相关集合70项877断言、Agent类型及定向Biome通过；真实worker两种stop结果均核下一Model实收说明和技术Job范围、1次原导航、零替代／输入／重放、原结果修订不变与正常final。旧007记录不改写，修后在线／窗口资格沿Desktop owner继续。
