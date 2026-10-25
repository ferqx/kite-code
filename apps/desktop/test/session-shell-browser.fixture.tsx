import { createRoot } from 'react-dom/client';
import { NativeDesktop } from '../src/native';
import { sessionSwitchBridge } from './session-switch-bridge.fixture';
import '../src/native-tailwind.css';
import '@kite-ai/ui/desktop/style.css';

export const control = sessionSwitchBridge({
  protocol: 'chat-completions',
  modelNames: { b: 'Model B Extended Reasoning Route' },
  replyParagraphs: new URL(location.href).searchParams.has('long') ? 40 : 0,
});
declare global {
  interface Window {
    sessionShellFixture: typeof control;
  }
}
Object.defineProperty(window, 'kiteNative', { value: control.bridge });
window.sessionShellFixture = control;
createRoot(document.getElementById('root')!).render(<NativeDesktop />);
