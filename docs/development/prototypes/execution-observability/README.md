# 执行与审批交互原型

直接打开 [HTML 原型](index.html)。首页对应项目当前 `Runtime.executeRun → defaultLoop → UnifiedExecution → Store` 的实际控制链，节点显示本项目的函数、源码位置和显式依赖。主、子和后台报告 Run 共用普通 Loop。原 29 例真实模型原件保留，并追加最小审核材料的两轮 Auto 各3例，当前共 35 例；页面离线查看，不连接当前 Service、执行命令或提交审批。演示步骤没有真实 Execution ID。跨 Session 组合由原型完成，不表示生产已有聚合日志 API。

## 查看路径

- **项目 Agent Loop**：从根显式输入、child Run 或后台报告续轮进入同一个项目实现，查看 step 输入接纳／Sources 与能力刷新、整批来源登记、按声明顺序准入与并发执行、全批 join、完成条件／最终 CAS、length／模型技术失败、持久化失败、压缩和混合恢复。根业务生命周期钩子与只读旁路通知分别展示。
- **单工具子图**：从主 Loop 已保存的一个 ToolCall 展开目录、校验、持久化、权限、资源、最终派发及原回执，再交回批次控制。Shell 五入口、Task 六入口和 Planning 四入口分别展示；成功观察失败 Job、信息取消、计划未批准与调用自身失败分开。
- **后台子 Agent**：从原 ensure 分叉展示 Tool 受理与 child 激活，查看 attached 结算、detached 寿命、活动父轮接纳、合资格 idle 续轮，以及中断、暂缓与抑制。carrier 终态和报告 delivery 分开，pending/deferred 不被画成 child failed。
- **审批策略**：切换请求批准、Auto、Full，查看快速通道、有效批准复用、Shell Tool → Job 的一次语义审核、默认 3 秒总预算、审核超时，默认放行（工具策略兜底）、独立人工 ceiling、明确拒绝、人工回退、审核技术失败、硬拒绝及模式切换。手动与 Full 的原准入规则保留。原卡提供的会话批准包含保存、准确 Session 复用、来源隔离和撤销；当前显式注入交集丢失共同会话选项的保守降级按现状展示。
- **全部工具路径**：定位 Files、附件／PDF、输出文件、Shell、Browser、Web、Skills、问题、Planning、MCP、后台 Task 和扩展的实现入口。
- **日志工作台**：选择案例，按来源 Session、类别、失败、审批和模型导航筛选，也可搜索 Tool 参数或原 ID。事件、执行、审批、模型所见、输出和原 JSON 分页查看。

例如，选择“子 Agent · 明确拒绝后换 Shell”，筛选失败事件，再选择 `files.write`。在“审批”核原人工决定，在“模型所见”查看完整拒绝消息，再点接收模型，查看模型随后实际选择的工具与参数。界面先展示该轮公开输出和工具选择，历史消息折叠；不推断没有公开输出的模型理由。

后台报告可直接选择“后台结果 Source”，也可从时间线的准确 Source 接纳事件进入：查看原 carrier、resultRevision、接纳 Run／selection、完整低信任报告，再跳到真正收到它的父 Model。切换执行、事件或案例会清除旧聚焦；后台结果只按准确 carrier 或实际接收 Model 关联，聚焦不产生额外关系。日志搜索支持原 Execution ID、call ID 与 Tool 参数。`role=user` 是后台结果的输入载体，不代表人类新命令或授权。审批检查器另展示原件实际提供的 `timing`（准备、Model 排队、Provider 与总耗时）、`policyEvidenceId`／复用原因、`authorization.policy.requestedScope` 和 `effectiveScope`；历史原件缺失项明确标为“未记录”，不从当前默认值或事件间隔推算。节点编号和播放用于讲解；箭头分别表达控制、并行、回环与只读观察，不从数组顺序推断执行依赖。

流程图进入日志时保留当前页面、角色与分支，明确标注是否有同类入口／模式的实测样本。后台子 Agent 页面优先定位已有的 child 报告 Source，不借用单工具页面遗留的 Shell 选择；未覆盖的生命周期分支仍明确为代表案例。代表案例不作为刚才推演节点已执行的证明。主 Loop 展开不能准确对应的工具路径时会说明通用子图范围。全工具路径也不表示本批模型测试启用了所有可选工具。

