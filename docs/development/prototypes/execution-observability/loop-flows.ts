export interface LoopOverviewNode {
  id: string;
  title: string;
  lane: number;
  description: string;
  [key: string]: unknown;
}

export type LoopOverviewNodeFactory = (
  id: string,
  title: string,
  lane: number,
  description: string,
  extra?: Record<string, unknown>,
) => LoopOverviewNode;

/** Serialized into the offline prototype: keep every runtime dependency inside this body. */
export function createLoopOverview(
  node: LoopOverviewNodeFactory,
  scenario = 'batch_success',
  actor = 'main',
) {
  const scenarios: { id: string; label: string; actors?: string[] }[] = [
    { id: 'batch_success', label: '多工具批次：顺序准入、并发完成' },
    { id: 'human_deny', label: '人工拒绝：停止未开始的后继' },
    { id: 'unknown', label: '结果未知：收束本批、保留原作用' },
    { id: 'auto_reject', label: 'Auto 拒绝：仅目标失败' },
    { id: 'auto_timeout', label: '审核超时，默认放行（工具策略兜底）' },
    { id: 'steer', label: '新输入：整批前台收尾后接纳' },
    { id: 'completion', label: '无工具回复：完成条件与最终提交' },
    {
      id: 'completion_pending_steer',
      label: '完成治理待批 steer：原 Run 退休重审与派发竞态',
      actors: ['main'],
    },
    { id: 'length', label: '输出长度：文本续接与截断工具批' },
    { id: 'model_failure', label: '模型技术失败：确认后退避重试' },
    { id: 'authority_failure', label: '持久化／执行权失败：停止推进' },
    { id: 'run_cancel', label: '取消整个 Run：传播、收束、保存取消' },
    { id: 'resume', label: '恢复：已结算 B 与待批 A' },
    { id: 'compression', label: '自动压缩：改变上下文窗口' },
  ];
  const chosen = scenarios.find((item) => item.id === scenario) ?? scenarios[0]!;
  const effectiveActor = chosen.actors && !chosen.actors.includes(actor) ? 'main' : actor;
  const nodes: LoopOverviewNode[] = [];
  const edges: {
    from: string;
    to: string;
    label?: string;
    kind?: 'control' | 'parallel' | 'return' | 'observation' | 'input';
  }[] = [];
  const runtime = 'packages/agent/src/runtime.ts';
  const loop = 'packages/agent/src/loop.ts';
  const execution = 'packages/agent/src/execution/index.ts';
  const admission = 'packages/agent/src/execution/tool-dispatch-admission.ts';
  const sql = 'packages/agent/src/storage/sqlite/operations.ts';
  const implementations: Record<string, string> = {
    before: "Runtime.runLifecycleActions('beforeRun')",
    run: 'Runtime.executeRun → defaultLoop(loopContext)',
    observe_start: 'lifecycleObservers.publish(extension.lifecycle.onRunStart, event)',
    context:
      'messages() → receivePendingInputs() → consumeJobResults() → selectCapabilities() → captureModelSources() → modelMessages() / compress()',
    model: 'defaultLoop → loopContext.executeModel → UnifiedExecution.model',
    next: 'defaultLoop while → getMessages: messages() → executeModel',
    checkpoint: 'Runtime.resumeRun → prepareRunCheckpoint',
    response: "prepareRunCheckpoint → loop.checkpoint { kind: 'response', stepId, settledCalls }",
    settled_b: 'defaultLoop: initial.settledCalls → restoreToolCall?.() / admission.settled()',
    planned_a: 'prepareRunCheckpoint: plannedTools → loopContext.executeTool → toolExecution',
    resume_join: 'defaultLoop: Promise.allSettled → recordToolOutcome',
    candidate: "defaultLoop: !response.toolCalls.length && finishReason !== 'length' → return",
    late_input: 'Runtime.executeRun complete: receivePendingInputs / inputVersion / inboxVersion',
    conditions: "UnifiedExecution.requirementEvaluation(scope, 'completion')",
    blocked:
      'completionGovernance.prepare → toolExecution / continuationSource / setRunResultWait → changeWaits.wait',
    before_complete: "Runtime.runLifecycleActions('beforeRunComplete')",
    finish: "Store.finishRun → assertInputBoundary / active / requirements('completion')",
    completed: "Store.finishRun → UPDATE run / event('run.finished')",
    observe_end: 'Runtime.executeRun finally → lifecycleObservers.publish(onRunEnd, event)',
    text_length: "UnifiedExecution.performModel: finish.reason === 'length' → saved Model result",
    continue_length: 'defaultLoop → outputLengthContinuation(response.executionId)',
    truncated: "UnifiedExecution.performModel → ModelAttemptError('stream_incomplete')",
    confirmed_retry:
      'loopContext.executeModel → modelRetryReason → waitForModelRetry → retryMessages',
    failure: 'loopContext.executeModel catch → modelRetryReason(error)',
    confirmed: 'Store.getExecution(current.requestId): failed / result.incomplete identity checks',
    backoff: 'waitForModelRetry(providerAttempt, signal) → retryMessages() / modelTools()',
    compress: "messages() → compress(assembled, 'automatic') → defaultLoop（摘要输入）",
    publish: 'compress() → checkFreshness() → Store.commitCompression',
    requests:
      'defaultLoop → prepareToolCalls: registerToolRequests → beginToolBatch: createToolDispatchBatch',
    a: 'Promise.allSettled: executeTool(A) → UnifiedExecution.toolExecution',
    b: 'Promise.allSettled: executeTool(B) → UnifiedExecution.toolExecution',
    a_gate:
      'createToolDispatchBatch → admission.wait → acquireDispatch → dispatch → checkToolDecision / Store.markDispatching',
    a_result: 'UnifiedExecution.toolExecution → durable result / message → ToolExecutionResult',
    b_gate: 'createToolDispatchBatch.forCall(B): wait / dispatched / settled',
    b_result: 'UnifiedExecution.toolExecution(B) → original ToolExecutionResult',
    join: 'defaultLoop: await Promise.allSettled → admission.finish → recordToolOutcome',
    steer: 'receivePendingInputs: toolBatchActive → defer input.steer',
    receive: 'checkpoint() / messages() → receivePendingInputs() → Store.applyInput',
    broken: 'defaultLoop executeTool catch → batch.abort(error) → Promise rejection',
    stop_batch: 'defaultLoop: Promise.allSettled → AggregateError / throw failure',
    run_failed: 'Runtime.executeRun catch → Store.finishRun(status: failed / cancelled)',
    governance_pending:
      'completionGovernance.prepare → UnifiedExecution.toolExecution → approval wait',
    completion_steer: 'Runtime.submitCommand → input.steer（目标为原 Run）',
    dispatch_pending: 'Store.markDispatching → assertInputBoundary → input_pending',
    retire_completion:
      'Store.applyInput → execution.superseded / revokePermissionGrant / interaction.superseded → apply input',
    completion_resource_wait:
      'InteractionGate.policyChanged → owner checkpoint / checkFreshness → acquireDispatch controller.abort',
    refresh_completion:
      'Runtime.executeRun: undispatched refresh → continue complete → defaultLoop',
    fresh_completion: 'completionGovernance.prepare → UnifiedExecution.toolExecution → approval',
    fresh_approval: 'Runtime.answerInteraction → acceptInteractionDecision',
    fresh_effect: 'Store.markDispatching → definition.execute → finishExecution',
    completion_settled: "requirementEvaluation('completion') → Store.finishRun",
    late_old_answer: 'Runtime.answerInteraction → cancelled Interaction history; no new acceptance',
    dispatched_completion:
      'receivePendingInputs: input_tools_pending → defer → original Tool result',
    completion_unknown:
      "Runtime.executeRun: outcome_unknown → AgentError('operation_unverifiable')",
    cancel_batch: 'defaultLoop → beginToolBatch → Promise.allSettled(executeTool)',
    cancel_run:
      'Runtime.stopOwnedBeforeCancellationWrite → live.controller.abort → executeRun / LoopContext.signal',
    propagate_abort:
      'defaultLoop: context.signal abort listener → batch.abort(context.signal.reason)',
    cancel_settle: 'Promise.allSettled → executeTool durable boundary → admission.finish()',
    abort_boundary: 'defaultLoop: context.signal.throwIfAborted()',
    cancelled_run: "Runtime.executeRun catch → Store.finishRun(status: 'cancelled')",
  };
  const add = (
    id: string,
    title: string,
    lane: number,
    description: string,
    path: string,
    line: number,
    extra: Record<string, unknown> = {},
  ) => {
    nodes.push(
      node(id, title, lane, description, {
        row: nodes.length + 1,
        refs: [
          { path, line },
          ...(id === 'a_gate'
            ? [
                { path: execution, line: 1518 },
                { path: execution, line: 930 },
                { path: runtime, line: 7603 },
              ]
            : []),
        ],
        implementation: implementations[id],
        ...extra,
      }),
    );
  };
  const edge = (
    from: string,
    to: string,
    label?: string,
    kind: 'control' | 'parallel' | 'return' | 'observation' | 'input' = 'control',
  ) => edges.push({ from, to, ...(label ? { label } : {}), kind });
  const next = (from: string) => {
    add(
      'next',
      '下一模型安全检查点',
      1,
      '接纳当前输入／邮件与 Job 结果，刷新实际能力和 Sources，再构造下一请求。原工具结果保持准确 call/source 配对。',
      runtime,
      7229,
    );
    edge(from, 'next');
    edge('next', 'context', '下一 step；新请求身份', 'return');
  };
  const main = effectiveActor === 'main';
  if (main && chosen.id !== 'resume') {
    add(
      'before',
      '根显式输入：beforeRun',
      1,
      '仅 run.start / input.follow_up 可准备业务生命周期 Action；Action 仍走普通受控执行。child.start 与 job.report 不执行这两个业务钩子。',
      runtime,
      6187,
    );
  }
  add(
    'run',
    '同一个普通 Run / Loop',
    1,
    main
      ? '根显式输入进入普通 Loop。没有 building / planning Agent phase；Planning 只是业务模式，Run 使用同一 Loop。受理不是业务成功。'
      : '子 Agent／自动报告续轮使用同一个普通 Loop；省略 beforeRun / beforeRunComplete 业务钩子。',
    runtime,
    6588,
    { recordKind: 'run' },
  );
  if (main && chosen.id !== 'resume') edge('before', 'run');
  if (chosen.id !== 'resume') {
    add(
      'observe_start',
      'onRunStart：只读观察',
      1,
      '仅向观察器发布；不是可等待的流程授权，也不保证一定送达。恢复不会补发开始观察。',
      runtime,
      6641,
    );
    edge('run', 'observe_start', '旁路通知', 'observation');
  }
  add(
    'context',
    'step：接纳与冻结上下文',
    1,
    '安全检查点接纳 steer／邮件／Job 结果，选择当前能力，捕获 Sources，组装历史并按需自动压缩；完整输入封存后才请求模型。Sources 只在本检查点合并重复目录，不丢原请求或跨轮 freshness。每步有 stepId；工具批内暂缓应用 steer，不能暗改原批参数。',
    runtime,
    7229,
  );
  add(
    'model',
    '一次完整模型回复',
    0,
    '模型使用本步准确输入与实际工具目录。流式片段不直接执行；完整回复后才区分工具批次、文本 length 与完成候选。',
    loop,
    106,
    {
      recordKind: 'model',
      fields: {
        onModelStart:
          '每个真实 Model attempt 取得 dispatch 确认后才旁路发布；派发前失败可以只有 end。',
        onModelEnd:
          'onModelSettled 根据真实终态构造旁路事件；不是 start 的必达配对，也不保证回调送达。',
        authority: '两者均为只读观察，不作为控制依赖、不批准工具或改变模型结果。',
      },
      refs: [
        { path: loop, line: 106 },
        { path: execution, line: 1170 },
        { path: execution, line: 1339 },
        { path: runtime, line: 749 },
      ],
    },
  );
  edge('run', 'context');
  edge('context', 'model');

  if (chosen.id === 'resume') {
    // A recovery entry replaces the fresh-model edge; it never replays the previous response.
    edges.splice(
      edges.findIndex((item) => item.from === 'run' && item.to === 'context'),
      1,
    );
    add(
      'checkpoint',
      '显式恢复：核原安全检查点',
      1,
      '核同一 Store、主体、原 Run／Command、配置、上下文与当前 owner。冷查看不恢复；未确认 Job／执行权或无法核实的检查点阻塞。已落定 Tool unknown 可作为原回执解释，不构成重放资格，也不自动证明本恢复检查点可派发。',
      runtime,
      3691,
    );
    edge('run', 'checkpoint');
    add(
      'response',
      '恢复原 Model response / stepId',
      1,
      '读取完整原回复，核每个 call 的原模型、参数、stepId 与唯一执行绑定；不重新调用该成功模型。',
      runtime,
      3926,
      { recordKind: 'model', raw: 'succeeded' },
    );
    edge('checkpoint', 'response', '安全核验通过');
    add(
      'settled_b',
      'B 已结算：只恢复原回执',
      4,
      '复用准确 settledCalls 与原 dispatched 事实，不再次调用 Tool；原成功／失败事实不改写。',
      loop,
      151,
      { recordKind: 'tool', fields: { recovery: 'settled B；不重放' } },
    );
    add(
      'planned_a',
      'A 待派发：保留原意图',
      2,
      '复用 planned Tool 的原身份与审批绑定，重新核现行权限和 freshness；并非批准后任意重做旧作用。',
      runtime,
      3992,
      { recordKind: 'tool', raw: 'planned' },
    );
    edge('response', 'settled_b', '原已结算分支', 'parallel');
    edge('response', 'planned_a', '原未派发分支', 'parallel');
    add(
      'resume_join',
      '原批次真实收束',
      4,
      'A 完成当前受控路径；B 只贡献原已知终态回执。等待整批持久边界后继续模型。Tool unknown 可供解释但不取得重放资格；本混合恢复示例仍须核具体 checkpoint，不承诺接纳任意未知检查点。',
      loop,
      150,
    );
    edge('settled_b', 'resume_join', '原结果已核实');
    edge('planned_a', 'resume_join', 'A 实际结算后');
    next('resume_join');
  } else if (chosen.id === 'run_cancel') {
    add(
      'cancel_batch',
      '普通 Loop：当前工具批次活动',
      1,
      '本场景选择完整 Model 回复后、工具批次执行期间取消。根与 child 使用相同信号传播；每个已开始调用保留自己的真实结果边界。',
      loop,
      132,
    );
    edge('model', 'cancel_batch', '完整工具批次');
    add(
      'cancel_run',
      '整个 Run 的控制信号取消',
      0,
      '这是根／child Run 的取消控制，不是只停止某个 Shell，也不是人工拒绝一条审批。取消不撤销已经发生的效果。',
      runtime,
      8123,
    );
    edge('cancel_batch', 'cancel_run', '场景时点：批次中收到取消', 'input');
    add(
      'propagate_abort',
      '根信号传播到本批 signal',
      1,
      'defaultLoop 将 context.signal 的取消原因传播到 batch AbortController；后继未开始调用停止准入，已开始调用按各自取消和监督合同收束。',
      loop,
      133,
    );
    edge('cancel_run', 'propagate_abort', 'signal abort');
    add(
      'cancel_settle',
      '等待本批真实持久／清理边界',
      3,
      'Promise.allSettled 等各调用真实返回；结果和取消／清理事实须持久确认。无法确认的副作用或停止保留 unknown，Run 取消不能把它改写成零作用或已清理。此图选择可正常返回原结果的分支，独立持久化故障另见失败场景。',
      loop,
      146,
    );
    edge('cancel_batch', 'cancel_settle', '已启动调用', 'parallel');
    edge('propagate_abort', 'cancel_settle', '请求取消并收束');
    add(
      'abort_boundary',
      '整批返回后检查 Run 取消',
      1,
      '释放批次观察与准入后，context.signal.throwIfAborted 阻止进入下一模型；该控制与局部审批拒绝的 batch abort 不同。',
      loop,
      191,
    );
    edge('cancel_settle', 'abort_boundary', '整批 allSettled / finish');
    add(
      'cancelled_run',
      'Store 保存 Run cancelled',
      4,
      'Runtime catch 根据 controller.signal.aborted 保存 cancelled；没有下一次模型调用。工具与后台 Job 的原终态／未知事实仍分别保留，取消不是回滚或所有进程停止证明。',
      runtime,
      8067,
      { recordKind: 'run', raw: 'cancelled' },
    );
    edge('abort_boundary', 'cancelled_run', 'Run 控制取消');
    add(
      'observe_end',
      'onRunEnd：只读观察',
      1,
      '只旁路发布可核实的原持久 Run 终态；非必达，不清除未知副作用，也不授予恢复权限。',
      runtime,
      8087,
    );
    edge('cancelled_run', 'observe_end', '旁路通知', 'observation');
  } else if (chosen.id === 'completion_pending_steer') {
    const fixture = 'packages/agent/test/isolated/execution/completion-refresh.test.ts';
    const inputs = 'packages/agent/src/storage/sqlite/input-operations.ts';
    add(
      'candidate',
      '无工具回复：同 Run 完成候选',
      0,
      '模型回复不直接完成 Run；进入现有 completion 条件评估。此处证据是根 Run 固定模型回归，不是付费模型测试，也不宣称 child/report 新增实测。',
      loop,
      124,
      {
        refs: [
          { path: loop, line: 124 },
          { path: fixture, line: 660 },
        ],
      },
    );
    edge('model', 'candidate', '无工具、非 length');
    add(
      'conditions',
      '条件阻塞：准备完成治理 Tool',
      2,
      'completionGovernance 准备受控 Tool；该治理调用在普通前台工具批次之外，不能把它与普通批内 steer 的延迟应用混为一谈。',
      runtime,
      7821,
    );
    edge('candidate', 'conditions');
    add(
      'governance_pending',
      '旧完成 Tool planned、等待原审批',
      2,
      'Runtime 私有封存 completion_decision。只有真实持久来源匹配、planned 且 dispatched=0 的直属完成 Tool 可随旧决定退休；不是根据名称或模型参数放宽。',
      runtime,
      7941,
      {
        recordKind: 'tool',
        raw: 'planned',
        refs: [
          { path: runtime, line: 7957 },
          { path: inputs, line: 459 },
        ],
      },
    );
    edge('conditions', 'governance_pending');
    add(
      'completion_steer',
      '用户 steer 受理到同一原 Run',
      0,
      '新的完成方向作为原输入排队；受理与应用有区别。普通前台 Tool 批次保持原参数并收尾，不能因此被取消。',
      fixture,
      673,
      { recordKind: 'command', raw: 'accepted' },
    );
    edge('governance_pending', 'completion_steer', '待批／派发竞态中的外部输入', 'input');
    add(
      'dispatch_pending',
      'steer 先受理：最终提交挡住旧派发',
      2,
      '即使旧卡已批准，只要 steer 已先受理且 markDispatching 尚未提交，completion_decision 的 assertInputBoundary 仍抛 input_pending，旧 Tool 保持零派发。不是普通批次的豁免边界。',
      sql,
      1849,
      {
        refs: [
          { path: sql, line: 1849 },
          { path: inputs, line: 323 },
          { path: fixture, line: 826 },
        ],
      },
    );
    edge('completion_steer', 'dispatch_pending', '竞态 A：accepted steer 先于派发提交');
    add(
      'retire_completion',
      '同一事务：退休旧决定、旧卡失效、输入接纳',
      1,
      'Store 仅退休 planned/dispatched=0 的完成决定并取消原卡，再接纳原输入。同一事务按准确原卡 ID 撤销其尚未撤销的 same_command grant；存在该授权时推进本 Session 授权 revision（epoch），不改变 policyRevision，无关授权保留。任一普通或已派发活动 Tool 仍阻止应用。退休回执使用低信任 execution_result，没有孤立 toolCallId。',
      inputs,
      459,
      {
        recordKind: 'tool',
        raw: 'cancelled',
        refs: [
          { path: inputs, line: 459 },
          { path: inputs, line: 476 },
          { path: inputs, line: 495 },
          { path: 'packages/agent/src/storage/sqlite/permission-grants.ts', line: 72 },
          { path: fixture, line: 1000 },
          { path: 'packages/agent/test/isolated/storage/inputs.test.ts', line: 598 },
        ],
      },
    );
    edge('completion_steer', 'retire_completion', '直接在待批检查点应用');
    edge('dispatch_pending', 'retire_completion', 'input_pending 后走原退休检查点');
    add(
      'completion_resource_wait',
      '旧批准后资源仍忙：检查点响应 steer',
      2,
      'command.accepted／host_control.changed 或 rescan 唤醒现有 owner checkpoint。完成决定应用 steer 后 inputVersion 失配，checkFreshness 使旧等待退出并取消自身资源申请；其他执行仍持有的锁不必先释放。普通模型 Tool 批次在 checkpoint 暂缓 steer，继续等待资源并完整收尾。唤醒本身不授予权限。',
      'packages/agent/src/execution/interactions.ts',
      127,
      {
        recordKind: 'tool',
        raw: 'planned',
        refs: [
          { path: 'packages/agent/src/execution/interactions.ts', line: 127 },
          { path: execution, line: 813 },
          { path: runtime, line: 7920 },
          { path: fixture, line: 878 },
          { path: fixture, line: 940 },
        ],
      },
    );
    edge(
      'governance_pending',
      'completion_resource_wait',
      '另一未派发位置：旧卡已接纳，正在等资源',
    );
    edge('completion_steer', 'completion_resource_wait', '资源等待中的外部输入唤醒', 'input');
    edge('completion_resource_wait', 'retire_completion', 'owner checkpoint 原事务退休旧决定');
    add(
      'refresh_completion',
      '原 Run 刷新并回普通 Loop',
      1,
      '现有未派发刷新分支识别 superseded_by_user_input/cancelled_before_dispatch，continue complete。旧资源申请也随原等待 controller 取消，其他持锁执行仍可继续；回原 Loop 重新捕获输入、能力和来源并 prepare/审批，不重用旧 directive。',
      runtime,
      7965,
    );
    edge('retire_completion', 'refresh_completion');
    add(
      'fresh_completion',
      '重新准备：新 Tool 与新卡',
      2,
      '同一 Run 的普通模型读到新方向，重新评估条件并 prepare 新 directive。新准备的参数值允许与旧值完全相同（same_command 回归）；新 Tool 与审批身份仍独立，必须重新批准。原 Tool 参数、旧答案接纳历史与退休事实不改写。',
      runtime,
      7821,
      {
        recordKind: 'tool',
        raw: 'planned',
        refs: [
          { path: runtime, line: 7821 },
          { path: fixture, line: 684 },
          { path: fixture, line: 1000 },
        ],
      },
    );
    edge('refresh_completion', 'fresh_completion', '普通 Loop 后重新评估完成条件', 'return');
    add(
      'fresh_approval',
      '准确新卡：新的用户批准',
      0,
      '新卡仍需独立授权与答案接纳。旧答案不能成为新 Tool 的批准，批准后还须通过最终 dispatch。',
      fixture,
      734,
    );
    edge('fresh_completion', 'fresh_approval', '只等待新卡答复', 'input');
    add(
      'fresh_effect',
      '新 Tool 真实派发并结算',
      3,
      '准确新批准、输入、权限与来源均通过最后核验才执行新参数。回归核旧效果为零，新效果仅一次；取消不等于回滚。',
      sql,
      1871,
      {
        recordKind: 'tool',
        raw: 'succeeded',
        refs: [
          { path: sql, line: 1871 },
          { path: fixture, line: 734 },
        ],
      },
    );
    edge('fresh_approval', 'fresh_effect', '独立准入、最后提交成功');
    add(
      'completion_settled',
      '原 Run 经完成条件与最终事务结束',
      4,
      '只有真实结果、当前输入接纳、completion 条件与 Store 最终提交均通过才 completed。根固定模型回归保原 Run 身份。',
      sql,
      2470,
      { recordKind: 'run', raw: 'completed' },
    );
    edge('fresh_effect', 'completion_settled', '真实结算并通过后续完成门禁');
    add(
      'late_old_answer',
      '迟到旧答案：可保存、不可接纳',
      0,
      '旧卡保持 cancelled。旧卡此前未接纳答案时 acceptedDecisionRevision:null；已接纳的旧答案保留原 revision 历史，不能抹成未接纳。迟到答案不成为新接纳证明，既不复活旧 Tool，也不回答新卡或批准新调用。',
      fixture,
      699,
      {
        refs: [
          { path: fixture, line: 699 },
          { path: fixture, line: 917 },
        ],
      },
    );
    edge('retire_completion', 'late_old_answer', '用户迟到回答旧卡；无派发后继', 'input');
    add(
      'dispatched_completion',
      '旧派发先提交：暂缓 steer、等待真实效果',
      3,
      '另一互斥竞态：旧 Tool 已 dispatched。Store 返回 input_tools_pending；Runtime 保留输入 accepted 并暂缓，不退休旧 Tool、不改原参数、不再 prepare 重做效果。已知成功后再应用输入，回普通模型解释原事实并核完成条件。',
      runtime,
      6742,
      {
        refs: [
          { path: runtime, line: 6742 },
          { path: inputs, line: 459 },
          { path: fixture, line: 1066 },
          { path: fixture, line: 765 },
        ],
      },
    );
    edge('governance_pending', 'dispatched_completion', '竞态 B：旧派发先于 steer 受理提交');
    edge('completion_steer', 'dispatched_completion', '竞态 B 的输入只暂缓；与 A 互斥');
    edge(
      'dispatched_completion',
      'completion_settled',
      '旧调用已知成功；后继模型已处理输入且条件满足',
    );
    add(
      'completion_unknown',
      '实际 unknown：保留未知并停止推进',
      4,
      '旧调用若真实返回 outcome_unknown，完成治理抛 operation_unverifiable，原 Run failed。待消费 steer 不强行标 applied；没有新模型或重放。不能把派发后未知伪装为未派发刷新。',
      runtime,
      7963,
      {
        recordKind: 'run',
        raw: 'failed',
        fields: { reason: 'operation_unverifiable', originalToolOutcome: 'outcome_unknown' },
        refs: [
          { path: runtime, line: 7963 },
          { path: fixture, line: 1066 },
        ],
      },
    );
    edge('dispatched_completion', 'completion_unknown', '真实效果不可核实；与成功出口互斥');
  } else if (chosen.id === 'completion') {
    add(
      'candidate',
      '无工具、非 length：完成候选',
      0,
      'defaultLoop 返回；这一步本身不把 Run 记为 completed。',
      loop,
      124,
    );
    edge('model', 'candidate', '完整回复无工具且非 length');
    add(
      'late_input',
      '再次接纳输入／邮件',
      1,
      '新输入或 inbox 水位变化先回普通模型；不能用旧回复越过刚到达的指令。',
      runtime,
      7744,
    );
    edge('candidate', 'late_input');
    edge('late_input', 'context', '输入／邮件已变化', 'return');
    add(
      'conditions',
      '评估 completion 条件',
      2,
      '核原 requirements 及实际证据与 read-set。条件阻塞可等待准确 Job、准备可信继续诊断或受控 Tool；没有合法处理路径则失败。',
      runtime,
      7756,
    );
    edge('late_input', 'conditions', '无新输入');
    add(
      'blocked',
      '阻塞：等待／治理／失败',
      2,
      '治理 Tool 仍核原来源、版本、权限与 freshness。未派发的可信完成决定可随新输入退休并同 Run 重审；已派发效果保持原调用并暂缓输入，unknown 仍阻止推进。具体事务竞争见完成治理 steer 场景，普通前台批次不被此例外取消。',
      runtime,
      7802,
    );
    edge('conditions', 'blocked', '存在 unsatisfied');
    edge('blocked', 'conditions', '相关事实变化后重评', 'return');
    edge('blocked', 'context', '可信诊断要求继续模型', 'return');
    if (main) {
      add(
        'before_complete',
        'beforeRunComplete 业务 Action',
        1,
        '仅根显式输入执行。completionLifecycleDispatched 在本次 executeRun 中只选择一次；runLifecycleActions 又以原 Command 派生身份去重。完成 CAS 重评后已选择过就直接提交，不重复执行业务 Action；此钩子不是完成证明。',
        runtime,
        7773,
      );
      edge('conditions', 'before_complete', '条件满足且本次尚未选择钩子');
    }
    add(
      'finish',
      '完成事务：最终 CAS 核验',
      1,
      'Store 核当前 owner、取消与输入边界、未结算执行、requirements 及声明 read-set。检查到相关变化拒绝旧证明，不产生完成效果。',
      sql,
      2461,
      { recordKind: 'run' },
    );
    edge(main ? 'before_complete' : 'conditions', 'finish', main ? undefined : '条件已满足');
    if (main) edge('conditions', 'finish', '条件满足且已选择过完成钩子；跳过重复业务 Action');
    edge('finish', 'conditions', '条件事实漂移；重新评估', 'return');
    edge('finish', 'context', 'input_pending；接纳后继续', 'return');
    add(
      'completed',
      '真实 Run completed',
      4,
      '事务提交后才形成完成事实；不保证业务判断正确，不取消独立 child，也不消除原 Tool unknown 的外部作用。',
      sql,
      2489,
      { recordKind: 'run', raw: 'completed' },
    );
    edge('finish', 'completed', '提交成功');
    add(
      'observe_end',
      'onRunEnd：只读观察',
      1,
      '成功或失败后的旁路观察，非必达；不能用观察回调替代原终态或取得执行授权。',
      runtime,
      8087,
    );
    edge('completed', 'observe_end', '旁路通知', 'observation');
  } else if (chosen.id === 'length') {
    add(
      'text_length',
      '纯文本 length 已完整保存',
      4,
      '无工具调用且有非空文本，保存原 Model 输出；不是完成，也不撤销已经完成的工作。',
      execution,
      1240,
      { recordKind: 'model', raw: 'succeeded' },
    );
    edge('model', 'text_length', '文本达到输出上限：一种分支');
    add(
      'continue_length',
      '临时续接提示',
      1,
      '准确绑定原 length Model 来源，要求继续原任务且不重复已完成工作。它不持久化为人类新授权；重试仍重新取当前上下文。',
      loop,
      85,
    );
    edge('text_length', 'continue_length');
    edge('continue_length', 'context', '同 Run 下一 step', 'return');
    add(
      'truncated',
      '截断工具批：零工具派发',
      1,
      'length 回复包含 tool calls 或没有有效文本时，不能证明参数完整，作为 stream_incomplete；这与纯文本续接互斥。',
      execution,
      1245,
    );
    edge('model', 'truncated', '含工具的 length：另一分支');
    add(
      'confirmed_retry',
      '确认失败后安全重试 Model',
      1,
      '只在原 Model 已持久 failed 且 incomplete 的边界后退避，再以新请求身份构造当前输入；不派发截断调用。',
      runtime,
      7526,
    );
    edge('truncated', 'confirmed_retry');
    edge('confirmed_retry', 'context', '安全重试', 'return');
  } else if (chosen.id === 'model_failure') {
    add(
      'failure',
      '模型暂时性技术故障',
      0,
      '只处理可安全重试的 Provider／流故障；权限拒绝、损坏记录与未知效果不因此获得重试资格。',
      runtime,
      7526,
    );
    edge('model', 'failure');
    add(
      'confirmed',
      '核原 Model failed + incomplete',
      1,
      '必须核原执行身份与已持久失败事实；关闭／发布未确认不是安全重试边界。',
      runtime,
      7531,
      { recordKind: 'model', raw: 'failed' },
    );
    edge('failure', 'confirmed', '事实可确认');
    add(
      'backoff',
      '可取消退避并刷新请求',
      1,
      '同 Run 持续退避；新 requestId，重取输入与工具。受取消及 child 剩余期限约束，不以固定本地重试次数终止。',
      runtime,
      7558,
    );
    edge('confirmed', 'backoff');
    edge('backoff', 'context', '当前输入／能力', 'return');
  } else if (chosen.id === 'compression') {
    add(
      'compress',
      '按当前上下文尝试自动压缩',
      1,
      '压缩只改变模型窗口，不创建新Run；当前窗口开始不是任务开始。由当前真实消息与Sources构造低信任摘要，累计保留原任务和所有已完成代码／checkpoint身份、用户原有改动归属、未完成项与未知结果，不生成新授权或重放效果。',
      runtime,
      7242,
    );
    const directModel = edges.find((item) => item.from === 'context' && item.to === 'model');
    if (directModel) directModel.label = '不需要压缩';
    edge('context', 'compress', '需要压缩：可选分支');
    add(
      'publish',
      '核 freshness 后发布选中窗口',
      1,
      '原输入／来源须仍成立，中途新输入不能被旧摘要越过。保存准确覆盖关系和全任务累计checkpoint清单；通用回执模型入口已退役；仅沿上下文保留的准确引用使用现有允许的读取入口。必要原回执及引用均丢失时保持未知并报告证据不足，不新开阶段或重跑原操作。Shell缺逐文件前后像，累计git diff不能证明作者归属。',
      runtime,
      7158,
    );
    edge('compress', 'publish', '压缩成功且通过核验');
    edge('publish', 'model', '用选中窗口构造输入');
    edge('compress', 'model', '可安全失败时沿原上下文继续');
    edge('publish', 'context', '输入／能力漂移：重取当前事实', 'return');
  } else {
    add(
      'requests',
      '先登记整批来源请求',
      1,
      '完整回复后先按原声明顺序登记全部 source requests。各调用冻结自己的输入、来源与 bindings，再进入权限／资源／freshness 链。',
      runtime,
      7311,
    );
    edge('model', 'requests', '完整 toolCalls');
    add(
      'a',
      'A：准确 Tool 意图',
      2,
      'A 与 B 可以并行准备；默认策略只顺序约束 dispatch 准入，不强制按完成时间串行。',
      loop,
      150,
      { recordKind: 'tool', raw: 'planned', row: 8 },
    );
    add(
      'b',
      'B：后继 Tool 意图',
      2,
      'B 不能因为本身免审就越过前序未解决准入；自定义权限未声明顺序时仍保通用独立并行能力。',
      admission,
      16,
      { recordKind: 'tool', raw: 'planned', row: 9 },
    );
    edge('requests', 'a', '同批调用 A', 'parallel');
    edge('requests', 'b', '同批调用 B', 'parallel');
    if (chosen.id === 'authority_failure') {
      add(
        'broken',
        'Core／Store 无法持久结算',
        1,
        '本场景的 executeTool Promise reject 无法提供可信原回执；不能伪造 failed Tool 消息。保留多个独立失败，不被首个业务拒绝覆盖。',
        loop,
        169,
      );
      edge('a', 'broken', '持久化／执行权错误');
      add(
        'stop_batch',
        '取消本批推进并等待所有调用返回',
        1,
        'Promise.allSettled 保留独立错误。已经开始的效果仍须如实收束，取消不是回滚。',
        loop,
        150,
      );
      edge('broken', 'stop_batch');
      edge('b', 'stop_batch', '兄弟真实返回');
      add(
        'run_failed',
        '终止 Run 推进',
        4,
        '确认的终态写入成功时 Run failed；根取消则 cancelled。若 Store 连终态也写不成，只能保留不可确认事实，不能画成已有持久失败回执。',
        runtime,
        8052,
        { recordKind: 'run' },
      );
      edge('stop_batch', 'run_failed', '聚合并传播原错误');
      add(
        'observe_end',
        'onRunEnd：只读观察',
        1,
        '在 finally 中发布已核实状态的旁路观察；非必达，不修补缺失回执，也不授予恢复或执行权限。',
        runtime,
        8087,
      );
      edge('run_failed', 'observe_end', '旁路通知', 'observation');
    } else {
      const denied = chosen.id === 'human_deny';
      const unknown = chosen.id === 'unknown';
      const auto = chosen.id === 'auto_reject';
      const timeout = chosen.id === 'auto_timeout';
      add(
        'a_gate',
        denied
          ? 'A：原人工卡明确拒绝'
          : auto
            ? 'A：Auto 明确拒绝'
            : timeout
              ? 'A：Auto 到期，保留请求范围'
              : 'A：权限与最终派发复核',
        2,
        denied
          ? '准确人类拒绝保存 approval_denied；A 未派发，并停止本批未开始后继。不是 cancelRun。'
          : auto
            ? '只拒绝准确当前目标，原原因进入失败回执；不能由此更换工具重做被拒效果。'
            : timeout
              ? '默认 3000ms 总预算涵准备、共享 Model FIFO 排队与实际调用。超时只形成 timeout_continue，结束本次语义审核等待并交工具正常策略；不额外缩减原请求 filesystem / network 范围，显式外写或 internet 仍受工具策略、原父子与宿主硬边界和独立人工要求约束，默认放行并由工具策略兜底，不伪造审核模型批准或越过硬边界；晚到审核不能覆盖已定超时。Shell Tool → Job 对同一语义复用原审核事实，最终派发仍核来源、权限与取消。'
              : '调用冻结原输入、Sources 和 bindings；顺序准入后核普通授权与资源，最终派发前 checkToolDecision 重核当前能力和来源。真实漂移不能复用旧决定；批内暂缓的 steer 不暗改旧输入。批准不是执行效果。',
        denied || auto ? execution : admission,
        denied || auto ? 1344 : 54,
        {
          row: 10,
          ...(timeout
            ? {
                implementation:
                  'Runtime.checkAutoOperation → finishAuthorizationCheck → resolveAutoAuthorization → final dispatch',
                refs: [
                  { path: runtime, line: 1217 },
                  {
                    path: 'packages/agent/src/storage/sqlite/authorization-policy-evidence.ts',
                    line: 378,
                  },
                ],
                fields: {
                  budgetMs: 3000,
                  reason: 'timeout_continue',
                  requestedScope:
                    '本次请求 filesystem: workspace_write / full_access；network: none / internet',
                  effectiveScope: '按工具正常策略、原请求及父子／宿主硬边界核实',
                  decision: '审核模型未形成决定；策略超时默认放行',
                },
              }
            : {}),
        },
      );
      edge('a', 'a_gate');
      add(
        'a_result',
        denied || auto
          ? 'A：保存未派发失败'
          : unknown
            ? 'A：已尝试、结果未知'
            : 'A：执行并持久结算',
        3,
        unknown
          ? '保留 outcome_unknown 与原作用；停止本批未开始后继，不自动重放。已经派发的 B 不会被倒退为未执行。'
          : 'executeTool 只在原结果与消息持久后返回；失败不撤销此前成功。',
        loop,
        146,
        {
          recordKind: 'tool',
          raw: denied || auto ? 'failed' : unknown ? 'outcome_unknown' : 'succeeded',
          row: 12,
        },
      );
      edge('a_gate', 'a_result');
      add(
        'b_gate',
        denied ? 'B：未开始后继取消' : 'B：独立准入 / 最终复核',
        2,
        denied
          ? 'A 的人拒触发局部 batch abort；B 在未派发处结算，不能从旧准入偷偷继续。'
          : unknown
            ? '若 B 尚未派发则被 batch abort 收束；若已派发仍保实际结果。未知出现时刻决定该分支。'
            : auto
              ? 'A 的 Auto reject 不是人工 deny；B 仍独立核现行权限。不能绕过 A 的同一被拒效果。'
              : 'A 一旦真实 dispatch 即释放 B 的准入，无须等待 A 完成。B 仍核自己的权限与资源。',
        admission,
        54,
        { row: 11 },
      );
      edge('b', 'b_gate');
      edge(
        denied || auto ? 'a_result' : 'a_gate',
        'b_gate',
        denied ? '阻止未开始后继' : auto ? '目标失败结算后释放准入' : 'A 派发释放准入',
        'control',
      );
      if (unknown) edge('a_result', 'b_gate', '未知：取消尚未开始者', 'control');
      add(
        'b_result',
        'B：保留真实结算',
        3,
        'B 可能成功、失败或未派发取消；以真实回执为准。已运行兄弟不因 batch abort 变成零作用。',
        loop,
        150,
        { recordKind: 'tool', row: 13 },
      );
      edge('b_gate', 'b_result');
      add(
        'join',
        '全批 join：所有原回执持久',
        4,
        '物理完成顺序可不同。整批全部达到原持久结算边界后，按原 call/result 配对交回下一模型；局部 batch abort 不成为 Run 取消。',
        loop,
        178,
        { row: 14 },
      );
      edge('a_result', 'join', 'A 已结算');
      edge('b_result', 'join', 'B 已结算');
      if (chosen.id === 'steer') {
        add(
          'steer',
          '用户 steer 排队',
          1,
          '等待整批前台调用，包括审批／资源等待。引导不停止原批次、不暗改参数，后台 child／Shell 不必先结束。',
          runtime,
          6724,
          { row: 9 },
        );
        edge('requests', 'steer', '执行期间到达：独立输入', 'input');
        add(
          'receive',
          '安全检查点接纳完整新输入',
          1,
          '全批收束后应用原 steer，并以独立原文和来源进入下一模型。最终派发／完成事务仍关闭输入竞态。',
          runtime,
          6843,
        );
        edge('join', 'receive', '前台批次已结束');
        edge('steer', 'receive', '原 pending 输入');
        next('receive');
      } else next('join');
    }
  }
  return {
    nodes,
    edges,
    title: chosen.label,
    description:
      chosen.id === 'completion_pending_steer'
        ? '当前修复后的同 Run 完成治理流程与两种真实提交竞态。证据来自根 Run 固定模型回归，不计付费模型测试；仅 main 夹具有本次证据，其他执行者参数归一为 main，不宣称 child/report 已复跑。'
        : '当前普通 Agent Loop 的源码流程推演；边表示明确因果或观察关系，节点排列不声明执行依赖。主／子共用 Loop；真实日志仍以原 Execution、call、step 和输入封存为准。',
    actor: effectiveActor,
    lanes: ['模型 / 调用者', 'Runtime / Store', '准入 / 交互', '工具 / Job', '结果 / 完成'],
    scenarios,
  };
}
