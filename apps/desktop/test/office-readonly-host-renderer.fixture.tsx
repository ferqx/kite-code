import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { NativeBridge } from '../src/native-bridge';

import '../../../packages/ui/src/desktop/style.css';
import '../src/native-content-theme.css';

const { NativeFilePreview } = await import('../src/native-file-preview');
const api = (window as unknown as { readonlyFixture: NativeBridge }).readonlyFixture;
function Fixture() {
  const [id, setId] = useState('A');
  return (
    <div className="kite-client">
      <button type="button" id="replace" onClick={() => setId('B')}>
        Fixture replace
      </button>
      <div
        className="client-content-frame client-main-panel"
        style={{ height: 'calc(100vh - 32px)' }}
      >
        <NativeFilePreview
          bridge={api}
          generation={1}
          target={{
            storeId: 'store',
            sessionId: 'session',
            fileId: id,
            locator: { kind: 'delivery', key: `delivery/${id}` },
          }}
          onEdit={() => {
            throw Error('unexpected edit');
          }}
          onSave={() => {
            throw Error('unexpected save');
          }}
        />
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