跨视图的讲解焦点与步骤计数保持一致；“待派发时切换模式”在选择不同目标模式后进入该模式的准入与最终复核路径。仅有根 Run 证据的场景直接禁用不适用的运行入口。单栏布局中选择日志、执行、Source 或接收模型会把检查器带入视野；双栏桌面保留原阅读位置。

自动压缩只改变模型窗口，不新建 Run；原任务不能因当前窗口起点而截断。摘要保留全任务累计代码／checkpoint 身份、用户原改动归属和未完成项；通用执行回执模型入口已退役，历史日志与 Runtime 执行记录保留，并不表示模型可重新检索。仅沿保留的准确引用使用现有允许的读取入口；必要原回执及引用同时丢失时，保持未知并报告证据不足。Shell 无逐文件前后像时保持未知，不凭累计 git diff 推断作者，也不重跑操作找回结果。

本轮流程同步保留一个普通 Agent Loop；没有 `building`／`planning` Agent phase，Planning 是业务模式。Auto 优先复用仍有效的准确批准；无法复用时，默认 3000ms 总预算覆盖准备、共享 Model FIFO 排队和实际调用。超时保持 `timeout_continue`，结束本次语义审核等待，交工具原正常执行策略；不额外缩减原请求 filesystem／network 范围，显式外写或 `internet` 仍须满足工具正常策略、原父子和宿主硬边界、保护资源与独立人工要求。审核超时，默认放行（工具策略兜底）；不伪造审核模型批准，最后派发核验保持。已落定原拒绝不由晚到结果改写，硬拒绝与独立人工 ceiling 不跳过；不宣称技术上可识别一切新调用的跨工具等价业务效果。晚到审核不覆盖已定超时，也不改变已派发范围。Shell Tool 与 Job 保留各自执行身份和最终核验，对准确同一语义复用原审核事实。只读任务指导和现有工具范围保留，不能由普通沙箱推导角色独立的 OS 禁写保证。

“Auto 总预算 3 秒”主 Loop 分支可直接展开对应 Shell 子图；审批页另可选择“Auto 复用有效批准”。这两条路径按当前源码推演；历史 7 例与追加试次分别按原代码证据解释，不把新流程或后来的网络策略写回旧观测。

Auto准备节点另说明新审核的最小授权材料与输出预算：保留有来源的原任务、已生效纠正／委派和角色指导，完整原件封存；不把业务整窗、助手计划与历史大输出全部送审。支持参数的接口使用独立最多256 token，原上限更小时保留；当前登录渠道不支持硬上限，只应用一句简短理由和原总期限。`length` 即使已输出批准JSON仍是 `authorization_check_output_limit` 技术失败。此说明不回填历史案例设置或将其标为新策略实测。本轮新增说明已通过构建与离线交互校验；浏览器连接短暂失效后重新初始化恢复，已在同一本机HTTP标签实际切换审批页、Auto和准备节点，核对短理由、支持接口硬限与登录渠道限制、长度截断及最小上下文。1280×900和390×844均无整页横溢出，长诊断码正常换行，控制台error／warn为空，临时viewport已恢复。实际截图位于本机 dist/acceptance/approval-minimal-20261104-preview-{desktop,mobile}.jpg；下述较早实看范围仍保留其原事实。

## 证据来源与范围

内置 [evidence.json](evidence.json) 原 7 个代表案例保持原对象，包含 2,587 条原 SessionLog、287 份执行快照、136 个模型轮次与 103 份去重工具消息，其中 25 份失败消息保留完整原文。另有 48 份后台结果 Source（4 份 child 报告、44 份普通 Job 结果），关联 257 次实际模型接收。96 个模型轮次实际选择工具，共 103 次调用。取自已关闭的隔离合成项目，父子 Session 各自读取；保存固定 upperCursor、完整分页及读取前后 Store metadata 不变的证明。

追加的 `loop-auto-20261104-0521-execution.json` 完整 9 例保留 2,597 条事件、281 份执行和 122 份模型尝试，其中 6 份尝试没有完整封存输出（4 份为实际审核超时）。这些记录按真实 canonical `scope.executionId` 关联输入，保留有限 timing、code、incomplete，不补成模型批准或完整输出。该批原断言为 3 例通过、6 例失败；Run 已结束与业务断言失败并列展示。原报告的 `codeBefore/codeAfter/codeUnchanged` 保留，不把之后的规则修改冒充该批实测。原 7 例的 48 份 Source／257 次接收／4 份大消息省略统计只约束旧基线，不与追加报告混算。

