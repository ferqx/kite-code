import { expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import type { TuiController } from '../../src/tui/controller';
import OverlayChoiceList from '../../src/tui/ink/OverlayChoiceList';
import OverlayFrame, {
  OverlayShortcutBar,
  OverlayStatusColumn,
} from '../../src/tui/ink/OverlayFrame';
import { OverlayListRow } from '../../src/tui/ink/OverlayPrimitives';
import { toolMetadataText } from '../../src/tui/mcp-tools-panel';
import { TuiModelPanel } from '../../src/tui/model-panel';
import { TuiPermissionPanel } from '../../src/tui/permission-panel';
import { TuiPreferencePanel } from '../../src/tui/preference-panel';
import { TuiPresentationProvider } from '../../src/tui/presentation';

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
const preferences = {
  revision: 'a'.repeat(64),
  language: 'en-US',
  resolvedLanguage: 'en-US',
  colorPreset: 'teal',
  theme: 'dark',
} as const;

test('original overlay rows retain descriptions, selected indicator, current column and separate footer', () => {
  const ui = render(
    <OverlayFrame
      title="Original overlay"
      meta="2 / 3"
      footer={
        <OverlayShortcutBar
          shortcuts={[
            { keys: 'Enter', label: 'Confirm' },
            { keys: 'Esc', label: 'Back' },
          ]}
        />
      }
    >
      <OverlayListRow
        selected
        primary="Original item"
        secondary="Complete original description"
        trailing={<OverlayStatusColumn active label="Current" />}
      />
      <OverlayChoiceList
        selectedId="keep"
        selectionBackground={false}
        options={[
          { id: 'keep', label: 'Keep', description: 'Do not change data' },
          { id: 'delete', label: 'Delete', description: 'Delete selected data', destructive: true },
        ]}
      />
    </OverlayFrame>,
  );
  try {
    const frame = ui.lastFrame()!;
    for (const text of [
      'Original overlay',
      '2 / 3',
      '❯ Original item',
      'Complete original description',
      'Current',
      '❯ Keep',
      'Do not change data',
      'Delete selected data',
      'Enter Confirm',
      'Esc Back',
    ])
      expect(frame).toContain(text);
  } finally {
    ui.unmount();
  }
});

test('ordinary model selector groups providers and marks current model without protocol diagnostics', async () => {
  const controller = {
    state: {
      panel: 'models',
      models: {
        defaultModelId: 'private-route-id',
        models: [
          {
            id: 'private-route-id',
            provider: 'Actual provider',
            model: 'Actual model',
            enabled: true,
            configured: true,
            diagnostics: ['private-wire-detail'],
            reasoningEffortSupport: 'compatible_wire',
            reasoningEffortChoices: [],
          },
        ],
        errors: [],
      },
      stale: false,
    },
    closePanel: () => {},
    openModels: async () => {},
    lookupModel: async () => {},
  } as unknown as TuiController;
  const ui = render(
    <TuiPresentationProvider value={{ preferences, testDiagnostics: false }}>
      <TuiModelPanel controller={controller} />
    </TuiPresentationProvider>,
  );
  try {
    await tick();
    const frame = ui.lastFrame()!;
    for (const text of ['Actual provider', '❯ Actual model', 'Current'])
      expect(frame).toContain(text);
    for (const text of [
      'private-route-id',
      'private-wire-detail',
      'compatible_wire',
      'Adapter wire',
      'configured',
    ])
      expect(frame).not.toContain(text);
  } finally {
    ui.unmount();
  }
});

test('ordinary preferences and three permission choices retain useful descriptions and hide backend values', async () => {
  const state = {
    panel: 'theme',
    preferences,
    preferenceStatus: 'confirmed',
    preferenceSaved: false,
    permissions: {
      mode: {
        mode: 'accept_edits',
        defaultMode: 'accept_edits',
        revision: '1',
        defaultRevision: '1',
        scopeSessionId: 'private-session',
      },
      trust: {
        workspaceId: 'private-workspace',
        status: 'untrusted',
        canonicalIdentity: '/actual/workspace',
        readScopes: [],
      },
      grants: {
        items: [{ grant: { id: 'private-grant', definitionId: 'private-definition' } }],
        revision: '2',
        upperSeq: '4',
      },
    },
  };
  const controller = {
    state,
    closePanel: () => {},
    refreshPreferences: async () => {},
    savePreference: async () => {},
    openPermissions: async () => {},
    lookupPermission: async () => {},
  } as unknown as TuiController;
  const ui = render(
    <TuiPresentationProvider value={{ preferences, testDiagnostics: false }}>
      <TuiPreferencePanel controller={controller} />
    </TuiPresentationProvider>,
  );
  try {
    await tick();
    for (const text of ['❯ Teal', 'Default dark theme', 'Blue accent theme', 'Current'])
      expect(ui.lastFrame()).toContain(text);
    for (const text of ['Effective language:', 'Base theme:', '[teal]'])
      expect(ui.lastFrame()).not.toContain(text);
    ui.rerender(
      <TuiPresentationProvider value={{ preferences, testDiagnostics: false }}>
        <TuiPermissionPanel controller={controller} />
      </TuiPresentationProvider>,
    );
    await tick();
    for (const text of [
      '请求批准',
      '自动审核',
      '完全访问',
      'Workspace writes are allowed.',
      'model reviews commands',
      'extremely dangerous',
      'Current',
      '/actual/workspace',
    ])
      expect(ui.lastFrame()).toContain(text);
    for (const text of [
      'private-grant',
      'private-definition',
      'private-session',
      'private-workspace',
      '"definitionId"',
      'revision',
    ])
      expect(ui.lastFrame()).not.toContain(text);
  } finally {
    ui.unmount();
  }
});

test('ordinary tool detail preserves nested complete metadata including false and null without raw protocol JSON', () => {
  const text = toolMetadataText({
    name: 'Exact tool',
    description: 'Exact external description',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'Exact path description' } },
      required: ['file'],
      additionalProperties: false,
    },
    outputSchema: { anyOf: [{ type: 'null' }, { type: 'boolean' }] },
    extension: null,
  });
  for (const value of [
    'name: Exact tool',
    'description: Exact external description',
    'file:',
    'Exact path description',
    'required:',
    '1: file',
    'additionalProperties: false',
    'anyOf:',
    'type: null',
    'type: boolean',
    'extension: null',
  ])
    expect(text).toContain(value);
  expect(text).not.toContain('"inputSchema"');
});

