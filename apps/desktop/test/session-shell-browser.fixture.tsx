import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from '@kite-ai/ui/desktop';
import { createRoot } from 'react-dom/client';
import { NativeDesktop } from '../src/native';
import { mcpSettingsBridgeFixture } from './mcp-settings-bridge.fixture';
import { sessionSwitchBridge } from './session-switch-bridge.fixture';
import '../src/native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';

export const control = sessionSwitchBridge({
  unselectedModel: new URL(location.href).searchParams.has('unselected-model'),
  withoutPermissions: new URL(location.href).searchParams.has('without-permissions'),
  modelEfforts: new URL(location.href).searchParams.has('distinct-efforts')
    ? { a: 'high', b: 'low' }
    : undefined,
  holdDraft: new URL(location.href).searchParams.has('model-navigation'),
  protocol: 'chat-completions',
  modelNames: { b: 'Model B Extended Reasoning Route' },
  replyParagraphs: new URL(location.href).searchParams.has('long')
    ? 40
    : new URL(location.href).searchParams.has('model-navigation')
      ? 20
      : 0,
  initialSelection: !new URL(location.href).searchParams.has('long'),
  worktreeNavigation: new URL(location.href).searchParams.has('worktree-navigation'),
  manageSessions: new URL(location.href).searchParams.has('manage-sessions'),
  turnNotifications:
    new URL(location.href).searchParams.has('turn-notifications') ||
    new URL(location.href).searchParams.has('worktree-indicator'),
  cacheMetrics: !['none', 'context'].includes(
    new URL(location.href).searchParams.get('metrics') ?? '',
  ),
  contextUsage: ['both', 'context'].includes(
    new URL(location.href).searchParams.get('metrics') ?? '',
  ),
});
declare global {
  interface Window {
    sessionShellFixture: typeof control;
    remountSessionShellFixture: () => void;
  }
}
Object.defineProperty(window, 'kiteNative', { value: control.bridge });
window.sessionShellFixture = control;
const settingsGeometry = new URL(location.href).searchParams.has('settings-geometry');
if (settingsGeometry) {
  const mcpRequest = mcpSettingsBridgeFixture(
    new URL(location.href).searchParams.has('mcp-errors') ? 'errors' : 'normal',
  );
  document.documentElement.dataset.platform = 'windows';
  document.documentElement.dataset.nativeWindow = 'true';
  document.documentElement.dataset.windowMaterial = 'mica';
  const request = control.bridge.request.bind(control.bridge);
  control.bridge.request = async (input) => {
    if (input.method === 'scheduled.list') return { kind: 'scheduled.tasks', tasks: [], runs: [] };
    if (input.method === 'settings.models.read')
      return {
        kind: 'settings.models',
        storeId: 'store',
        scope: 'user',
        observationId: 1,
        canWrite: true,
        errors: [],
        defaultModelId: null,
        models: [
          {
            id: 'demo-a',
            provider: 'compatible',
            model: 'Demo A',
            enabled: false,
            configured: true,
            diagnostics: [],
          },
          {
            id: 'demo-b',
            provider: 'compatible',
            model: 'Demo B',
            enabled: true,
            configured: true,
            diagnostics: [],
          },
        ],
      };
    if (input.method.startsWith('settings.userMcp.'))
      return (
        (await mcpRequest(input as import('../src/mcp-bridge').NativeUserMcpRequest)) ??
        request(input)
      );
    if (input.method === 'settings.skills.open')
      return {
        kind: 'settings.skills.page',
        readId: input.readId,
        scope: { generation: input.generation, storeId: 'store' },
        page: {
          version: 1,
          storeId: 'store',
          scope: 'user',
          revision: 'b'.repeat(64),
          availability: 'available',
          reason: null,
          entries: [
            {
              id: 'sample-skill',
              name: '示例 Skill',
              description: '布局验证',
              source: { scope: 'user', origin: '.agents' },
              version: 'a'.repeat(64),
              enabled: true,
              state: 'available',
              reason: null,
              requiredCapabilities: [],
              missingCapabilities: [],
            },
          ],
          nextAfterId: null,
          complete: true,
        },
      };
    if (input.method === 'settings.providers.read')
      return {
        kind: 'settings.providers',
        storeId: 'store',
        observationId: 1,
        canWrite: true,
        errors: [],
        providers: [
          {
            id: 'openai',
            label: 'OpenAI',
            requiresCredential: true,
            defaultBaseURL: 'https://api.openai.com/v1',
            connections: [],
          },
          {
            id: 'compatible',
            label: '自定义服务商',
            requiresCredential: false,
            defaultBaseURL: '',
            connections: [
              {
                id: 'demo',
                name: 'Demo Service',
                baseURL: 'https://example.com/v1',
                protocol: 'chat-completions',
                hasCredential: false,
                modelNames: ['Demo A', 'Demo B'],
                modelIds: ['demo-a', 'demo-b'],
                defaultModelIds: [],
                canWrite: true,
              },
              {
                id: 'long-name',
                name: '长名称提供商 / A service with a longer connection name',
                baseURL: 'https://example.com/v1',
                protocol: 'responses',
                hasCredential: false,
                modelNames: [],
                modelIds: [],
                defaultModelIds: [],
                canWrite: false,
              },
            ],
          },
          {
            id: 'codex',
            label: 'ChatGPT / Codex',
            requiresCredential: false,
            defaultBaseURL: '',
            connections: [
              {
                id: 'local',
                name: 'ChatGPT / Codex（本机）',
                baseURL: '',
                protocol: 'responses',
                hasCredential: false,
                modelNames: [],
                modelIds: [],
                defaultModelIds: [],
                canWrite: false,
              },
            ],
          },
        ],
      };
    return request(input);
  };
}
const formControls = new URL(location.href).searchParams.has('form-controls');
if (formControls)
  document.documentElement.dataset.theme =
    new URL(location.href).searchParams.get('theme') ?? 'light';
