import {
  type TrajectoryEvent,
  type TrajectoryEvidenceRef,
  trajectoryEventSchema,
} from '@kite-ai/trajectory';
import { trajectoryInputContextData } from './trajectory-input-context-data.fixture';
import { trajectoryToolCatalogData } from './trajectory-tool-catalog-data.fixture';

/** Explicit isolated data for the production Native renderer; no Runtime or Provider is invoked. */
export function seedSemanticTrajectory(
  facts: TrajectoryEvent[],
  options: {
    legacyLoop?: boolean;
    twoLoops?: boolean;
    twoRuns?: boolean;
    noRun?: boolean;
    toolCatalog?: boolean;
    redundancy?: boolean;
    changedTools?: boolean;
    inputContext?: boolean;
    nodeDetails?: boolean;
    pasteExactHost?: boolean;
  } = {},
) {
  const bodies = new Map<string, unknown>();
  const bodyKey = (eventId: string, reference: TrajectoryEvidenceRef) =>
    `${eventId}:${reference.evidenceId}:${reference.contentVersion}`;
  type Context = {
    sessionId?: string;
    runId?: string | null;
    parentExecutionId?: string;
    sourceEventType?: string;
  };
  const add = (
    kind: TrajectoryEvent['kind'],
    executionId: string | undefined,
    phase: TrajectoryEvent['phase'],
    attributes: Record<string, unknown> = {},
    materials: readonly {
      kind: TrajectoryEvidenceRef['kind'];
      name: string;
      body: unknown;
      partial?: boolean;
      contentVersion?: string;
    }[] = [],
    context: Context = {},
  ) => {
    const sequence = String(BigInt(facts.at(-1)?.sequence ?? '0') + 1n);
    const refs = materials.map((material) => ({
      kind: material.kind,
      evidenceId: material.name,
      contentVersion: material.contentVersion ?? `${material.name}-${sequence}`,
      mediaType: 'application/json',
      availability: material.partial ? ('partial' as const) : ('available' as const),
    }));
    const event = trajectoryEventSchema.parse({
      schema: 'kite.trajectory',
      schemaVersion: 1,
      eventId: `te_${BigInt(sequence).toString(16).padStart(64, '0')}`,
      sequence,
      origin: { storeId: 'store', cursor: sequence },
      identityConfidence: 'verified_origin',
      sessionId: context.sessionId ?? 'a',
      workspaceId: 'w',
      ...(context.runId === null
        ? {}
        : { runId: context.runId ?? 'semantic-run', runOriginStoreId: 'store' }),
      ...(executionId
        ? { executionId, executionOriginStoreId: 'store' }
        : kind === 'child'
          ? { executionOriginStoreId: 'store' }
          : {}),
      ...(context.parentExecutionId
        ? { parentExecutionId: context.parentExecutionId, parentExecutionOriginStoreId: 'store' }
        : {}),
      sourceEventType: context.sourceEventType ?? `${kind}.${phase}`,
      sourceRecordRevision: sequence,
      kind,
      phase,
      recordedStatus: phase === 'completed' ? 'succeeded' : phase,
      occurredAt: Date.UTC(2026, 10, 9, 8) + Number(sequence) * 250,
      attributes,
      evidenceRefs: refs,
    });
    refs.forEach((reference, index) => {
      bodies.set(bodyKey(event.eventId, reference), materials[index]!.body);
    });
    facts.push(event);
    return event;
  };
  const root = {
    commandId: 'semantic-command',
    rootWorkCommandId: 'semantic-command',
    rootWorkSeq: '1',
  };
  const tool = {
    id: 'files.read',
    definitionVersion: '5',
    description: 'Read the selected file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  };
  const requestBody = (
    executionId: string,
    label: string,
    prompt = '登录成功后仍跳回登录页，请检查并修复。',
  ) => ({
    request: {
      requestId: executionId,
      modelId: 'model-opaque-binding',
      messages: [
        {
          role: 'system',
          content: `准确的系统指令：${label}。保持权限校验并记录验证结论。`,
          sourceIds: ['project-instructions'],
        },
        { role: 'user', content: prompt },
      ],
      tools: [tool],
    },
    metadata: {
      version: 1,
      adapter: {
        availability: 'available',
        adapterId: 'model-opaque-binding',
        adapterVersion: '1',
        provider: { availability: 'available', family: 'openai', modelId: 'gpt-6-luna' },
        settings: { maxRetries: 0, maxSteps: 1, allowSystemInMessages: true },
        transformation: { id: 'fixture.public-request', version: '1' },
      },
      assembly: {
        extensions: [{ id: 'builtin.files', version: '1' }],
        tools: [
          { id: tool.id, definitionVersion: tool.definitionVersion, extensionId: 'builtin.files' },
        ],
        capabilitySnapshotDigest: null,
      },
      context: {
        transformationId: 'kite.model-request',
        transformationVersion: '1',
        messageOrder: 'request.messages',
        sourceOrder: 'request.messages[].sourceIds',
        sources: [{ id: 'project-instructions', digest: 'a'.repeat(64) }],
      },
      authorization: { availability: 'unavailable', reason: 'not_dispatched' },
    },
  });
  const message = (
    id: string,
    role: 'user' | 'assistant',
    messageSeq: string,
    content: string,
    executionId?: string,
    context: Context = {},
  ) => {
    const revision = String(BigInt(facts.at(-1)?.sequence ?? '0') + 1n);
    return add(
      'message',
      executionId,
      'observed',
      {
        messageId: id,
        role,
        messageSeq,
        revision,
        status: 'complete',
        display: {
          kind: 'message',
          title: role === 'user' ? '用户输入' : 'Agent 回复',
          summary: content.replace(/\s+/g, ' ').slice(0, 160),
        },
      },
      [
        {
          kind: 'message',
          name: id,
          body: {
            messageId: id,
            role,
            messageSeq,
            revision,
            status: 'complete',
            content,
            ...(options.nodeDetails && role === 'user'
              ? {
                  attachments: [
                    { name: 'request.txt', mediaType: 'text/plain', size: '0' },
                    { name: 'request.txt', mediaType: 'text/plain', size: '12' },
                  ],
                }
              : {}),
          },
        },
      ],
      context,
    );
  };
  const output = (text: string, seq = '1') => ({
    contentMode: 'retained_preview',
    upperOutputSeq: seq,
    items: [{ seq, stream: 'stdout', content: text }],
    gaps: [],
    truncated: false,
  });
  if (options.inputContext) {
    const executionId = 'semantic-input-context-model';
    const input = trajectoryInputContextData(options.pasteExactHost);
    const base = requestBody(executionId, '输入阶段展示核对', '你好');
    const body = {
      ...base,
      request: {
        ...base.request,
        messages: [
          base.request.messages[0],
          { role: 'user', content: '你好' },
          { role: 'user', content: input.pastedJson },
          { role: 'user', content: ' \n\t ' },
          { role: 'user', content: '', images: [input.image] },
          { role: 'user', content: input.hostJson, sourceIds: [input.sourceId] },
          {
            role: 'user',
            content: input.runtimeMessageContent,
            sourceIds: [input.runtimeSourceId],
          },
        ],
      },
      metadata: {
        ...base.metadata,
        context: {
          ...base.metadata.context,
          sources: [
            ...base.metadata.context.sources,
            {
              id: input.sourceId,
              digest: 'c695d667c5b3f104bb1c6909f6da6822fda5d98d2bf85bf7fba3f77f35cf68bf',
            },
            {
              id: input.runtimeSourceId,
              digest: '6aaef5faa0b0678838c34f83a83ea1b4db5f2f0989d28d13b80bae412224db35',
            },
          ],
        },
      },
    };
    const attributes = { ...root, definitionId: 'model-opaque-binding', definitionVersion: '1' };
    add('run', undefined, 'running', root, [], { runId: input.runId });
    add(
      'model',
      executionId,
      'planned',
      attributes,
      [
        {
          kind: 'model_input',
          name: 'semantic-input-context-input',
          contentVersion: input.inputVersion,
          body,
        },
      ],
      { runId: input.runId },
    );
    add('model', executionId, 'completed', attributes, [
      {
        kind: 'model_output',
        name: 'semantic-input-context-output',
        body: {
          reasoning: '根据实际用户消息打招呼。',
          content: '你好，有什么可以帮你？',
          toolCalls: [],
          complete: true,
        },
      },
    ]);
    add('run', undefined, 'completed', root);
    return { bodies, bodyKey, completeShell() {} };
  }
  if (options.toolCatalog) {
    const catalog = trajectoryToolCatalogData(),
      executionId = 'semantic-tool-catalog-model';
    const base = requestBody(executionId, '工具目录布局核对', '检查本次请求公开的工具目录。');
    const input = {
      ...base,
      request: { ...base.request, tools: catalog.tools },
      metadata: {
        ...base.metadata,
        assembly: {
          ...base.metadata.assembly,
          tools: catalog.tools.map((tool) => ({
            id: tool.id,
            definitionVersion: tool.definitionVersion,
            extensionId: 'fixture.public-tools',
          })),
        },
      },
    };
    add('run', undefined, 'running', root);
    add(
      'model',
      executionId,
      'planned',
      { ...root, definitionId: 'model-opaque-binding', definitionVersion: '1' },
      [
        {
          kind: 'model_input',
          name: 'semantic-tool-catalog-input',
          body: input,
          contentVersion: catalog.contentVersion,
        },
      ],
    );
    add(
      'model',
      executionId,
      'completed',
      { ...root, definitionId: 'model-opaque-binding', definitionVersion: '1' },
      [
        {
          kind: 'model_output',
          name: 'semantic-tool-catalog-output',
          body: {
            reasoning: '检查本次保存的工具目录，不重取当前工具注册表。',
            content: '已准备工具目录。',
            toolCalls: [],
            complete: true,
          },
        },
      ],
    );
    add('run', undefined, 'completed', root);
    return { bodies, bodyKey, completeShell() {} };
  }
  if (options.noRun) {
    const context = { runId: null };
    const attrs = { definitionId: 'model-opaque-legacy-adapter', definitionVersion: '1' };
    add(
      'model',
      'semantic-no-run-model',
      'planned',
      attrs,
      [
        {
          kind: 'model_input',
          name: 'semantic-no-run-input',
          body: requestBody('semantic-no-run-model', '无Run旧记录的准确请求'),
        },
      ],
      context,
    );
    add(
      'model',
      'semantic-no-run-model',
      'completed',
      attrs,
      [
        {
          kind: 'model_output',
          name: 'semantic-no-run-output',
          body: {
            reasoning: '无Run旧记录的公开思考。',
            content: '',
            toolCalls: [],
            complete: true,
          },
        },
      ],
      context,
    );
    add(
      'tool',
      'semantic-no-run-tool-one',
      'completed',
      { definitionId: 'files.read', definitionVersion: '5' },
      [],
      { ...context, parentExecutionId: 'semantic-no-run-model' },
    );
    add(
      'tool',
      'semantic-no-run-tool-two',
      'completed',
      { definitionId: 'files.read', definitionVersion: '5' },
      [],
      { ...context, parentExecutionId: 'semantic-no-run-tool-one' },
    );
    add(
      'interaction',
      'semantic-no-run-tool-two',
      'observed',
      {
        interactionId: 'semantic-no-run-approval',
        interactionKind: 'approval',
        revision: '1',
        decision: 'accepted',
      },
      [],
      context,
    );
    return { bodies, bodyKey, completeShell() {} };
  }
  if (options.legacyLoop) {
    const context = { runId: 'semantic-legacy-run' };
    const attributes = {
      ...root,
      definitionId: 'model-opaque-legacy-adapter',
      definitionVersion: '1',
    };
    add('run', undefined, 'completed', root, [], context);
    const request = requestBody(
      'semantic-legacy-model',
      '旧记录的封存原请求',
      '原请求中保存的用户问题：请解释登录恢复。',
    );
    request.request.modelId = 'model-opaque-legacy-adapter';
    request.metadata.adapter.adapterId = 'model-opaque-legacy-adapter';
    add(
      'model',
      'semantic-legacy-model',
      'planned',
      attributes,
      [{ kind: 'model_input', name: 'semantic-legacy-input', body: request }],
      context,
    );
    add(
      'model',
      'semantic-legacy-model',
      'completed',
      attributes,
      [
        {
          kind: 'model_output',
          name: 'semantic-legacy-output',
          body: {
            content: '旧记录的公开回复：登录恢复完成后再判断路由权限。',
            reasoning: '旧记录保存的公开思考：需要先等待会话恢复，再核对权限。',
            toolCalls: [],
            complete: true,
          },
        },
      ],
      context,
    );
    return { bodies, bodyKey, completeShell() {} };
  }
  if (options.twoLoops || options.twoRuns || options.redundancy) {
    const context = { runId: 'semantic-two-loop-run' };
    const prompt = '读取认证配置并解释登录恢复。';
    const attributes = { ...root, definitionId: 'model-opaque-binding', definitionVersion: '1' };
    const call = {
      id: 'semantic-loop-read-call',
      name: 'files.read',
      arguments: '{"path":"src/auth/config.ts"}',
    };
    add('run', undefined, 'running', root, [], context);
    message('semantic-loop-user', 'user', '1', prompt, undefined, context);
    add(
      'model',
      'semantic-loop-one',
      'planned',
      attributes,
      [
        {
          kind: 'model_input',
          name: 'semantic-loop-one-input',
          body: requestBody('semantic-loop-one', '第一轮准确系统请求', prompt),
        },
      ],
      context,
    );
    add(
      'model',
      'semantic-loop-one',
      'completed',
      attributes,
      [
        {
          kind: 'model_output',
          name: 'semantic-loop-one-output',
          body: {
            reasoning: '第一轮公开思考：先读取认证配置，核对恢复是否启用。',
            content: '我先读取认证配置。',
            toolCalls: [call],
            complete: true,
          },
        },
      ],
      context,
    );
    const toolContext = { ...context, parentExecutionId: 'semantic-loop-one' };
    const file = {
      ...root,
      callId: call.id,
      definitionId: 'files.read',
      definitionVersion: '5',
      display: {
        kind: 'file',
        title: '读取文件',
        summary: 'src/auth/config.ts',
        operation: 'read',
      },
    };
    add(
      'tool',
      'semantic-loop-read',
      'planned',
      file,
      [
        {
          kind: 'tool_input',
          name: 'semantic-loop-read-input',
          body: { path: 'src/auth/config.ts' },
        },
      ],
      toolContext,
    );
    add(
      'tool',
      'semantic-loop-read',
      'completed',
      file,
      [
        {
          kind: 'tool_result',
          name: 'semantic-loop-read-result',
          body: {
            outcome: 'succeeded',
            content: 'session.restore = true',
            presentation: {
              kind: 'file',
              operation: 'read',
              path: 'src/auth/config.ts',
              text: 'session.restore = true',
            },
          },
        },
      ],
      toolContext,
    );
    const base = requestBody(
      'semantic-loop-two',
      options.redundancy ? '第一轮准确系统请求' : '第二轮准确系统请求',
      prompt,
    );
    const secondInput = {
      ...base,
      request: {
        ...base.request,
        tools:
          options.redundancy && options.changedTools
            ? [
                {
                  ...tool,
                  inputSchema: {
                    ...tool.inputSchema,
                    properties: {
                      ...tool.inputSchema.properties,
                      from_line: { type: 'integer', minimum: 1 },
                    },
                  },
                },
              ]
            : base.request.tools,
        messages: [
          ...base.request.messages,
          { role: 'assistant', content: '我先读取认证配置。', toolCalls: [call] },
          { role: 'tool', content: 'session.restore = true', toolCallId: call.id },
        ],
      },
    };
    add(
      'model',
      'semantic-loop-two',
      'planned',
      attributes,
      [{ kind: 'model_input', name: 'semantic-loop-two-input', body: secondInput }],
      context,
    );
    const reply = '认证配置已启用恢复；等待会话恢复后再判断路由权限。';
    add(
      'model',
      'semantic-loop-two',
      'completed',
      attributes,
      [
        {
          kind: 'model_output',
          name: 'semantic-loop-two-output',
          body: {
            reasoning: '第二轮公开思考：读取结果确认恢复已启用，需要等待恢复结束再判断权限。',
            content: reply,
            toolCalls: [],
            complete: true,
          },
        },
      ],
      context,
    );
    message('semantic-loop-reply', 'assistant', '2', reply, 'semantic-loop-two', context);
    add('run', undefined, 'completed', root, [], context);
    if (options.twoRuns) {
      const followup = { runId: 'semantic-followup-run' };
      add('run', undefined, 'running', root, [], followup);
      message(
        'semantic-followup-user',
        'user',
        '3',
        '第二次发送：只确认权限检查是否保留。',
        undefined,
        followup,
      );
      add(
        'model',
        'semantic-followup-model',
        'planned',
        attributes,
        [
          {
            kind: 'model_input',
            name: 'semantic-followup-input',
            body: requestBody(
              'semantic-followup-model',
              '第二次用户发送的准确系统请求',
              '第二次发送：只确认权限检查是否保留。',
            ),
          },
        ],
        followup,
      );
      add(
        'model',
        'semantic-followup-model',
        'completed',
        attributes,
        [
          {
            kind: 'model_output',
            name: 'semantic-followup-output',
            body: {
              content: '权限检查仍保留。',
              reasoning: '第二次用户发送的公开思考：仅确认原权限分支没有删除。',
              toolCalls: [],
              complete: true,
            },
          },
        ],
        followup,
      );
      message(
        'semantic-followup-reply',
        'assistant',
        '4',
        '权限检查仍保留。',
        'semantic-followup-model',
        followup,
      );
      add('run', undefined, 'completed', root, [], followup);
    }
    return { bodies, bodyKey, completeShell() {} };
  }
  add('run', undefined, 'running', root);
  message('semantic-user', 'user', '1', '登录成功后仍跳回登录页，请检查并修复。');
  let previous: string | undefined;
  for (let index = 0; index < 4; index++) {
    const id = index === 0 ? 'semantic-model' : `semantic-retry-${index}`;
    const attributes = {
      ...root,
      definitionId: 'fixture.respond',
      definitionVersion: '1',
      display: {
        kind: 'model',
        title: '请求模型',
        modelName: 'gpt-6-luna',
        operation: 'request',
        requestContext: { systemMessages: 1, historyMessages: 1, tools: 1 },
      },
      ...(previous
        ? {
            previousExecutionId: previous,
            previousExecutionOriginStoreId: 'store',
            retryReason: 'connection_failed',
            retryAttempt: index + 1,
            maxAttempts: 6,
          }
        : {}),
    };
    add('model', id, 'planned', attributes, [
      {
        kind: 'model_input',
        name: `semantic-input-${index}`,
        body: requestBody(id, `第 ${index + 1} 次请求`),
      },
    ]);
    add(
      'model',
      id,
      index === 3 ? 'completed' : 'failed',
      {
        ...attributes,
        ...(index === 3
          ? { usage: { inputTokens: '8086', outputTokens: '320', cachedInputTokens: '2048' } }
          : {}),
      },
      [
        {
          kind: 'model_output',
          name: `semantic-output-${index}`,
          body: {
            reasoning:
              index === 3
                ? '公开思考：先检查会话恢复的等待时机，再核对路由守卫的权限分支。'
                : `第 ${index + 1} 次请求保存的公开思考前缀。`,
            content:
              index === 3
                ? '先检查会话恢复与路由守卫，并运行相关测试。'
                : `第 ${index + 1} 次请求没有完整返回。`,
            complete: index === 3,
            toolCalls: [],
          },
          partial: index !== 3,
        },
      ],
    );
    previous = id;
  }
  const model = previous!;
  const file = {
    ...root,
    definitionId: 'files.read',
    definitionVersion: '5',
    display: { kind: 'file', title: '读取文件', summary: 'src/auth/session.ts', operation: 'read' },
  };
  add(
    'tool',
    'semantic-read',
    'planned',
    file,
    [
      {
        kind: 'tool_input',
        name: 'semantic-file-input',
        body: { path: 'src/auth/session.ts', from_line: 1, to_line: 120 },
      },
    ],
    { parentExecutionId: model },
  );
  add(
    'tool',
    'semantic-read',
    'completed',
    file,
    [
      {
        kind: 'tool_result',
        name: 'semantic-file-result',
        body: {
          outcome: 'succeeded',
          content: '会话恢复在路由判断之后完成。',
          presentation: {
            kind: 'file',
            operation: 'read',
            path: 'src/auth/session.ts',
            startLine: 1,
            endLine: 120,
            text: 'export async function restoreSession() {\n  await storage.restore();\n  session.ready = true;\n}',
          },
        },
      },
    ],
    { parentExecutionId: model },
  );
  const edit = {
    ...root,
    definitionId: 'files.edit',
    definitionVersion: '2',
    display: { kind: 'file', title: '编辑文件', summary: 'src/auth/guard.ts', operation: 'edit' },
  };
  add(
    'tool',
    'semantic-edit',
    'planned',
    edit,
    [
      {
        kind: 'tool_input',
        name: 'semantic-edit-input',
        body: {
          path: 'src/auth/guard.ts',
          old_string: 'return checkLogin();',
          new_string: 'await session.whenReady();\nreturn checkLogin();',
        },
      },
    ],
    { parentExecutionId: model },
  );
  add(
    'interaction',
    'semantic-edit',
    'waiting_interaction',
    {
      interactionId: 'semantic-approval',
      interactionKind: 'approval',
      revision: '1',
      decision: 'requested',
    },
    [
      {
        kind: 'interaction',
        name: 'semantic-approval-request',
        body: {
          request: { title: '修改路由守卫', description: '等待会话恢复后再检查登录。' },
          answer: null,
        },
      },
    ],
  );
  add(
    'interaction',
    'semantic-edit',
    'observed',
    {
      interactionId: 'semantic-approval',
      interactionKind: 'approval',
      revision: '2',
      decision: 'accepted',
    },
    [
      {
        kind: 'interaction',
        name: 'semantic-approval-result',
        body: {
          request: options.nodeDetails
            ? {
                title: '修复方案确认',
                questions: [
                  {
                    id: 'q1',
                    question: '是否保留权限拒绝检查？',
                    options: [
                      { id: 'keep', label: '保留', description: '等待会话恢复后继续核对权限。' },
                      { id: 'skip', label: '跳过' },
                    ],
                  },
                ],
              }
            : { title: '修改路由守卫' },
          answer: options.nodeDetails
            ? { kind: 'question', answers: { q1: 'keep' } }
            : { decision: 'approve', scope: '仅此次' },
        },
      },
    ],
  );
  add(
    'tool',
    'semantic-edit',
    'completed',
    edit,
    [
      {
        kind: 'tool_result',
        name: 'semantic-edit-result',
        body: {
          outcome: 'succeeded',
          content: '已修改 src/auth/guard.ts。',
          presentation: { kind: 'file', operation: 'edit', path: 'src/auth/guard.ts' },
        },
      },
      {
        kind: 'file_change',
        name: 'semantic-edit-diff',
        body: {
          format: 'line_diff',
          path: 'src/auth/guard.ts',
          text: '-return checkLogin();\n+await session.whenReady();\n+return checkLogin();',
          truncated: false,
        },
      },
    ],
    { parentExecutionId: model },
  );
  const shell = (operation: string, extra = {}) => ({
    ...root,
    definitionId: `shell.${operation}`,
    definitionVersion: '1',
    display: {
      kind: 'shell',
      title: operation === 'execute' ? '运行命令' : operation === 'read' ? '读取输出' : '等待命令',
      ...(operation === 'execute' ? { summary: '运行认证测试' } : {}),
      operation,
      targetExecutionId: 'semantic-shell-job',
      targetExecutionOriginStoreId: 'store',
      ...extra,
    },
  });
  add(
    'tool',
    'semantic-shell-launch',
    'planned',
    shell('execute'),
    [
      {
        kind: 'tool_input',
        name: 'semantic-shell-input',
        body: {
          command: 'npm test -- auth/session.test.ts',
          workdir: '/workspace/demo-app',
          background: true,
        },
      },
    ],
    { parentExecutionId: model },
  );
  add('job', 'semantic-shell-job', 'planned', shell('execute'), [], {
    parentExecutionId: 'semantic-shell-launch',
  });
  add(
    'job',
    'semantic-shell-job',
    'running',
    shell('execute', { observedStatus: 'running' }),
    [{ kind: 'job_output', name: 'semantic-shell-prefix', body: output('认证测试正在运行。') }],
    { parentExecutionId: 'semantic-shell-launch' },
  );
  add(
    'tool',
    'semantic-shell-launch',
    'completed',
    shell('execute', { accepted: true, observedStatus: 'running' }),
    [
      {
        kind: 'tool_result',
        name: 'semantic-shell-receipt',
        body: {
          outcome: 'succeeded',
          content: '后台命令已受理。',
          presentation: {
            kind: 'shell',
            operation: 'execute',
            executionId: 'semantic-shell-job',
            status: 'running',
            accepted: true,
            terminal: false,
          },
        },
      },
    ],
    { parentExecutionId: model },
  );
  for (let index = 0; index < 5; index++) {
    const operation = index < 3 ? 'read' : 'wait',
      id = `semantic-shell-observe-${index + 1}`;
    add(
      'tool',
      id,
      'planned',
      shell(operation),
      [
        {
          kind: 'tool_input',
          name: `${id}-input`,
          body:
            operation === 'read'
              ? { shell_id: 'semantic-shell', cursor: String(index) }
              : { shell_id: 'semantic-shell', wait_ms: 1000 },
        },
      ],
      { parentExecutionId: model },
    );
    add(
      'tool',
      id,
      'completed',
      shell(operation, {
        observedStatus: 'running',
        ...(operation === 'wait' ? { timedOut: true } : {}),
      }),
      [
        {
          kind: 'tool_result',
          name: `${id}-result`,
          body: {
            outcome: 'succeeded',
            content:
              operation === 'wait' ? '等待超时，命令仍在运行。' : `读取第 ${index + 1} 段原输出。`,
            presentation: {
              kind: 'shell',
              operation,
              executionId: 'semantic-shell-job',
              status: 'running',
              terminal: false,
              ...(operation === 'wait'
                ? { timedOut: true }
                : {
                    output: [
                      {
                        sequence: String(index + 1),
                        throughSequence: String(index + 1),
                        stream: 'stdout',
                        content: `原输出片段 ${index + 1}`,
                      },
                    ],
                  }),
            },
          },
        },
      ],
      { parentExecutionId: model },
    );
  }
  const task = {
    ...root,
    definitionId: 'task.spawn',
    definitionVersion: '1',
    display: {
      kind: 'task',
      title: '创建子 Agent',
      summary: '回归检查',
      operation: 'spawn',
      targetExecutionId: 'semantic-child-job',
      targetExecutionOriginStoreId: 'store',
      targetSessionId: 'semantic-child',
      targetRunId: 'semantic-child-run',
    },
  };
  add(
    'tool',
    'semantic-spawn',
    'planned',
    task,
    [
      {
        kind: 'tool_input',
        name: 'semantic-child-input',
        body: {
          taskName: '回归检查',
          prompt: '独立核对会话恢复与权限拒绝行为。',
          preset: 'reviewer',
        },
      },
    ],
    { parentExecutionId: model },
  );
  add('job', 'semantic-child-job', 'planned', { ...task, childSessionId: 'semantic-child' }, [], {
    parentExecutionId: 'semantic-spawn',
  });
  add(
    'job',
    'semantic-child-job',
    'running',
    {
      ...task,
      childSessionId: 'semantic-child',
      display: { ...task.display, observedStatus: 'running' },
    },
    [],
    { parentExecutionId: 'semantic-spawn' },
  );
  add(
    'tool',
    'semantic-spawn',
    'completed',
    { ...task, display: { ...task.display, accepted: true } },
    [
      {
        kind: 'tool_result',
        name: 'semantic-child-accepted',
        body: {
          outcome: 'succeeded',
          content: '回归检查任务已受理。',
          presentation: {
            kind: 'task',
            operation: 'spawn',
            executionId: 'semantic-child-job',
            runId: 'semantic-child-run',
            accepted: true,
            status: 'running',
          },
        },
      },
    ],
    { parentExecutionId: model },
  );
  add('child', 'semantic-child-job', 'observed', {
    childSessionId: 'semantic-child',
    childRunId: 'semantic-child-run',
    carrierExecutionId: 'semantic-child-job',
    delivery: 'pending',
  });
  const child = { sessionId: 'semantic-child', runId: 'semantic-child-run' };
  add('run', undefined, 'running', { ...root }, [], child);
  message('semantic-child-user', 'user', '1', '独立核对会话恢复与权限拒绝行为。', undefined, child);
  const childModel = {
    ...root,
    definitionId: 'fixture.respond',
    definitionVersion: '1',
    display: {
      kind: 'model',
      title: '请求模型',
      modelName: 'gpt-6-luna',
      operation: 'request',
      requestContext: { systemMessages: 1, historyMessages: 1, tools: 1 },
    },
  };
  add(
    'model',
    'semantic-child-model',
    'planned',
    childModel,
    [
      {
        kind: 'model_input',
        name: 'semantic-child-model-input',
        body: requestBody(
          'semantic-child-model',
          '子 Agent 的准确原请求',
          '独立核对会话恢复与权限拒绝行为。',
        ),
      },
    ],
    child,
  );
  add(
    'model',
    'semantic-child-model',
    'completed',
    childModel,
    [
      {
        kind: 'model_output',
        name: 'semantic-child-model-output',
        body: {
          content: '我将读取修改后的守卫并核对权限拒绝分支。',
          reasoning: '子 Agent 的公开思考：独立检查恢复流程与权限拒绝分支。',
          complete: true,
          toolCalls: [],
        },
      },
    ],
    child,
  );
  const childFile = { ...file, display: { ...file.display, summary: 'src/auth/guard.ts' } };
  add(
    'tool',
    'semantic-child-read',
    'planned',
    childFile,
    [
      {
        kind: 'tool_input',
        name: 'semantic-child-read-input',
        body: { path: 'src/auth/guard.ts' },
      },
    ],
    { ...child, parentExecutionId: 'semantic-child-model' },
  );
  add(
    'tool',
    'semantic-child-read',
    'completed',
    childFile,
    [
      {
        kind: 'tool_result',
        name: 'semantic-child-read-result',
        body: {
          outcome: 'succeeded',
          content: '权限拒绝分支仍保留。',
          presentation: {
            kind: 'file',
            operation: 'read',
            path: 'src/auth/guard.ts',
            text: 'await session.whenReady();\nreturn checkLogin();',
          },
        },
      },
    ],
    { ...child, parentExecutionId: 'semantic-child-model' },
  );
  message(
    'semantic-child-reply',
    'assistant',
    '2',
    '权限拒绝逻辑仍保留，修复范围符合要求。',
    'semantic-child-model',
    child,
  );
  add('run', undefined, 'completed', root, [], child);
  add(
    'job',
    'semantic-child-job',
    'completed',
    {
      ...task,
      childSessionId: 'semantic-child',
      delivery: 'consumed',
      display: { ...task.display, observedStatus: 'succeeded', terminal: true },
    },
    [
      {
        kind: 'job_output',
        name: 'semantic-child-result',
        body: output('权限拒绝逻辑仍保留，修复范围符合要求。'),
      },
    ],
    { parentExecutionId: 'semantic-spawn' },
  );
  const compression = {
    ...root,
    definitionId: 'fixture.compress',
    compressionId: 'semantic-compression',
    compressionTrigger: 'automatic',
    compression: {
      adopted: false,
      triggerTokens: 12200,
      triggerBasis: 'local_estimate',
      estimatedInputTokens: 12200,
      measuredInputTokens: 0,
      thresholdTokens: 12000,
    },
  };
  add('model', 'semantic-compress', 'planned', compression, [], { parentExecutionId: model });
  add(
    'model',
    'semantic-compress',
    'completed',
    compression,
    [
      {
        kind: 'model_output',
        name: 'semantic-summary',
        body: {
          content:
            '## 已采用摘要\n\n- 登录守卫已等待会话恢复。\n- 权限拒绝逻辑保留。\n- 后台认证测试尚在运行。',
          complete: true,
        },
      },
    ],
    { parentExecutionId: model },
  );
  add(
    'context',
    'semantic-compress',
    'observed',
    {
      compressionId: compression.compressionId,
      compressionTrigger: compression.compressionTrigger,
      action: 'compressed',
      compression: {
        ...compression.compression,
        adopted: true,
        accounting: { basis: 'local-context-estimate-v1', beforeTokens: 12200, afterTokens: 2600 },
      },
    },
    [
      {
        kind: 'context',
        name: 'semantic-retained-context',
        body: {
          selection: {
            boundarySeq: '7',
            tailFromSeq: '12',
            ranges: [{ afterSeq: '7', throughSeq: '15' }],
          },
        },
      },
    ],
    { sourceEventType: 'context.compressed' },
  );
  message(
    'semantic-reply',
    'assistant',
    '2',
    '修复已写入，权限检查保留；后台测试仍在运行。',
    model,
  );
  return {
    bodies,
    bodyKey,
    completeShell() {
      add(
        'job',
        'semantic-shell-job',
        'completed',
        shell('execute', { observedStatus: 'succeeded', terminal: true, exitCode: 0 }),
        [
          {
            kind: 'job_output',
            name: 'semantic-shell-final',
            body: output('24 项认证测试通过，退出码 0。', '6'),
          },
        ],
        { parentExecutionId: 'semantic-shell-launch' },
      );
      message(
        'semantic-reply',
        'assistant',
        '2',
        '登录恢复已修复，权限检查保留，24 项认证测试通过。',
        model,
      );
      add('run', undefined, 'completed', root);
    },
  };
}
