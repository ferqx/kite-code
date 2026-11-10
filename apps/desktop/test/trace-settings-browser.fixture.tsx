import type { TraceInstallation } from '@kite-ai/client';
import { createRoot } from 'react-dom/client';
import type { NativeBridge, NativeSelection } from '../src/native-bridge';
import type { NativeTraceOperation } from '../src/native-trace-bridge';
import { NativeTraceSettings } from '../src/native-trace-settings';
import '../src/native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';

const calls: NativeTraceOperation[] = [];
const installation: TraceInstallation = {
  kind: 'opentelemetry',
  installationId: 'otel',
  name: 'OpenTelemetry',
  digest: 'a'.repeat(64),
  status: 'installed',
  manifest: {
    apiVersion: 1,
    name: 'OpenTelemetry',
    history: true,
    eventKinds: ['model', 'tool', 'run'],
    evidenceKinds: ['model_output', 'tool_result'],
    origins: ['https://collector.example'],
    settings: { sampleRate: 'number' },
  },
  settings: { sampleRate: 1 },
  grant: null,
  partitions: [],
  credentials: [],
};
let installed = false;
const bridge = {
  async request(input: { operation: NativeTraceOperation }) {
    const operation = input.operation;
    calls.push(structuredClone(operation));
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (operation.kind === 'list')
      return {
        kind: 'trace.installations',
        value: { installations: installed ? [installation] : [] },
      };
    if (operation.kind === 'installOpenTelemetry') {
      installed = true;
      return { kind: 'trace.installed', value: { installationId: 'otel' } };
    }
    if (operation.kind === 'inspect')
      return { kind: 'trace.installation', value: structuredClone(installation) };
    if (operation.kind === 'grant') {
      installation.grant = { revision: '1', epoch: '1', active: true, grant: operation.input };
      return { kind: 'trace.action', value: { completed: true } };
    }
    if (operation.kind === 'enable') throw Error('trace_result_unknown');
    if (operation.kind === 'bindCredential') {
      installation.credentials.push({
        handle: 'opaque-credential',
        origin: operation.input.origin,
        active: true,
      });
      return {
        kind: 'trace.credential',
        value: { handle: 'opaque-credential', origin: operation.input.origin },
      };
    }
    if (operation.kind === 'delivery')
      return {
        kind: 'trace.delivery',
        value: {
          kind: 'opentelemetry',
          status: 'available',
          inspection: {
            grant: { revision: '1', epoch: '1', active: true },
            openSpans: 2,
            acceptedEvents: 8,
            unmappedEvents: {
              notSpan: 1,
              identityUnavailable: 1,
              timingUnavailable: 2,
              incompletePrefix: 3,
            },
            outgoingTotal: 4,
            outgoingStates: [
              { status: 'accepted', count: 1 },
              { status: 'partial_unknown', count: 1 },
              { status: 'unconfirmed', count: 1 },
              { status: 'sampled_out', count: 1 },
            ],
            outgoing: [
              {
                key: 'out-1',
                taskId: 'task',
                status: 'unconfirmed',
                code: 'transport_unconfirmed',
                attempts: 2,
                rejectedCount: null,
                possibleDuplicate: 1,
              },
            ],
          },
        },
      };
    return { kind: 'trace.action', value: { completed: true } };
  },
} as unknown as NativeBridge;
Object.assign(window, { traceSettingsFixture: { calls } });
const host = document.createElement('div');
document.body.append(host);
createRoot(host).render(
  <div className="kite-client">
    <NativeTraceSettings
      bridge={bridge}
      generation={1}
      storeId="store"
      selection={{ storeId: 'store', session: { id: 'session-a' } } as NativeSelection}
    />
  </div>,
);
