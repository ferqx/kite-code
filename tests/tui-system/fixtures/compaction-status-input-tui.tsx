import { TuiSession } from '@kite-ai/ui/tui';
import { render } from 'ink';
import {
  createPresentationController,
  DISPLAY_SESSION,
  displayMessage,
  displayRun,
  displaySnapshot,
} from './new-ui-presentation-port';

const startedAt = Date.now();
let submitted = 0;
const messages = [displayMessage('manual-command', 1, '/compact', { role: 'user' })];
const read = () => ({
  ...displaySnapshot(messages, [], submitted > 0 ? [displayRun(true, startedAt)] : []),
  compactionPhase: 'summarizing' as const,
});
const controller = createPresentationController(read, async () => {
  submitted++;
  messages.push(
    displayMessage(
      `input-${submitted}`,
      messages.length + 1,
      submitted === 1 ? '/auto-compact' : 'Automatic input submitted',
      { role: submitted === 1 ? 'user' : 'system' },
    ),
  );
  await controller.select(DISPLAY_SESSION);
});
await controller.select(DISPLAY_SESSION);
const app = render(<TuiSession controller={controller} onQuit={() => app.unmount()} />, {
  interactive: true,
  exitOnCtrlC: true,
});
await app.waitUntilExit();
controller.dispose();
