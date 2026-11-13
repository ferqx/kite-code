/** Isolated read-only Windows component fixture; no Service or Provider. */
import { createRoot } from 'react-dom/client';
import type { NativeBridge, NativeRequest, NativeResult } from '../src/native-bridge';
import { NativeFilePreview } from '../src/native-file-preview';

const target = {
  storeId: 'fixture',
  sessionId: 'fixture',
  fileId: 'fixture',
  locator: { kind: 'delivery', key: 'delivery/00000000000000000001/job/file' },
} as const;
const fixture = (
  window as unknown as { fixture: { request: (request: unknown) => Promise<NativeResult> } }
).fixture;
const bridge = { request: (request: NativeRequest) => fixture.request(request) } as NativeBridge;
createRoot(document.getElementById('root')!).render(
  <NativeFilePreview
    bridge={bridge}
    generation={1}
    target={target}
    onSave={() => {
      void fixture.request({ method: 'fixture.save' });
    }}
    onRequestEdit={async (_file, context, prompt) => {
      return (await fixture.request({
        method: 'fixture.submit',
        context,
        prompt,
      })) as unknown as import('../src/output-files-bridge').OfficeRequestOutcome;
    }}
    onEdit={(_file, context) => {
      void fixture.request({ method: 'fixture.reference', context });
    }}
  />,
);