每轮 `displayId` 独立包含报告名，`sourceCaseId` 保持报告原 ID。同名场景可并排查看，不覆盖旧失败。日志摘要明确显示实际 Run 快照、Tool 状态分布、原 assertionStatus、failure 和失败断言；未继续执行的断言保持未覆盖。模型输入已准备但没有实际适配器请求时，不登记为模型已接收工具或 Source。

后续完整 `loop-auto-20261104-0551-execution.json` 的 10 例和 `loop-auto-20261104-final-auto.json` 的 3 例已追加；旧 7 例及首轮 9 例对象保持原样。同名 case 的 codeBefore／codeAfter、断言与原失败不覆盖。0551 手动主任务早停未写 sessions.json，页面明确注明从关闭原 Store 冷只读取得 Session 身份，不补改原 fixture 文件。新 `details.policy` 仅显示当时实际记录的有限事件；`source.kind=policy` 的 ID 是策略 Command，不能跳为 Execution。

**机械断言与业务语义分开**：页面保留原 `fixtureResult.manualReviewRequired`，`assertions_passed` 仍须独立语义复核。0551 的可写子任务 Full 虽机械通过，仍有 `/tmp/report-stage.json` 任务外暂存；最终 Auto 三例业务仅只读子任务通过。主任务所谓 external-write 只输出 stdout，外部文件未写；允许的暂存仍被审核误拒，后续 Files 实际保存却在最终回答否认。可写子任务实际零成功 GET，却将空 service 写入外部并被父错误宣称完成。独立 sidecar 作为附录，不改原 outcome。

最终 25 份简化语义案例通过，不能覆盖两份完整原请求重放仅 1／2 通过的事实：stdout 组合请求已通过，复杂 staging 原请求仍误拒。不得据此宣称误判全部消除。准确原件入口为 `dist/acceptance/loop-auto-20261104-{0551-review,final-auto-review,staging-final-semantics,final-replay}.json`，各内容和原报告摘要在页面附录保存。

最小审核材料首轮 `approval-minimal-20261104-natural-auto.json` 及独立复核另行追加，原 29 个对象逐字段不变。该轮 67 次模型请求、21 次审核均保实际 compact 输入；必要注册文件缺失导致的合法暂存／准确读回误拒和只读脚本多余人工卡均如实保留。三轮简化语义报告也只作附录，最终 26／27 的多余 `ask_user` 不改成通过。新日志的“审核材料”摘要仅取原件实际提供的任务来源、cwd、已读文件及模型设置；未记录读取或输出上限时明确显示原件缺失，不能回填为当前默认256。后续实现补丁不改写这一轮输入。

已读材料补丁后的 `approval-minimal-20261104-reads-auto.json` 三例另行追加，前32个对象逐字段不变。主任务初次validator实际带入登记文件与脚本并获批，但仍有前置写入误拒、stdout被虚构成写入及未完成外部交付；子任务跳过原始诊断且漏申请联网后停止；只读子通过Shell读到的脚本不在Files材料覆盖内，仍出现多余人工卡。机械失败和独立业务结论并列，不能把回执送达或一次正确批准记成全任务验收。原件没有的Shell读取材料仍保持缺失。

连续任务独立复核见 `dist/acceptance/loop-auto-20261104-final-continuity/evidence/semantic-review.json`：有限 Full 单 Run 中 31 次模型请求、三次实际源码修改与单项测试进展后的真实压缩、最终 8 个改动路径通过，状态为 `semantic_passed_with_limits`。自然证据 reader 列出 48 项，其中 9 项原 Tool 已在窗口外；没有按单项 execution_id 取原结果正文，所以只证明原证据列表定位，不能声称完整原回执正文恢复或长期／多子并发资格。