test('original Session selector shows current/date columns and keeps loading row until the selected reader completes', async () => {
  const { TuiSessionChooser } = await import('../../src/tui/session-chooser');
  let resolve!: () => void;
  let selections = 0,
    closes = 0;
  const state = {
    sessionId: 'private-a',
    sessions: [
      { id: 'private-a', title: 'Current conversation', updatedAt: Date.UTC(2026, 9, 14, 0, 0) },
      { id: 'private-b', title: 'Other conversation', updatedAt: Date.UTC(2026, 9, 13, 0, 0) },
    ],
    snapshot: undefined as unknown,
    stale: false,
  };
  const controller = {
    state,
    subscribe: () => () => {},
    closeSessionDeletion: () => {},
    select: async (id: string) => {
      selections++;
      await new Promise<void>((done) => {
        resolve = done;
      });
      state.sessionId = id;
      state.snapshot = {};
    },
  } as unknown as TuiController;
  const ui = render(
    <TuiPresentationProvider value={{ preferences, testDiagnostics: false }}>
      <TuiSessionChooser
        controller={controller}
        close={() => {
          closes++;
        }}
      />
    </TuiPresentationProvider>,
  );
  try {
    await tick();
    expect(ui.lastFrame()).toContain('Sessions');
    expect(ui.lastFrame()).toContain('Current conversation');
    expect(ui.lastFrame()).toContain('Current');
    expect(ui.lastFrame()).toContain('2026');
    expect(ui.lastFrame()).not.toContain('private-a');
    ui.stdin.write('\u001b[B');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('◌');
    expect(selections).toBe(1);
    expect(closes).toBe(0);
    ui.stdin.write('\r');
    await tick();
    expect(selections).toBe(1);
    resolve();
    await tick();
    expect(closes).toBe(1);
  } finally {
    ui.unmount();
  }
});

test('ordinary MCP menu and detail use verified read-only labels while retaining exact server IDs as targets', async () => {
  const { TuiMcpPanel } = await import('../../src/tui/mcp-panel');
  const id = `mcp-${'a'.repeat(64)}`;
  let effects = 0;
  const controller = {
    state: {
      mcp: {
        read: 'ready',
        facts: {
          workspaceId: 'private-workspace',
          labels: { [id]: 'ActualMcpName' },
          readSet: { workspaceEtag: null },
          items: [
            {
              id,
              source: { kind: 'user', id: 'private-source-digest' },
              transport: 'http',
              admitted: true,
              selected: true,
              available: true,
              reason: null,
            },
          ],
        },
      },
    },
    port: { mcp: {} },
    chooseMcp: async () => {
      effects++;
    },
  } as unknown as TuiController;
  const ui = render(
    <TuiPresentationProvider value={{ preferences, testDiagnostics: false }}>
      <TuiMcpPanel controller={controller} />
    </TuiPresentationProvider>,
  );
  try {
    await tick();
    expect(ui.lastFrame()).toContain('❯ ActualMcpName');
    expect(ui.lastFrame()).not.toContain(id);
    expect(ui.lastFrame()).not.toContain('private-workspace');
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('MCP · ActualMcpName');
    expect(ui.lastFrame()).not.toContain('private-source-digest');
    expect(effects).toBe(0);
  } finally {
    ui.unmount();
  }
});
