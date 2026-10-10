import { expect, test } from 'bun:test';
import type { Execution, SessionView } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import {
  TuiController,
  type TuiPort,
  type TuiPreferenceEdit,
  type TuiPreferences,
  TuiSession,
  type TuiState,
  verifyTuiPreferences,
} from '../../src/tui';
import { ComposerBuffer } from '../../src/tui/composer';
import { TuiComposer } from '../../src/tui/composer-input';
import { TuiExecutionPanel } from '../../src/tui/execution-panel';
import { TuiModelPanel } from '../../src/tui/model-panel';
import { TuiPermissionPanel } from '../../src/tui/permission-panel';
import { TuiPresentationProvider, tuiChinese } from '../../src/tui/presentation';
import { TuiAnswerInput } from '../../src/tui/question-panel';
import { TuiRecoveryPanel } from '../../src/tui/recovery-panel';
import { TuiSkillsPanel } from '../../src/tui/skills-panel';
import { TuiStatusPanel } from '../../src/tui/status-panel';

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
function fixture() {
  let facts: TuiPreferences = {
      revision: 'a'.repeat(64),
      language: 'en-US',
      resolvedLanguage: 'en-US',
      colorPreset: 'teal',
      theme: 'dark',
    },
    effects = 0,
    reads = 0;
  const edits: TuiPreferenceEdit[] = [];
  const forbidden = async (): Promise<never> => {
    effects++;
    throw Error('unexpected_business_effect');
  };
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => {
      effects++;
      return 'unexpected';
    },
    listSessions: async () => [{ id: 'a', title: 'Original title /path/model' }],
    readSession: async (id) => ({
      storeId: 'store',
      view: {
        storeId: 'store',
        session: { id, rootSessionId: id, parentSessionId: null, workspaceId: 'w' },
        runs: [],
        executions: [],
        messages: [],
      } as unknown as SessionView,
      messages: [
        {
          id: 'm',
          sessionId: id,
          role: 'assistant',
          status: 'completed',
          content: 'Models Theme Session /path/语言\nEXACT_MODEL_BODY',
        },
      ] as unknown as import('@kite-ai/client').Message[],
      interactions: [],
    }),
    submit: forbidden,
    answer: forbidden,
    cancel: forbidden,
    getCommand: forbidden,
    preferences: {
      read: async () => {
        reads++;
        return facts;
      },
      save: async (edit) => {
        edits.push(edit);
        if (edit.expectedRevision !== facts.revision) throw Error('tui_preferences_conflict');
        facts = {
          ...facts,
          [edit.key]: edit.value,
          revision: 'b'.repeat(64),
          resolvedLanguage:
            edit.key === 'language'
              ? edit.value === 'system'
                ? 'zh-CN'
                : (edit.value as 'zh-CN' | 'en-US')
              : facts.resolvedLanguage,
        };
        return facts;
      },
    },
  };
  const controller = new TuiController(port);
  return {
    port,
    controller,
    edits,
    setFacts: (value: TuiPreferences) => {
      facts = value;
    },
    counts: () => ({ effects, reads }),
    facts: () => facts,
  };
}
test('Ink saves selected theme/language only after persistence; switch retains text, original facts and no business effects', async () => {
  const f = fixture();
  await tick();
  await f.controller.select('a');
  f.controller.setDraft('unsent original');
  const ui = render(<TuiSession controller={f.controller} />);
  await tick();
  expect(ui.lastFrame()).toContain('EXACT_MODEL_BODY');
  await f.controller.routeCommand('/theme extra');
  expect(f.controller.state.error).toBe('unexpected_command_arguments');
  await f.controller.routeCommand('/theme');
  await tick();
  expect(ui.lastFrame()).toContain('Confirmed preferences');
  expect(ui.lastFrame()).not.toContain('Preference saved');
  ui.stdin.write('\u001b[B');
  await tick();
  ui.stdin.write('\r');
  await tick();
  expect(f.controller.state.preferences.colorPreset).toBe('blue');
  expect(f.edits).toHaveLength(1);
  expect(ui.lastFrame()).toContain('Preference saved');
  ui.stdin.write('\r');
  await tick();
  expect(f.edits).toHaveLength(1);
  ui.stdin.write('\u001b');
  await tick();
  await f.controller.routeCommand('/language');
  await tick();
  ui.stdin.write('\u001b[A');
  await tick();
  ui.stdin.write('\r');
  await tick();
  expect(f.controller.state.preferences.language).toBe('zh-CN');
  expect(ui.lastFrame()).toContain('偏好已保存');
  expect(ui.lastFrame()).toContain('生效语言： zh-CN');
  ui.stdin.write('\u0003');
  await tick();
  expect(ui.lastFrame()).toContain('会话 a');
  expect(ui.lastFrame()).toContain('空闲');
  expect(ui.lastFrame()).toContain('新 Run');
  expect(ui.lastFrame()).toContain('Ctrl+B 待决卡片');
  expect(ui.lastFrame()).toContain('Models Theme Session /path/语言');
  expect(ui.lastFrame()).toContain('unsent original');
  f.controller.togglePlanning();
  await tick();
  expect(ui.lastFrame()).toContain('计划下一 Run');
  const originalRead = f.port.readSession;
  f.port.readSession = async (id, signal) => {
    const snapshot = await originalRead(id, signal);
    return id === 'a'
      ? {
          ...snapshot,
          view: {
            ...snapshot.view,
            runs: [
              { id: 'original-active', sessionId: id, status: 'running', isActive: true },
            ] as SessionView['runs'],
          },
        }
      : snapshot;
  };
  await f.controller.select('a');
  await tick();
  expect(ui.lastFrame()).toContain('在原 Run 后排队计划');
  expect(ui.lastFrame()).toContain('unsent original');
  await f.controller.select('b');
  await tick();
  expect(f.controller.state.preferences.language).toBe('zh-CN');
  expect(ui.lastFrame()).toContain('会话 b');
  expect(f.counts().effects).toBe(0);
  ui.unmount();
  f.controller.dispose();
});
test('CAS failure retains old locale; Enter cannot retry until explicit R read, and CtrlC closes only the panel', async () => {
  const f = fixture();
  await tick();
  await f.controller.select('a');
  const ui = render(<TuiSession controller={f.controller} />);
  await tick();
  await f.controller.routeCommand('/language');
  await tick();
  f.setFacts({ ...f.facts(), revision: 'c'.repeat(64) });
  ui.stdin.write('\u001b[A');
  await tick();
  ui.stdin.write('\r');
  await tick();
  expect(f.controller.state.preferences.language).toBe('en-US');
  expect(ui.lastFrame()).toContain('Preference failed; previous values retained');
  expect(ui.lastFrame()).toContain('tui_preferences_conflict');
  ui.stdin.write('\r');
  await tick();
  expect(f.edits).toHaveLength(1);
  ui.stdin.write('r');
  await tick();
  expect(f.controller.state.preferences.revision).toBe('c'.repeat(64));
  ui.stdin.write('\r');
  await tick();
  expect(f.edits).toHaveLength(2);
  expect(f.controller.state.preferences.language).toBe('zh-CN');
  ui.stdin.write('\u0003');
  await tick();
  expect(f.controller.state.panel).toBeUndefined();
  expect(f.counts().effects).toBe(0);
  ui.unmount();
  f.controller.dispose();
});
test('late save is profile-global after close/switch, never reopens a panel; dispose ignores late facts and stale startup read', async () => {
  const f = fixture();
  await tick();
  await f.controller.select('a');
  let resolve!: (value: TuiPreferences) => void;
  f.port.preferences!.save = () =>
    new Promise((r) => {
      resolve = r;
    });
  f.controller.openPreferences('language');
  const pending = f.controller.savePreference({
    key: 'language',
    value: 'zh-CN',
    expectedRevision: f.facts().revision,
  });
  expect(f.controller.state.preferenceStatus).toBe('saving');
  f.controller.closePanel();
  await f.controller.select('b');
  resolve({ ...f.facts(), revision: 'd'.repeat(64), language: 'zh-CN', resolvedLanguage: 'zh-CN' });
  await pending;
  expect(f.controller.state.preferences.language).toBe('zh-CN');
  expect(f.controller.state.sessionId).toBe('b');
  expect(f.controller.state.panel).toBeUndefined();
  const second = f.controller.savePreference({
    key: 'language',
    value: 'en-US',
    expectedRevision: 'd'.repeat(64),
  });
  f.controller.dispose();
  resolve({ ...f.facts(), revision: 'e'.repeat(64) });
  await second;
  expect(f.controller.state.preferences.language).toBe('zh-CN');
  expect(f.counts().effects).toBe(0);
  let release!: (value: TuiPreferences) => void;
  const g = fixture();
  g.port.preferences!.read = () =>
    new Promise((r) => {
      release = r;
    });
  const old = g.controller.refreshPreferences();
  g.port.preferences!.read = async () => ({
    ...g.facts(),
    language: 'system',
    resolvedLanguage: 'zh-CN',
  });
  await g.controller.refreshPreferences();
  release(g.facts());
  await old;
  expect(g.controller.state.preferences.resolvedLanguage).toBe('zh-CN');
  g.controller.dispose();
});
test('closed preference snapshot rejects invalid identity, fixed locale mismatch and extra fields', () => {
  const f = fixture();
  for (const value of [
    undefined,
    null,
    {},
    { ...f.facts(), revision: '' },
    { ...f.facts(), language: 'zh-CN', resolvedLanguage: 'en-US' },
    { ...f.facts(), path: '/secret' },
    { ...f.facts(), colorPreset: 'violet' },
  ])
    expect(() => verifyTuiPreferences(value as TuiPreferences)).toThrow();
  f.controller.dispose();
});
test('all existing panel-owned headings use Chinese while public machine values remain original; system/light display is explicit', async () => {
  const f = fixture();
  await tick();
  const facts = {
    ...f.facts(),
    language: 'system' as const,
    resolvedLanguage: 'zh-CN' as const,
    theme: 'light' as const,
  };
  for (const [Panel, expected] of [
    [TuiModelPanel, '模型'],
    [TuiPermissionPanel, '权限 · 原会话'],
    [TuiStatusPanel, '宿主状态'],
    [TuiSkillsPanel, '知识 Skills'],
  ] as const) {
    const ui = render(
      <TuiPresentationProvider value={{ preferences: facts }}>
        <Panel controller={f.controller} />
      </TuiPresentationProvider>,
    );
    expect(ui.lastFrame()).toContain(expected);
    ui.unmount();
  }
  f.setFacts(facts);
  await f.controller.refreshPreferences();
  await f.controller.select('a');
  const ui = render(<TuiSession controller={f.controller} />);
  await tick();
  await f.controller.routeCommand('/language');
  await tick();
  expect(ui.lastFrame()).toContain('系统语言');
  expect(ui.lastFrame()).toContain('生效语言： zh-CN');
  expect(ui.lastFrame()).toContain('基础主题： light');
  f.controller.closePanel();
  f.controller.draftUnavailable('Theme');
  await tick();
  expect(ui.lastFrame()).toContain('错误： Theme');
  expect(ui.lastFrame()).not.toContain('错误： 主题');
  await f.controller.routeCommand('/bad');
  await tick();
  expect(ui.lastFrame()).toContain('错误： tui_command_unavailable');
  expect(ui.lastFrame()).toContain('Models Theme Session /path/语言');
  const labels = [
    'Idle Rewind: choose original boundary with arrows/Enter; 0 empty; Esc close',
    'Current selected Context projection, not actual Model input Inspector; Esc close',
    'Up/Down explicit approval selection:',
    'Ctrl+A: read required attachment. Approval: approve (once), approve same_command only if offered, deny. Question: original-schema JSON. Plan: approve offered mode / revise feedback / deny.',
  ];
  for (const label of labels) expect(tuiChinese[label]).toBeTruthy();
  expect(f.counts().effects).toBe(0);
  ui.unmount();
  f.controller.dispose();
});
test('publication uncertainty preserves last confirmed facts, never repeats save, and R reads actual publication', async () => {
  const f = fixture();
  await tick();
  await f.controller.select('a');
  f.port.preferences!.save = async (edit) => {
    f.edits.push(edit);
    f.setFacts({ ...f.facts(), revision: 'f'.repeat(64), colorPreset: 'blue' });
    throw Error('tui_preferences_publication_uncertain');
  };
  const ui = render(<TuiSession controller={f.controller} />);
  await tick();
  await f.controller.routeCommand('/theme');
  await tick();
  ui.stdin.write('\u001b[B');
  await tick();
  ui.stdin.write('\r');
  await tick();
  expect(ui.lastFrame()).toContain('Save outcome unknown; last confirmed values retained');
  expect(f.controller.state.preferences.colorPreset).toBe('teal');
  ui.stdin.write('\r');
  await tick();
  expect(f.edits).toHaveLength(1);
  ui.stdin.write('r');
  await tick();
  expect(f.controller.state.preferences.colorPreset).toBe('blue');
  expect(f.edits).toHaveLength(1);
  expect(f.counts().effects).toBe(0);
  ui.unmount();
  f.controller.dispose();
});
test('populated model, permission and Skill panels translate owned instructions while names, raw reasons and grants remain exact', async () => {
  const f = fixture();
  await tick();
  const preferences = {
    ...f.facts(),
    language: 'zh-CN' as const,
    resolvedLanguage: 'zh-CN' as const,
  };
  const state = {
    ...f.controller.state,
    models: {
      workspaceId: 'w',
      defaultModelId: 'Models',
      models: [
        {
          id: 'Models',
          provider: 'Language',
          model: 'Theme',
          enabled: true,
          configured: true,
          diagnostics: ['raw_configuration_code'],
        },
      ],
      errors: [],
    },
    permissions: {
      mode: {
        mode: 'ask',
        revision: '1',
        scopeSessionId: 'a',
        defaultMode: 'auto',
        defaultRevision: '2',
      },
      trust: {
        workspaceId: 'w',
        status: 'untrusted',
        revision: '3',
        canonicalIdentity: 'id',
        externalReadScopeDigest: 'digest',
        readScopes: [{ kind: 'workspace', description: '/Original/English/path' }],
      },
      grants: {
        items: [{ grant: { id: 'grant', kind: 'tool', definitionId: 'Models' } }],
        revision: '4',
        upperSeq: '5',
      },
    },
    skills: {
      read: 'verified',
      facts: {
        availability: 'available',
        reason: null,
        revision: 'original_revision',
        entries: [
          {
            id: 'Skills',
            name: 'Models',
            description: 'Theme Language /raw/path',
            state: 'unavailable',
            reason: 'skill_source_invalid',
            version: 'original_version',
            requiredCapabilities: [],
            missingCapabilities: [],
          },
        ],
      },
    },
  };
  const presented = Object.create(f.controller) as TuiController;
  Object.defineProperty(presented, 'state', { value: state });
  for (const [Panel, labels, raw] of [
    [
      TuiModelPanel,
      ['期望默认模型：', '启用', '已配置', 'Enter 核对默认值'],
      ['Language', 'Models', 'Theme', 'raw_configuration_code'],
    ],
    [
      TuiPermissionPanel,
      ['以后会话默认值：', '已保存 same_command 授权：', '信任不代表批准所有 Tool'],
      ['ask', 'auto', 'untrusted', '/Original/English/path', '"definitionId":"Models"'],
    ],
    [
      TuiSkillsPanel,
      ['知识 Skills · 总数 1', '名称：', '所需能力：'],
      ['Models', 'original_revision', 'unavailable'],
    ],
  ] as const) {
    const ui = render(
      <TuiPresentationProvider value={{ preferences }}>
        <Panel controller={presented} />
      </TuiPresentationProvider>,
    );
    for (const label of labels) expect(ui.lastFrame()).toContain(label);
    for (const value of raw) expect(ui.lastFrame()).toContain(value);
    ui.unmount();
  }
  f.controller.dispose();
});