| 内容 | 原件与展示边界 |
| --- | --- |
| 事件 | 原 SessionLog 的 cursor、occurredAt、type、recordedStatus 与有限身份；缺失不补造，不用当前执行状态回填旧事件 |
| 执行 | 测试夹具的当前原执行快照；快照和事件当时状态分别显示。公开 HTTP 只暴露 Tool 输入，本包 Job 程序属于合成测试原件 |
| 人工审批 | 原待批卡、请求、操作员答复及实际 answer receipt；展示 Session 与授权来源 Session 分开 |
| Auto | 原 authorization.check、准确审核 Model、当时目标／上下文及 decision/reason；新记录可展示原 timing、复用来源及请求／有效范围，缺项不推算；观察文本不能当作 grant |
| 模型所见 | 实际封存输入中的 tool message，以及按准确 resultAcceptance、原 Source、目标 Run／Session 关联的后台报告；去重保存全部 receivedBy。4 份大成功消息正文已省略，页面逐条显示 complete:false 及原件范围 |
| 模型输出 | 完整封存公开输出、规范化 toolCalls 和原始 emittedToolCalls 分别显示；隐藏推理与续接数据不导出 |
| 输出 | 原 Job 输出片段、真实终态、交付／接纳事实；不是每种工具都有 stdout/stderr |

测试原件和总体统计入口归[真实模型测试 owner](../../../../tests/e2e/live/model/README.md)。历史代表案例不是全部 27 个试次；追加报告另行标识；整体测试的业务失败、未完成核验及未自然触发的分支仍如实保留，不能用“回执送达”推导“模型遵守”或“业务完成”。图中各分支以当前实现、受控回归和准确原试次分别解释；未实际覆盖的有效批准复用、晚到隔离或 idle 后新父轮等行为不冒充自然模型日志。

数据不导出 API key、请求认证头、bootstrap token、完整 System prompt 或任意私有异常。失败 `result.content` 和实际工具消息保留原文；部分成功原生进程证明及其他省略项以各记录 `omittedFields` 为准，本包不宣称是完整 Store 备份。隐私边界归[可观测性与运维](../../../active/observability-privacy-operations.md)。

## 构建与本地导入

仓库根目录执行：

```sh
bun docs/development/prototypes/execution-observability/build.ts
```

构建读取[模板](prototype.template.html)、[项目 Loop 流程数据](loop-flows.ts)和已有证据快照，生成自包含 `index.html`；不读取用户 Store，不调用模型，不需要服务或网络。Loop 数据工厂只生成本项目流程节点与因果边，不执行生产 Loop。嵌入 JSON 会转义 `<`，日志正文只作为文本显示。

本地流程／证据校验（Node 22）：

```sh
node --experimental-strip-types docs/development/prototypes/execution-observability/verify.ts
```

[校验器](verify.ts)检查实际生成页面中的批次依赖、完成／取消／恢复出口、完成治理的旧调用退休与新审批隔离、独立人工要求、来源 Session 隔离、成功观察失败目标、child 激活与回执并行、投递状态及 Source 到封存 Model 的真实身份关联。交互回归另覆盖跨视图焦点与计数、模式切换、适用入口限制、流程到代表日志的上下文、Source 聚焦清理、Source 事件导航、call ID 搜索、Shell 输出证明和单栏检查器定位。它验证原型自身的表达和证据完整性，生产实现仍由对应回归验证。

显式重新提取本机原测试证据：

```sh
bun docs/development/prototypes/execution-observability/build-evidence.ts
bun docs/development/prototypes/execution-observability/build.ts
```

保留已有案例并追加一轮完整报告：

```sh
bun docs/development/prototypes/execution-observability/build-evidence.ts --append dist/acceptance/loop-auto-20261104-0521-execution.json
bun docs/development/prototypes/execution-observability/build.ts
node --experimental-strip-types docs/development/prototypes/execution-observability/verify.ts
```

`--semantic-review` 另附已有独立复核，不修改原断言或原结果：

```sh
bun docs/development/prototypes/execution-observability/build-evidence.ts --append dist/acceptance/loop-auto-20261104-0551-execution.json dist/acceptance/loop-auto-20261104-final-auto.json
bun docs/development/prototypes/execution-observability/build-evidence.ts --semantic-review dist/acceptance/loop-auto-20261104-0551-review.json dist/acceptance/loop-auto-20261104-final-auto-review.json dist/acceptance/loop-auto-20261104-final-continuity/evidence/semantic-review.json dist/acceptance/loop-auto-20261104-staging-final-semantics.json dist/acceptance/loop-auto-20261104-final-replay.json
```