let root = createRoot(document.getElementById('root')!);
window.remountSessionShellFixture = () => {
  root.unmount();
  root = createRoot(document.getElementById('root')!);
  root.render(<NativeDesktop nativeWindow={settingsGeometry} />);
};
root.render(
  formControls ? (
    <section className="kite-client" aria-label="公共表单组件" style={{ padding: 24 }}>
      {['normal', 'invalid', 'disabled'].map((state) => (
        <fieldset
          key={state}
          data-control-state={state}
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: 12,
            marginBottom: 24,
          }}
        >
          <legend>{state}</legend>
          <Input
            aria-label={`${state}-input`}
            defaultValue="输入内容"
            aria-invalid={state === 'invalid'}
            disabled={state === 'disabled'}
          />
          <Select defaultValue="a" disabled={state === 'disabled'}>
            <SelectTrigger aria-label={`${state}-select`} aria-invalid={state === 'invalid'}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="a">选项 A</SelectItem>
              <SelectItem value="b">选项 B</SelectItem>
            </SelectContent>
          </Select>
          <Textarea
            aria-label={`${state}-textarea`}
            defaultValue="多行内容"
            aria-invalid={state === 'invalid'}
            disabled={state === 'disabled'}
          />
        </fieldset>
      ))}
      <fieldset aria-label="公共开关组件" style={{ display: 'flex', gap: 24, padding: 16 }}>
        <legend>Switch</legend>
        <Switch aria-label="switch-off" />
        <Switch aria-label="switch-on" defaultChecked />
        <Switch aria-label="switch-disabled" defaultChecked disabled />
      </fieldset>
    </section>
  ) : (
    <>
      <NativeDesktop nativeWindow={settingsGeometry} />
      {new URL(location.href).searchParams.has('turn-notifications') && (
        <section
          aria-label="完成提醒测试夹具"
          style={{ position: 'fixed', right: 8, top: 8, zIndex: 9999 }}
        >
          <button type="button" onClick={() => control.setTurn('b', 'completed')}>
            结束 B
          </button>
          <button type="button" onClick={() => control.setTurn('b', 'running', 'next-b')}>
            运行 B
          </button>
          <button type="button" onClick={() => control.setTurn('b', 'failed', 'next-b')}>
            B 新一轮失败
          </button>
          <button type="button" onClick={() => control.setTurn('a', 'completed')}>
            结束 A
          </button>
          <button type="button" onClick={() => control.setTurn('a', 'running', 'next-a')}>
            运行 A
          </button>
          <button type="button" onClick={() => control.setTurn('a', 'failed', 'next-a')}>
            A 新一轮失败
          </button>
          <button type="button" onClick={() => control.hold()}>
            暂停读取
          </button>
          <button type="button" onClick={() => control.release('selection')}>
            释放选择
          </button>
          <button type="button" onClick={() => control.release('models')}>
            释放模型
          </button>
          <button type="button" onClick={() => control.release('history')}>
            释放历史
          </button>
          <button type="button" onClick={() => control.release('receipt')}>
            释放已读保存
          </button>
          <button type="button" onClick={() => control.resume()}>
            恢复读取
          </button>
          <button type="button" onClick={() => control.fail(true)}>
            读取失败
          </button>
          <button type="button" onClick={() => control.fail(false)}>
            读取恢复
          </button>
          <button type="button" onClick={() => control.failReceipt(true)}>
            已读保存失败
          </button>
          <button type="button" onClick={() => control.failReceipt(false)}>
            已读保存恢复
          </button>
        </section>
      )}
    </>
  ),
);