test('saved language translates background and recovery instructions without translating output, machine facts or frozen caller requests', async () => {
  const f = fixture();
  await tick();
  await f.controller.select('a');
  const job: Execution = {
    id: 'job-original',
    originStoreId: 'store',
    sessionId: 'a',
    runId: null,
    kind: 'job',
    definitionId: 'Models',
    definitionVersion: '1',
    status: 'running',
    result: null,
    resultRevision: '0',
    cancelRequestedAt: 1,
    parentExecutionId: null,
    childSessionId: null,
  };
  const request = {
    kind: 'run.start' as const,
    expectedStoreId: 'store',
    commandId: 'caller-original',
    content: 'Theme Language /Original/path\n原正文🙂',
  };
  const state: TuiState = {
    ...f.controller.state,
    snapshot: {
      ...f.controller.state.snapshot!,
      view: { ...f.controller.state.snapshot!.view, executions: [job] },
    },
    jobStops: new Map([
      [
        'stop-original',
        {
          target: {
            storeId: 'store',
            originStoreId: 'store',
            sessionId: 'a',
            executionId: job.id,
            definitionId: job.definitionId,
            definitionVersion: job.definitionVersion,
          },
          request: {
            kind: 'execution.cancel',
            expectedStoreId: 'store',
            commandId: 'stop-original',
            executionId: job.id,
          },
          phase: 'applied',
        },
      ],
    ]),
    executionReading: {
      target: {
        storeId: 'store',
        originStoreId: 'store',
        sessionId: 'a',
        executionId: job.id,
        definitionId: job.definitionId,
        definitionVersion: job.definitionVersion,
      },
      phase: 'ready',
      output: {
        highWaterSeq: '3',
        items: [
          {
            executionId: job.id,
            seq: '1',
            throughSeq: '1',
            stream: 'stdout',
            content: request.content,
            droppedBytes: '0',
          },
          {
            executionId: job.id,
            seq: '2',
            throughSeq: '3',
            stream: 'stderr',
            content: '',
            droppedBytes: null,
          },
        ],
      },
    },
    callers: new Map([
      [
        'original',
        {
          intent: {
            scope: { storeId: 'store', workspaceId: 'w', sessionId: 'a' },
            request,
            subjectId: 'a',
            bodyDigest: 'a'.repeat(64),
            requestDigest: 'b'.repeat(64),
            target: { kind: 'session', id: 'a' },
          },
          phase: 'unknown',
        },
      ],
    ]),
  };
  const presented = Object.create(f.controller) as TuiController;
  Object.defineProperty(presented, 'state', { value: state });
  const before = JSON.stringify([job, state.executionReading, [...state.callers.values()]]);
  const counts = f.counts();
  const english = f.facts();
  await f.controller.savePreference({
    expectedRevision: english.revision,
    key: 'language',
    value: 'zh-CN',
  });
  const chinese = f.controller.state.preferences;
  for (const [Panel, heading, labels] of [
    [
      TuiExecutionPanel,
      'Original background Jobs',
      ['原后台任务 · 会话 a', '取消已请求；清理尚未确认', '已保存输出截至 3', '丢失字节数不可用'],
    ],
    [
      TuiRecoveryPanel,
      'Explicit recovery',
      [
        '显式恢复 · a',
        '已保存原申请 1',
        '原 Store store',
        '已应用仅表示原 Command 已应用；Run 实际结果另行确认',
      ],
    ],
  ] as const) {
    const ui = render(
      <TuiPresentationProvider value={{ preferences: english }}>
        <Panel controller={presented} />
      </TuiPresentationProvider>,
    );
    expect(ui.lastFrame()).toContain(heading);
    ui.rerender(
      <TuiPresentationProvider value={{ preferences: chinese }}>
        <Panel controller={presented} />
      </TuiPresentationProvider>,
    );
    await tick();
    for (const label of labels) expect(ui.lastFrame()).toContain(label);
    expect(ui.lastFrame()).not.toContain(heading);
    if (Panel === TuiExecutionPanel) {
      expect(ui.lastFrame()).toContain(request.content);
      expect(ui.lastFrame()).toContain('Models [job-original] running');
      expect(ui.lastFrame()).toContain('stop-original: applied');
      expect(ui.lastFrame()).toContain('stdout · 1…1');
    } else {
      ui.stdin.write('\u0016');
      await tick();
      expect(ui.lastFrame()?.replace(/\n/g, ' ')).toContain(JSON.stringify(request));
      expect(ui.lastFrame()).toContain('run.start · unknown · caller-original');
      expect(ui.lastFrame()).toContain('b'.repeat(64));
    }
    ui.unmount();
  }
  expect(JSON.stringify([job, state.executionReading, [...state.callers.values()]])).toBe(before);
  expect(f.counts()).toEqual(counts);
  expect(f.edits).toHaveLength(1);
  f.controller.dispose();
});