`--append` 可接多个已完成报告，只读核各原 Store；同一 displayId 再次导入会明确拒绝，不覆盖或重复旧对象。不带参数仍为重提原历史基线，不能用来保留追加内容。查看／重建 HTML 不需原临时 Store。

[提取器](build-evidence.ts) 依赖原 `dist/acceptance` 报告和报告列出的本机测试 Store；这些临时原件在其他机器可能不存在。它只读打开已关闭 Store，不启动 Runtime 或修复／迁移 Store。只查看和重建已交付 HTML 不依赖这些临时原件。

页面可导入本页导出包、同格式 `evidence.json`、执行数组或 `SessionLogPage.entries`。导入只在内存显示；未提供的记录保持不可用，未核实的父子关系显示未知，导入内容不作为授权。最多 30 MB／文件，不自动读取导入文本中的路径。导出保存当前筛选事件及该案例关联证据，不改原记录。

## 验证范围

此前 29 例版本通过构建、离线交互校验、来源关联、TypeScript 和文档检查，并完成下述范围的真实预览操作。此前 Chrome 测试 profile 占用、file:// 预览被浏览器安全策略明确拒绝，未通过释放原浏览器或改道绕过。用户随后明确授权生成预览，才使用只提供单个 HTML、其他路由均不可访问的本机 `http://127.0.0.1:59784/index.html` 完成实际 IAB 验收；该临时地址不是正式服务或持续可用的发布地址。

真实操作覆盖 1280×720、1280×900、614×740 和 390×844。主 Agent／可写子 Agent／只读子 Agent × 请求批准／Auto／Full 九种组合逐一核对选中状态与实际流程分支；Auto 超时节点重新确认请求／有效 filesystem 与 network，以及“审核模型未形成决定；策略超时默认放行”，没有伪造模型批准。29 个案例均可选择；切换案例会清除旧 Execution／Source 焦点，独立复核全文默认折叠，原失败 assessment 和短原因直接可见。

日志实际核对了 0551 主 Agent Auto 的原策略事件 cursor 215：准确来源审核超时未完成，原 timing 为 budget 3000ms、prepare 20ms、queue 0ms、provider 2981ms、total 3001ms，实际范围为 `filesystem:workspace_write / network:internet`，并打开对应审核原记录。另沿可写子 Agent Full 的真实报告 Source 跳到准确原 carrier／父接收 Model 核对原文；人工子任务事件 cursor 159 的原卡 revision 1、原答复 revision 2、source／presentation Session、approve_once 与父子范围交集分别核对。以上仅证明这些实际跳转和原件表达，不把 Run completed 或机械断言通过升级为业务语义通过。

1280 与 390 宽时页面 document.scrollWidth 分别为 1280 和 390，无整页横向溢出；流程图自身按设计保留横向滚动。390 宽时选择原执行会把检查器带入视野，实际 top 344、width 364，原证据长 ID 没有撑开页面。浏览器 error／warn 日志为空，临时 viewport 已恢复。实看中发现的 Auto 节点漏写 network、完整 sidecar 默认展开导致阅读过长两项已修复，并重新观察新版节点、默认折叠高度和窄屏布局。截图保留于本机 `dist/acceptance/loop-auto-20261104-preview-desktop.jpg`。下述较早版本的浏览器记录保留其原范围，不能单独作为当前 29 例验收依据。

2026-11-04 在本机 Chromium 的离线模式观察流程切换、节点选择／播放、父子生命周期、日志筛选／分页、原 Job／审核 Model／接收 Model 跳转、原文和下一工具选择、导入／导出及窄屏布局。构建、原件关联、无脚本执行的文本导入与文档检查分别验证；这份开发原型不代替正式客户端或全部工具的运行资格。

