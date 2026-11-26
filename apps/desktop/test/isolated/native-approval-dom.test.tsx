import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Execution, Interaction } from '@kite-ai/client';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { prepareDesktopDom } from '../native-page-dom.fixture';

// The original Radix Portal selects its layout effect at import time, as in the model-picker fixture.
const bootstrap = new JSDOM('<div></div>', { pretendToBeVisual: true });
const priorBootstrap = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
};
Object.assign(globalThis, {
  window: bootstrap.window,
  document: bootstrap.window.document,
  navigator: bootstrap.window.navigator,
});
const { createRoot } = await import('react-dom/client');
const { InteractionCard } = await import('@kite-ai/ui');
const { NativeApproval } = await import('../../src/native-approval');
const { desktopToolMessage, NativeToolMessage } = await import('../../src/native-tool-messages');
Object.assign(globalThis, priorBootstrap);
bootstrap.window.close();

function fixture() {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const layout = prepareDesktopDom(dom),
    previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  return {
    dom,
    host,
    root,
    async close() {
      await act(async () => root.unmount());
      // Radix FocusScope restores focus on a zero-delay timer after unmount.
      // Keep this window's CustomEvent installed until the restoration completes.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      dom.window.close();
      layout();
      Object.assign(globalThis, previous);
    },
  };
}
const card: Interaction = {
  id: 'approval',
  originStoreId: 'store',
  sessionId: 's',
  runId: 'r',
  executionId: 'tool',
  presentationSessionId: 's',
  ancestry: ['s'],
  attempt: 1,
  kind: 'approval',
  definitionId: 'shell.execute',
  definitionVersion: '1',
  inputDigest: 'original-input',
  policyRevision: 'p1',
  requiredRefs: [],
  request: null,
  answer: null,
  revision: '1',
  acceptedDecisionRevision: null,
  state: 'pending',
};

type ApprovalJson = NonNullable<Interaction['request']>;