test('composer and answer paste labels and file candidate hints follow locale while keeping raw Unicode and diagnostics', async () => {
  const f = fixture();
  await tick();
  const preferences = {
    ...f.facts(),
    language: 'zh-CN' as const,
    resolvedLanguage: 'zh-CN' as const,
  };
  const buffer = new ComposerBuffer();
  const raw = 'Theme /Original/path\n中文🙂e\u0301';
  buffer.insert(raw, true);
  let changes = 0,
    submits = 0;
  const composer = (
    <TuiComposer
      buffer={buffer}
      value={raw}
      active
      label="新 Run"
      onChange={() => changes++}
      onSubmit={() => submits++}
    />
  );
  const ui = render(
    <TuiPresentationProvider value={{ preferences }}>{composer}</TuiPresentationProvider>,
  );
  expect(ui.lastFrame()).toContain(`[已粘贴 ${Array.from(raw).length} 个字符]`);
  ui.rerender(
    <TuiPresentationProvider value={{ preferences }}>
      <TuiAnswerInput buffer={buffer} />
    </TuiPresentationProvider>,
  );
  await tick();
  expect(ui.lastFrame()).toContain(`[已粘贴 ${Array.from(raw).length} 个字符]`);
  expect(buffer.text).toBe(raw);
  ui.unmount();
  const candidates = new ComposerBuffer();
  candidates.sync('@Theme');
  const scope = { storeId: 'store', sessionId: 'a', workspaceId: 'w' };
  let files: NonNullable<TuiState['fileCandidates']> = {
    key: candidates.fileToken!.key,
    scope,
    phase: 'reading',
    paths: [],
    unavailable: [],
  };
  const view = () => (
    <TuiPresentationProvider value={{ preferences }}>
      <TuiComposer
        buffer={candidates}
        value={candidates.text}
        active
        label="新 Run"
        files={files}
        onChange={() => changes++}
        onSubmit={() => submits++}
      />
    </TuiPresentationProvider>
  );
  const list = render(view());
  expect(list.lastFrame()).toContain('读取工作区文件名中');
  files = {
    ...files,
    phase: 'ready',
    paths: ['Theme /原文🙂.txt'],
    unavailable: [{ path: 'bad', reason: 'raw_failure' }],
  };
  list.rerender(view());
  await tick();
  expect(list.lastFrame()).toContain('1 个工作区文件候选');
  expect(list.lastFrame()).toContain('Theme /原文🙂.txt');
  expect(list.lastFrame()).toContain('文件候选不完整： 1 个路径不可用');
  files = { ...files, phase: 'failed', error: 'Theme' };
  list.rerender(view());
  await tick();
  expect(list.lastFrame()).toContain('文件候选不可用： Theme');
  expect(list.lastFrame()).not.toContain('文件候选不可用： 主题');
  expect(changes).toBe(0);
  expect(submits).toBe(0);
  expect(f.counts().effects).toBe(0);
  list.unmount();
  f.controller.dispose();
});