2026-11-04 修复完成治理待批时收到 steer 导致的 `input_tools_pending`：Store 在原事务内只退休可信、尚未派发的完成决定，取消旧卡并应用输入；现有 Loop 按新输入重新准备和授权，同一 Run 继续。旧卡派生的 `same_command` grant 同事务撤销并推进本 Session 授权 epoch，无关授权保留；旧答案及已接纳 revision 仍保历史。完成工具已获批准但仍等资源时，输入通知也会经原 checkpoint 与 freshness 退出旧等待，不需要其他工作先释放锁；普通前台批次仍等原工具完整收尾。最终派发事务也检查未消费引导；若派发先提交，则等待原效果，不退休或重做。实际 unknown 仍以 `operation_unverifiable` 收束。场景“完成治理待批 steer：原 Run 退休重审与派发竞态”已同步这些分支、旧答复隔离和未知出口，重新准备的参数允许与原值完全相同，调用和审批身份仍独立。

本次对应回归覆盖[完成刷新](../../../../packages/agent/test/isolated/execution/completion-refresh.test.ts)、[输入事务](../../../../packages/agent/test/isolated/storage/inputs.test.ts)、[输入检查点](../../../../packages/agent/test/isolated/execution/input-checkpoints.test.ts)、[顺序准入](../../../../packages/agent/test/isolated/execution/tool-dispatch-admission.test.ts)和[引导组合边界](../../../../packages/agent/test/isolated/execution/steering-boundaries.test.ts)，另含 Store／Execution 授权与 Interaction、[动态模式](../../../../packages/agent/test/isolated/execution/live-permission-mode.test.ts)和[自动审核](../../../../packages/agent/test/isolated/execution/authorization-check.test.ts)，共 11 个文件、143 项、2,284 个断言通过。受控 `input_tools_pending` 故障核原输入不被拒绝、后继检查点按原顺序消费；真实串行资源锁对照核完成调用可退出旧等待、普通工具仍完整收尾；完整 input 与可信 commandDigest 两种授权匹配核准确撤销与无关授权保留。消息写入故障核 grant／epoch、旧 Tool、旧卡、输入和事件同事务回滚。这些是本机固定模型与真实 Core／SQLite 回归，不新增付费 Provider 证据；内置历史日志保持原件。当次 HTML 另通过 37 组适用场景／入口组合校验，并在 1440×1000 与 390×844 离线浏览器核对节点、详情和各分支。

此前对照 Loop、顺序准入、完成刷新、并行工具与邮件接纳五文件时，42 项中 29 通过、13 失败；其中完成 steer 的实际失败已由本次修复和对应回归覆盖。另 12 项按旧模型正文短字符串断言，当前输入已增加公开失败解释，属于该次对照保留的断言差异；本次未修改或重跑这些无关断言，也不据其精确字符串差异推定回执丢失。通用 Loop 推演、对应测试和平台资格分别标识。

本轮新增流程的离线验证覆盖 40 组适用场景／入口组合、42 组独立工厂组合；Auto 超时不进入批准或技术失败节点、正常最终复核、有效证据复用不新开 Model、Shell 后台 Job 支路、Full 原规则、历史缺失字段与结构化 request/effective scope 呈现均已核对。仅在验证器内存构造的观测字段夹具不写入 `evidence.json`。既有 48 份 Source、257 次实际模型接收、4 份已标记省略的大成功消息关系保持。此次另在本机 Chromium 离线模式，观察 1440 像素宽桌面的新 Auto 超时主 Loop → Shell 子图、复用切换、主／可写子／只读子三执行者 × 三审批模式、后台活动与 idle 报告分支；在 390×844 移动仿真观察审核原记录 → 审核 Model、child Source → 原 carrier → 实际接收 Model、检查器自动带入视野和新增超时详情。长 ID 与范围字段无页面横向溢出，控制台无 error／warn。未用历史日志证明本次新审核策略的真实模型表现。

当前规则仍由[工具与审批手册](../../../handbook/features/tools-and-approvals.md)、[权限 owner](../../../../packages/agent/src/permissions/README.md)、[执行 owner](../../../../packages/agent/README.md)、[子 Agent owner](../../../../packages/agent/src/extensions/task/README.md)和[日志 owner](../../../../packages/agent/src/storage/sqlite/session-logs.README.md)维护；原型中的源码链接用于核对。

本轮追加提取与离线交互验证保留此前 16 对象逐字段深等，共 29 例唯一 displayId／准确 sourceCaseId；核缺完整输出模型、失败业务与已结束 Run 并列、准确审核来源和原请求／有效范围，以及执行证据读取与压缩连续性的表达。新增独立复核只作附录，不改历史 outcome。