test('the original Approval form consumes the verified complete request and submits only the original card and offered grant', async () => {
  const deadline = Date.now() + 5000;
  const f = fixture(),
    answers: { id: string; answer: unknown }[] = [];
  const options: ApprovalJson[] = [
    { optionId: 'once', kind: 'once', presentation: { label: '仅此次', details: [] } },
    {
      optionId: 'scope-example',
      kind: 'scope',
      ruleId: 'builtin.shell.command',
      contractId: 'builtin.shell.exact-command',
      scope: { commandDigest: 'sealed-original-command' },
      presentation: {
        label: '本 Session 相同命令',
        details: ['仅限此会话的完整相同命令、环境与执行范围'],
      },
    },
  ];
  const request = {
    definitionId: 'shell.execute',
    definitionVersion: '1',
    options,
    policy: {
      reason: '原人工原因',
      executionScope: { filesystem: 'workspace_write', network: 'internet' },
    },
    input: { command: 'printf "原命令 雪🙂"\r\n' },
  };
  const text = JSON.stringify(request),
    content = new TextEncoder().encode(text);
  const reference = {
    id: 'body',
    mediaType: 'application/json',
    size: String(content.length),
    scope: { kind: 'execution' as const, id: 'tool' },
  };
  const original = {
    ...card,
    request: {
      ...request,
      input: {},
      policy: { check: { kind: 'artifact', complete: true, reference } },
    },
  };
  const render = (interaction = original) =>
    f.root.render(
      <InteractionCard
        interaction={interaction}
        onReadAttachment={async () => ({
          reference: { ...reference, hash: createHash('sha256').update(content).digest('hex') },
          content,
        })}
        onAnswer={(current, answer) => {
          answers.push({ id: current.id, answer });
        }}
        renderApproval={(props) => <NativeApproval {...props} />}
      />,
    );
  try {
    await act(async () => render());
    const approve = (label = '仅此次') =>
      [...f.host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === label,
      )!;
    expect(approve().disabled).toBe(true);
    expect(f.host.querySelector('[aria-label="更多批准方式"]')).toBeNull();
    expect(f.host.querySelector('.approval-command')?.hasAttribute('tabindex')).toBe(false);
    await act(async () => approve().click());
    expect(answers).toEqual([]);
    await act(async () =>
      [...f.host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Load complete attachment')!
        .click(),
    );
    while (!f.host.querySelector('[data-complete-attachment="verified"]')) {
      if (f.host.querySelector('[role="alert"]')) throw new Error('approval_attachment_unverified');
      if (Date.now() >= deadline) throw new Error('approval_attachment_dom_deadline');
      await act(async () => await Bun.sleep(5));
    }
    const command = f.host.querySelector<HTMLElement>('.approval-command')!;
    expect(command.textContent).toBe(request.input.command);
    await act(async () => command.focus());
    expect(f.dom.window.document.querySelector('.approval-command-tooltip code')?.textContent).toBe(
      request.input.command,
    );
    await act(async () => command.blur());
    expect(approve('允许联网').disabled).toBe(false);
    expect(approve('允许联网').getAttribute('aria-description')).toBe('仅批准此次');
    const menu = f.host.querySelector<HTMLButtonElement>('[aria-label="更多批准方式"]')!;
    await act(async () =>
      menu.dispatchEvent(
        new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      ),
    );
    const same = f.dom.window.document.querySelector<HTMLElement>('[role="menuitem"]')!;
    expect(same.textContent).toBe('允许此命令后续联网');
    expect(same.getAttribute('aria-description')).toContain('当前会话');
    expect(same.querySelector('small')).toBeNull();
    expect(same.textContent).not.toContain('仅限此会话的完整相同命令、环境与执行范围');
    await act(async () => same.click());
    expect(answers).toEqual([
      {
        id: 'approval',
        answer: { kind: 'approval', decision: 'approve', optionId: 'scope-example' },
      },
    ]);
    await act(async () => render({ ...original, id: 'other-card', revision: '2' }));
    expect(approve().disabled).toBe(true);
    await act(async () => approve().click());
    expect(answers).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('original tool labels distinguish saved, accepted and automatic decisions without converting approval into tool success', async () => {
  const f = fixture();
  const human: NonNullable<Execution['authorization']>['human'] = {
    interactionId: 'original',
    state: 'answered',
    revision: '2',
    acceptedDecisionRevision: null,
    accepted: false,
    decision: 'approve',
    optionId: 'scope-example',
    optionKind: 'scope',
    presentation: { label: '本会话相同命令', details: ['原完整命令'] },
  };
  const render = async (
    authorization: NonNullable<Execution['authorization']>,
    status: Execution['status'] = 'failed',
  ) => {
    const model = desktopToolMessage(
      { definitionId: 'files.write', definitionVersion: '2', status, authorization },
      'original-tool',
      '原结果正文',
    );
    await act(async () => f.root.render(<NativeToolMessage message={model} />));
    return model;
  };
  const expectApproval = (label: string) => {
    const marker = f.host.querySelector('.tool-approval');
    expect(marker?.getAttribute('role')).toBe('img');
    expect(marker?.getAttribute('aria-label')).toBe(label);
    expect(f.host.textContent).not.toContain(label);
  };
  try {
    const saved = await render({ dispatched: false, human });
    expectApproval('审批答复已提交');
    expect(saved.status).toBe('failed');
    await render({
      dispatched: false,
      human: { ...human, accepted: true, acceptedDecisionRevision: '2' },
    });
    expect(
      f.host.querySelector('[role="img"][aria-label="已人工批准 · 本会话相同命令"]'),
    ).not.toBeNull();
    const denied = await render({ dispatched: false, human: { ...human, decision: 'deny' } });
    expectApproval('人工审批已拒绝');
    expect(denied.dispatchCommitted).toBe(false);
    expect(denied.status).toBe('failed');
    expect(f.host.textContent).not.toContain('成功');
    await render({ dispatched: false, human: { ...human, state: 'cancelled' } });
    expectApproval('审批已取消');
    await render({
      dispatched: true,
      check: {
        executionId: 'check',
        status: 'succeeded',
        decision: 'approve_once',
        reason: '原自动批准原因',
        requireApproval: false,
      },
    });
    expect(f.host.querySelector('[role="img"][aria-label="已自动批准"]')).not.toBeNull();
    await render({
      dispatched: false,
      check: {
        executionId: 'check',
        status: 'failed',
        decision: 'unavailable',
        reason: '原结果未知',
        requireApproval: false,
      },
    });
    expectApproval('自动审批结果未知');
    for (const decision of ['ask_user', 'unavailable'] as const) {
      const reason = `原转人工原因 ${decision} 雪🙂`;
      const awaiting = await render(
        {
          dispatched: false,
          human: {
            ...human,
            state: 'pending',
            decision: null,
            optionId: undefined,
            optionKind: undefined,
            presentation: undefined,
          },
          check: {
            executionId: 'check',
            status: decision === 'ask_user' ? 'succeeded' : 'failed',
            decision,
            reason,
            requireApproval: false,
          },
        },
        'planned',
      );
      expectApproval('等待人工审批');
      expect(awaiting.approval?.reason).toBe(reason);
      expect(f.host.textContent).not.toContain('已人工批准');
    }
    await render(
      {
        dispatched: false,
        check: {
          executionId: 'check',
          status: 'running',
          decision: 'unavailable',
          reason: 'check_not_succeeded',
          requireApproval: false,
        },
      },
      'planned',
    );
    expectApproval('正在自动审批');
    await render(
      {
        dispatched: false,
        check: {
          executionId: 'check',
          status: 'cancelled',
          decision: 'unavailable',
          reason: 'check_not_succeeded',
          requireApproval: false,
        },
      },
      'cancelled',
    );
    expectApproval('自动审批已停止');
  } finally {
    await f.close();
  }
});

test('compact Shell approvals expose only the exact command on keyboard focus', async () => {
  const f = fixture();
  const command = 'printf "line one"\nprintf "line two"';
  try {
    for (const definitionId of ['shell.execute', 'shell.launch', 'shell.command']) {
      const request = {
        definitionId,
        definitionVersion: '1',
        options: [
          { optionId: 'once', kind: 'once', presentation: { label: '仅此次', details: [] } },
        ],
        input: { command, filesystem: 'full_access', network: 'internet' },
        policy: { reason: 'approval_required' },
        approvalControlReads: [{ kind: 'permission.mode', revision: '0', scope: 'user' }],
      };
      await act(async () =>
        f.root.render(
          <InteractionCard
            key={definitionId}
            compactApproval
            interaction={{ ...card, definitionId, request }}
            onAnswer={() => {}}
            renderApproval={(props) => <NativeApproval {...props} embedded />}
          />,
        ),
      );
      const trigger = f.host.querySelector<HTMLElement>('.approval-command')!;
      expect(trigger.textContent).toBe(command);
      expect(f.host.querySelector('details')).toBeNull();
      await act(async () => trigger.focus());
      const full = f.dom.window.document.querySelector('.approval-command-tooltip code');
      expect(full?.textContent).toBe(command);
      await act(async () => trigger.blur());
    }
  } finally {
    await f.close();
  }
});

test('native Windows user-process scope is visible before deciding and cannot be spoofed by input', async () => {
  const f = fixture();
  try {
    for (const native of [false, true]) {
      const request = {
        definitionId: 'shell.command',
        definitionVersion: '1',
        input: { command: 'printf ok', windowsNativeUserProcess: true },
        policy: {
          reason: 'approval_required',
          ...(native
            ? {
                windowsNativeUserProcess: true,
                executionScope: { filesystem: 'full_access', network: 'internet' },
              }
            : {}),
        },
        options: [
          { optionId: 'once', kind: 'once', presentation: { label: '仅此次', details: [] } },
        ],
      };
      await act(async () =>
        f.root.render(
          <NativeApproval
            interaction={{ ...card, definitionId: 'shell.command', request }}
            disabled={false}
            onAnswer={() => {}}
            embedded
          />,
        ),
      );
      expect(!!f.host.querySelector('.approval-native-scope')).toBe(native);
      if (native)
        expect(f.host.querySelector('.approval-native-scope')!.textContent).toContain(
          '不限于工作区',
        );
      expect(f.host.querySelector('.approval-command')?.textContent).toBe('printf ok');
    }
  } finally {
    await f.close();
  }
});

test('one file batch card shows icon, filename and counts per edit with one approval and keeps its action label after splitting', async () => {
  const f = fixture();
  const answers: unknown[] = [];
  const input = { path: '/work/config.ts', find: 'before 1', replace: 'after 1' };
  const request = {
    definitionId: 'files.edit',
    definitionVersion: '2',
    input,
    fileEditBatch: {
      kind: 'file_edit_batch@1',
      digest: 'a'.repeat(64),
      counts: { added: 12, removed: 4 },
      members: [
        { ...input, callId: 'one', replaceAll: false, counts: { added: 7, removed: 2 } },
        {
          ...input,
          callId: 'two',
          find: 'before 2',
          replace: 'after 2',
          replaceAll: true,
          counts: { added: 5, removed: 2 },
        },
      ],
    },
    options: [{ optionId: 'once', kind: 'once', presentation: { label: '允许编辑', details: [] } }],
  };
  const render = (data: typeof request) =>
    f.root.render(
      <NativeApproval
        interaction={{ ...card, definitionId: 'files.edit', definitionVersion: '2', request: data }}
        disabled={false}
        onAnswer={(_, answer) => {
          answers.push(answer);
        }}
      />,
    );
  try {
    await act(async () => render(request));
    expect(f.host.querySelector('details, pre')).toBeNull();
    expect(f.host.querySelector('.approval-tool-label')).toBeNull();
    const rows = () => [...f.host.querySelectorAll('.approval-edit-list li')];
    expect(rows().map((row) => row.querySelector('.approval-command')?.textContent)).toEqual([
      'config.ts',
      'config.ts',
    ]);
    expect(rows().every((row) => row.querySelector('svg.approval-edit-icon'))).toBe(true);
    expect(
      rows().map((row) => row.querySelector('.approval-edit-line-counts')?.textContent),
    ).toEqual(['+7−2', '+5−2']);
    expect(rows()[0]?.querySelector('.approval-edit-count-description')?.textContent).toBe(
      '新增 7 行，删除 2 行',
    );
    expect(f.host.textContent).not.toMatch(/修改 [12]|\+12|新增 12 行/);
    expect(f.host.textContent).not.toContain(input.find);
    expect(f.host.querySelector('[aria-label="更多批准方式"]')).toBeNull();
    const approve = () =>
      [...f.host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.className.includes('primary'),
      )!;
    expect(approve().disabled).toBe(false);
    expect(approve().textContent).toBe('允许编辑');
    await act(async () => approve().click());
    expect(answers).toEqual([{ kind: 'approval', decision: 'approve', optionId: 'once' }]);
    await act(async () =>
      render({
        ...request,
        fileEditBatch: {
          ...request.fileEditBatch,
          members: request.fileEditBatch.members.map((member) =>
            member.callId === 'one' ? { ...member, counts: { added: -3, removed: 2 } } : member,
          ),
        },
      }),
    );
    expect(rows()[0]?.querySelector('.approval-edit-line-counts')).toBeNull();
    expect(rows()[1]?.querySelector('.approval-edit-line-counts')?.textContent).toBe('+5−2');
    expect(f.host.querySelectorAll('.approval-edit-list li')).toHaveLength(2);
    expect(approve().disabled).toBe(false);
    await act(async () => render({ ...request, input: { ...input, find: 'changed' } }));
    expect(f.host.querySelector('details')).toBeNull();
    expect(approve().disabled).toBe(true);

    // The ordinary request may retain the generic wire label. Its verified
    // external edit effect has the same visible action name, with its own ID.
    const { fileEditBatch: _retired, ...independent } = request;
    await act(async () =>
      f.root.render(
        <NativeApproval
          interaction={{
            ...card,
            id: 'after-mode-switch',
            definitionId: independent.definitionId,
            definitionVersion: independent.definitionVersion,
            request: {
              ...independent,
              policy: { effects: ['external'] },
              options: [
                {
                  optionId: 'independent-once',
                  kind: 'once',
                  presentation: { label: '仅此次', details: [] },
                },
              ],
            },
          }}
          disabled={false}
          onAnswer={(interaction, answer) => {
            answers.push({ id: interaction.id, answer });
          }}
        />,
      ),
    );
    expect(rows()).toHaveLength(0);
    expect(approve().textContent).toBe('允许编辑');
    await act(async () => approve().click());
    expect(answers.at(-1)).toEqual({
      id: 'after-mode-switch',
      answer: { kind: 'approval', decision: 'approve', optionId: 'independent-once' },
    });
  } finally {
    await f.close();
  }
});

test('ordinary approval copy reflects frozen scope and preserves original once and reusable option IDs', async () => {
  const f = fixture();
  const once = {
    optionId: 'once',
    kind: 'once',
    presentation: { label: '仅此次', details: [] },
  };
  const fileScope = {
    optionId: 'original-file-binding',
    kind: 'scope',
    ruleId: 'builtin.files.location',
    contractId: 'builtin.files.exact-location',
    scope: { path: 'owned.txt' },
    presentation: { label: '本会话内对此文件编辑和写入', details: ['File scope internals'] },
  };
  const shellScope = {
    optionId: 'original-shell-binding',
    kind: 'scope',
    ruleId: 'builtin.shell.command',
    contractId: 'builtin.shell.exact-command',
    scope: { commandDigest: 'sealed-command' },
    presentation: { label: '本会话内相同命令', details: ['Shell scope internals'] },
  };
  const webScope = {
    optionId: 'original-web-binding',
    kind: 'scope',
    ruleId: 'builtin.web.origin',
    contractId: 'builtin.web.exact-origin',
    scope: { origin: 'https://example.com:8443' },
    presentation: { label: '原站点范围', details: ['Origin scope internals'] },
  };
  const unrelatedScope = {
    ...shellScope,
    optionId: 'unrelated-original-id',
    ruleId: 'some.other.rule',
    contractId: 'some.other.contract',
    presentation: { label: '原范围文案', details: ['原范围详细说明'] },
  };
  const windows = {
    windowsNativeUserProcess: true,
    executionScope: { filesystem: 'full_access', network: 'internet' },
  };
  const external = { effects: ['external'] };
  const shellPolicy = (filesystem: string, network: string) => ({
    executionScope: { filesystem, network },
  });
  const testCases: {
    definitionId?: string;
    definitionVersion?: string;
    policy: ApprovalJson;
    scope?: Record<string, ApprovalJson> & { optionId: string };
    onceLabel: string;
    scopeLabel?: string;
    native?: boolean;
  }[] = [
    {
      definitionId: 'files.write',
      definitionVersion: '3',
      policy: { policies: [external] },
      scope: fileScope,
      onceLabel: '允许编辑',
      scopeLabel: '允许后续编辑',
    },
    {
      definitionId: 'files.edit',
      definitionVersion: '2',
      policy: { kind: 'approval_after_check_timeout', originalRequest: external },
      onceLabel: '允许编辑',
    },
    {
      definitionId: 'files.read',
      definitionVersion: '5',
      policy: external,
      onceLabel: '允许读取',
    },
    {
      policy: shellPolicy('full_access', 'none'),
      scope: shellScope,
      onceLabel: '允许写入工作区外',
      scopeLabel: '允许后续运行此命令',
    },
    {
      policy: { policies: [shellPolicy('full_access', 'internet')] },
      scope: shellScope,
      onceLabel: '允许联网及工作区外写入',
      scopeLabel: '允许后续运行此命令',
    },
    {
      // A restricted PowerShell approval that offers only "once" must not get a
      // reusable grant just because its host policy allows this call to go online.
      policy: shellPolicy('workspace_write', 'internet'),
      onceLabel: '允许联网',
    },
    {
      policy: shellPolicy('workspace_write', 'none'),
      onceLabel: '允许运行',
    },
    {
      policy: {
        policies: [shellPolicy('full_access', 'none'), shellPolicy('workspace_write', 'internet')],
      },
      onceLabel: '批准（范围未确认）',
    },
    {
      policy: { kind: 'approval_after_check_timeout', originalRequest: windows },
      onceLabel: '仅此次',
      native: true,
    },
    {
      definitionId: 'web_fetch',
      policy: { policies: [{ effects: ['network', 'unknown'] }] },
      scope: webScope,
      onceLabel: '允许联网',
      scopeLabel: '允许后续访问此站点',
    },
    {
      definitionId: 'web_fetch',
      policy: { effects: ['network', 'unknown'] },
      onceLabel: '允许联网',
    },
    {
      definitionId: 'web_fetch',
      policy: { reason: 'legacy unknown scope' },
      onceLabel: '仅此次',
    },
    {
      definitionId: 'git.worktree',
      policy: { ...external, ...shellPolicy('full_access', 'internet') },
      scope: unrelatedScope,
      onceLabel: '仅此次',
      scopeLabel: '原范围文案原范围详细说明',
    },
  ];
  const answerLog: unknown[] = [];
  try {
    for (const [index, current] of testCases.entries()) {
      const definitionId = current.definitionId ?? 'shell.execute';
      const definitionVersion = current.definitionVersion ?? '1';
      const interaction = {
        ...card,
        definitionId,
        definitionVersion,
        request: {
          definitionId,
          definitionVersion,
          input: {
            ...(definitionId === 'web_fetch'
              ? { urls: ['https://example.com:8443/first', 'https://example.com:8443/second'] }
              : { path: '/owned/isolated/owned.txt' }),
            command: 'printf app-fixture',
            filesystem: 'full_access',
            network: 'internet',
            windowsNativeUserProcess: true,
          },
          policy: current.policy,
          options: current.scope ? [once, current.scope] : [once],
        },
      };
      const render = () =>
        f.root.render(
          <InteractionCard
            key={index}
            compactApproval
            interaction={interaction}
            onAnswer={(source, answer) => {
              expect(source).toBe(interaction);
              answerLog.push(answer);
            }}
            renderApproval={(props) => <NativeApproval {...props} embedded />}
          />,
        );
      await act(async () => render());
      expect(!!f.host.querySelector('.approval-native-scope')).toBe(!!current.native);
      if (definitionId.startsWith('files.'))
        expect(f.host.querySelector('.approval-command')?.textContent).toBe(
          '/owned/isolated/owned.txt',
        );
      if (definitionId === 'web_fetch')
        expect(f.host.querySelector('.approval-command')?.textContent).toBe(
          current.onceLabel === '允许联网'
            ? 'https://example.com:8443/first · https://example.com:8443/second'
            : 'legacy unknown scope',
        );
      const approve = [...f.host.querySelectorAll('button')].find(
        (button) => button.textContent === current.onceLabel,
      )!;
      expect(approve.disabled).toBe(false);
      await act(async () => approve.click());
      expect(answerLog.at(-1)).toEqual({
        kind: 'approval',
        decision: 'approve',
        optionId: 'once',
      });
      await act(async () => render());
      const menu = f.host.querySelector<HTMLButtonElement>('[aria-label="更多批准方式"]');
      expect(!!menu).toBe(!!current.scope);
      if (!menu) continue;
      await act(async () =>
        menu.dispatchEvent(
          new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
        ),
      );
      const items = f.dom.window.document.querySelectorAll<HTMLElement>('[role="menuitem"]');
      expect(items.length).toBe(1);
      const item = items[0]!;
      expect(item.textContent).toBe(current.scopeLabel!);
      if (current.scope !== unrelatedScope) {
        expect(item.querySelector('small')).toBeNull();
        expect(item.getAttribute('aria-description')).toContain('仅限当前会话');
      } else {
        expect(item.querySelector('small')?.textContent).toBe('原范围详细说明');
      }
      if (current.scope === webScope) {
        expect(item.getAttribute('title')).toBe('https://example.com:8443');
        expect(item.getAttribute('aria-description')).toBe(
          '仅限当前会话访问 https://example.com:8443。',
        );
      }
      await act(async () => item.click());
      expect(answerLog.at(-1)).toEqual({
        kind: 'approval',
        decision: 'approve',
        optionId: current.scope?.optionId,
      });
    }
  } finally {
    await f.close();
  }
});

const displayOnlyOnce = {
  optionId: 'original-once-id',
  kind: 'once',
  presentation: { label: '仅此次', details: [] },
};

test('worktree cards distinguish creation from deletion using the original verified action', async () => {
  const f = fixture();
  const base = { ...card, definitionId: 'git.worktree', definitionVersion: '1' };
  const path = '/owned/a-long-workspace-path/for-the-same-worktree';
  const answers: { source: Interaction; answer: unknown }[] = [];
  const requestFor = (input: ApprovalJson) =>
    ({
      definitionId: base.definitionId,
      definitionVersion: base.definitionVersion,
      input,
      policy: { reason: 'approval_required' },
      options: [displayOnlyOnce],
    }) satisfies ApprovalJson;
  const render = async (request: ApprovalJson, phase?: 'loading') => {
    const interaction = { ...base, request };
    await act(async () =>
      f.root.render(
        <NativeApproval
          interaction={interaction}
          disabled={false}
          attachment={phase ? { phase } : undefined}
          onAnswer={(source, answer) => {
            answers.push({ source, answer });
          }}
          embedded
        />,
      ),
    );
    return interaction;
  };
  const approve = (label: string) =>
    [...f.host.querySelectorAll('button')].find((button) => button.textContent === label);
  const label = () => f.host.querySelector('.approval-tool-label')?.textContent;
  const summary = () => f.host.querySelector('.approval-command')?.textContent;
  try {
    for (const [action, title, button] of [
      ['create', '创建 Git 工作树', '允许创建'],
      ['remove', '移除 Git 工作树', '允许移除'],
    ] as const) {
      const interaction = await render(requestFor({ action, path }));
      expect(label()).toBe(title);
      expect(summary()).toBe(path);
      expect(f.host.textContent).not.toContain('git.worktree');
      expect(approve(button)?.getAttribute('aria-description')).toBe('仅批准此次');
      await act(async () => approve(button)!.click());
      expect(answers.at(-1)).toEqual({
        source: interaction,
        answer: { kind: 'approval', decision: 'approve', optionId: 'original-once-id' },
      });
    }
    await render(requestFor({ action: 'create' }));
    expect(label()).toBe('创建 Git 工作树');
    expect(summary()).toBe('默认位置');

    await render(requestFor({ action: 'exit', path }));
    expect(label()).toBe('Git 工作树');
    expect(approve('允许移除')).toBeUndefined();

    const mismatched = {
      ...requestFor({ action: 'remove', path }),
      definitionVersion: '99',
    };
    await render(mismatched);
    expect(label()).toBe('Git 工作树');
    expect(summary()).toBe('完整审批内容尚不可用');
    expect(f.host.textContent).not.toContain(path);
    expect(approve('仅此次')?.disabled).toBe(true);

    await render(
      {
        ...requestFor({ action: 'remove', path }),
        policy: {
          check: {
            kind: 'artifact',
            complete: true,
            reference: {
              id: 'body',
              mediaType: 'application/json',
              size: '256',
              scope: { kind: 'execution', id: 'tool' },
            },
          },
        },
      },
      'loading',
    );
    expect(label()).toBe('Git 工作树');
    expect(summary()).toBe('正在核对完整审批内容…');
    expect(f.host.textContent).not.toContain(path);
    expect(approve('仅此次')?.disabled).toBe(true);
    expect(answers).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('ordinary search approval shows only the original bounded query and answers the original option', async () => {
  const f = fixture();
  const policy = { reason: 'approval_required', effects: ['network'] };
  const base = { ...card, definitionId: 'web.search', definitionVersion: '1' };
  const render = async (query: string, extra?: object, version = '1') => {
    const request = {
      definitionId: base.definitionId,
      definitionVersion: version,
      input: { query, ...extra },
      policy,
      options: [displayOnlyOnce],
    } satisfies ApprovalJson;
    const interaction = { ...base, request };
    const answers: { source: Interaction; answer: unknown }[] = [];
    await act(async () =>
      f.root.render(
        <NativeApproval
          interaction={interaction}
          disabled={false}
          onAnswer={(source, answer) => {
            answers.push({ source, answer });
          }}
          embedded
        />,
      ),
    );
    return { interaction, answers };
  };
  const contents = () => f.host.querySelector('.approval-command')!;
  const find = (text: string) =>
    [...f.host.querySelectorAll('button')].find((button) => button.textContent === text);
  try {
    const { interaction, answers } = await render('  社区图书馆\n开放时间\u202e   <b>示例</b>  ');
    const expected = '社区图书馆 开放时间 <b>示例</b>';
    expect(f.host.querySelector('.approval-tool-label')?.textContent).toBe('网页搜索');
    expect(contents().textContent).toBe(expected);
    expect(contents().querySelector('b')).toBeNull();
    expect(f.host.textContent).not.toMatch(/web\.search|approval_required|允许联网/);
    expect(f.host.querySelector('[aria-label="更多批准方式"]')).toBeNull();
    const approve = find('允许搜索')!;
    expect(approve.getAttribute('aria-description')).toBe('仅批准此次');
    await act(async () => (contents() as HTMLElement).focus());
    expect(f.dom.window.document.querySelector('.approval-command-tooltip code')?.textContent).toBe(
      expected,
    );
    await act(async () => (contents() as HTMLElement).blur());
    await act(async () => approve.click());
    expect(answers).toEqual([
      {
        source: interaction,
        answer: { kind: 'approval', decision: 'approve', optionId: 'original-once-id' },
      },
    ]);

    await render('🌿'.repeat(1025));
    expect(contents().textContent).toBe('🌿'.repeat(1024) + '…');
    await render('查询', { authority: 'spoofed extra field' });
    expect(contents().textContent).toBe('未能核对搜索内容');
    expect(contents().hasAttribute('tabindex')).toBe(false);
    expect(find('允许搜索')).toBeUndefined();
    expect(f.host.textContent).not.toContain('spoofed extra field');

    await render('不匹配的附加正文', undefined, '99');
    expect(contents().textContent).toBe('完整审批内容尚不可用');
    expect(find('仅此次')?.disabled).toBe(true);
    expect(f.host.textContent).not.toContain('不匹配的附加正文');
  } finally {
    await f.close();
  }
});

test('ordinary MCP approval uses only the exact registered policy name, never raw identifiers, payload or reason', async () => {
  const f = fixture();
  const definitionId = `mcp.mcp-${'a'.repeat(64)}.${'b'.repeat(32)}`;
  const definitionVersion = 'e'.repeat(64);
  const request = {
    definitionId,
    definitionVersion,
    input: { value: 'PRIVATE_MCP_INPUT', trustedToolLabel: 'MCP · injected · not-trusted' },
    policy: {
      reason: 'approval_required',
      effects: ['network'],
      mcpApprovalNames: { serverName: 'Owned-Docs', toolName: 'lookup_index' },
    },
    options: [displayOnlyOnce],
  } satisfies ApprovalJson;
  const cardWithRequest: Interaction = { ...card, definitionId, definitionVersion, request };
  const answers: { source: Interaction; answer: unknown }[] = [];
  const render = async (actual = cardWithRequest) =>
    act(async () =>
      f.root.render(
        <NativeApproval
          interaction={actual}
          disabled={false}
          onAnswer={(source, answer) => {
            answers.push({ source, answer });
          }}
          embedded
        />,
      ),
    );
  const expectNoLeaks = () =>
    expect(f.dom.window.document.body.textContent).not.toMatch(
      /approval_required|mcp\.mcp-|PRIVATE_MCP_INPUT|not-trusted|允许联网/,
    );
  try {
    await render();
    expect(f.host.querySelector('.approval-tool-label')?.textContent).toBe('MCP 工具');
    const detail = f.host.querySelector<HTMLElement>('.approval-command')!;
    expect(detail.textContent).toBe('Owned-Docs · lookup_index');
    await act(async () => detail.focus());
    expect(f.dom.window.document.querySelector('.approval-command-tooltip code')?.textContent).toBe(
      'Owned-Docs · lookup_index',
    );
    expectNoLeaks();
    await act(async () => detail.blur());
    expect(f.host.querySelector('[aria-label="更多批准方式"]')).toBeNull();
    const buttons = [...f.host.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['拒绝', '允许调用']);
    await act(async () => buttons[1]?.click());
    expect(answers.at(-1)).toEqual({
      source: cardWithRequest,
      answer: { kind: 'approval', decision: 'approve', optionId: 'original-once-id' },
    });

    await render({
      ...cardWithRequest,
      request: { ...request, policy: { reason: 'approval_required', effects: ['network'] } },
    });
    expect(f.host.querySelector('.approval-command')?.textContent).toBe('工具不可用');
    expect([...f.host.querySelectorAll('button')].some((b) => b.textContent === '允许调用')).toBe(
      false,
    );
    expectNoLeaks();
    await render({
      ...cardWithRequest,
      definitionId: 'mcp.sources.list',
      request: { ...request, definitionId: 'mcp.sources.list' },
    });
    expect(f.host.querySelector('.approval-tool-label')?.textContent).toBe('MCP 操作');
    expect(f.host.textContent).not.toMatch(/mcp\.sources\.list|lookup_index|允许调用/);
    expect(f.host.querySelector('.approval-command')?.hasAttribute('tabindex')).toBe(false);
  } finally {
    await f.close();
  }
});
