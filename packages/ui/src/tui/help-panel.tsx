import { useInput, useStdout } from 'ink';
import { useState } from 'react';
import { TuiOverlayFrame } from './chrome';
import type { TuiController } from './controller';
import { TuiText as Text, useTuiPresentation } from './presentation';

const commands = [
  ['/model · /effort', 'Model and reasoning settings'],
  ['/new · /resume', 'Create or switch conversation'],
  ['/plan [task]', 'Review a plan before work'],
  ['/permissions', 'Permissions and workspace trust'],
  ['/mcp · /skills', 'Tools and Skills'],
  ['/background', 'Background results and child logs'],
  ['/context · /context requests', 'Context and original requests'],
  ['/rewind · /recovery', 'Files and execution recovery'],
  ['/compact [focus] · /compact reset', 'Context maintenance'],
  ['/drafts · /draft <id>', 'Saved drafts'],
  [
    '/session rename <title> · /session fork <title> · /session delete confirm',
    'Session management',
  ],
  ['/theme · /language', 'Appearance and language'],
  ['/status · /export · /clear', 'Connection, export and display'],
  ['/exit', 'Exit the terminal'],
] as const;

/** A help reader owns only its display focus; closing it never cancels work. */
export function TuiHelpPanel({ controller }: { controller: TuiController }) {
  const { t } = useTuiPresentation();
  const { stdout } = useStdout();
  const [start, setStart] = useState(0);
  const page = Math.max(2, Math.min(10, (stdout.rows ?? 24) - 10));
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) controller.closePanel();
    else if (key.upArrow) setStart((value) => Math.max(0, value - 1));
    else if (key.downArrow) setStart((value) => Math.min(commands.length - page, value + 1));
    else if (key.home) setStart(0);
    else if (key.end) setStart(Math.max(0, commands.length - page));
  });
  return (
    <TuiOverlayFrame title={t('Help')} hint={t('↑/↓ scroll · Home/End · Esc close')}>
      {commands.slice(start, start + page).map(([command, label]) => (
        <Text key={command}>
          {command}
          {' · '}
          {t(label)}
        </Text>
      ))}
      <Text dimColor>
        {t('Ctrl+N new conversation · Ctrl+R sessions · Ctrl+B pending requests')}
      </Text>
      <Text dimColor>
        {t('Ctrl+O full output · Ctrl+T reasoning · Ctrl+C cancel · Ctrl+Q exit')}
      </Text>
    </TuiOverlayFrame>
  );
}
