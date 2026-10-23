import { createRoot } from 'react-dom/client';
import { NativeDesktop } from '../src/native';
import type { NativeBridge, NativeEvent } from '../src/native-bridge';
import '../src/native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';

// Explicit test artifact: real Native renderer and Main requests, isolated loopback transport.
const events = new EventSource('/events');
const listeners = new Set<(event: NativeEvent) => void>();
events.onmessage = (event) => {
  for (const listener of listeners) listener(JSON.parse(event.data));
};
const bridge: NativeBridge = {
  fileReferences: (files) =>
    files.map((file) => ({
      name: file.name,
      uri: `file:///fixture/${encodeURIComponent(file.name)}`,
    })),
  async request(input) {
    const reply = await fetch('/rpc', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-fixture-key': document.querySelector<HTMLMetaElement>('meta[name=fixture-key]')!.content,
      },
      body: JSON.stringify(input, (_key, value) =>
        value instanceof Uint8Array ? { fixtureBytes: Array.from(value) } : value,
      ),
    }).then((response) => response.json());
    if (!reply.ok) throw Object.assign(Error(reply.code), { code: reply.code });
    return reply.value;
  },
  watch(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
Object.defineProperty(window, 'kiteNative', { value: bridge });
createRoot(document.getElementById('root')!).render(<NativeDesktop />);
