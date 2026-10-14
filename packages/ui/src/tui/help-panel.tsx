import { Box, useInput, useStdout } from 'ink';
import { useState } from 'react';
import type { TuiController } from './controller';
import TuiOverlayFrame, { OverlayShortcutBar } from './ink/OverlayFrame';
import { OverlaySection } from './ink/OverlayPrimitives';
import { TuiText as Text, useInkI18n, useTuiPresentation } from './presentation';

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
  const { t: originalLabel } = useInkI18n();
  const { t, testDiagnostics } = useTuiPresentation();
  const { stdout } = useStdout();
  const groups = [
    {
      title: originalLabel('help.shortcuts'),
      rows: [
        ['Shift+Tab', 'Review a plan before work'],
        ['Ctrl+C', 'Cancel current work; press again to exit'],
        ['Ctrl+T', 'Toggle reasoning'],
        ['Ctrl+O', 'Full output'],
        ['Ctrl+E', 'Execution details'],
        ['Ctrl+N', 'New conversation'],
        ['Ctrl+R', 'Sessions'],
        ['Ctrl+B', 'Pending requests'],
        ['Ctrl+L', 'Clear screen'],
        ['Ctrl+Q', 'Exit the terminal'],
        ['?', 'Help'],
        ['Esc', 'Back / cancel'],
      ],
    },
    {
      title: originalLabel('help.input'),
      rows: [
        ['Enter', 'Submit'],
        ['Shift+Enter', 'Newline'],
        ['↑↓', 'History'],
        ['Tab', 'Complete'],
      ],
    },
    { title: originalLabel('help.commands'), rows: commands },
  ];
  const rows = groups.flatMap((group) => [
    { title: group.title },
    ...group.rows.map(([key, description]) => ({ key, description })),
  ]);
  const [start, setStart] = useState(0);
  const page = Math.max(2, Math.min(10, (stdout.rows ?? 24) - 10));
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) controller.closePanel();
    else if (key.upArrow) setStart((value) => Math.max(0, value - 1));
    else if (key.downArrow)
      setStart((value) => Math.min(Math.max(0, rows.length - page), value + 1));
    else if (key.home) setStart(0);
    else if (key.end) setStart(Math.max(0, Math.max(0, rows.length - page)));
  });
  return (
    <TuiOverlayFrame
      title={testDiagnostics ? t('Help') : originalLabel('help.title')}
      meta={`${start + 1} / ${rows.length}`}
      footer={
        <OverlayShortcutBar
          shortcuts={[
            { keys: '↑↓', label: originalLabel('help.scroll') },
            { keys: 'Home/End', label: t('First / Last') },
            { keys: 'Esc', label: originalLabel('common.close') },
          ]}
        />
      }
    >
      {rows.slice(start, start + page).map((row, i) =>
        'title' in row ? (
          <OverlaySection key={start + i} first={i === 0}>
            {row.title}
          </OverlaySection>
        ) : (
          <Box key={start + i} paddingLeft={2}>
            <Text>{row.key.padEnd(18)}</Text>
            <Text dimColor>{t(row.description)}</Text>
          </Box>
        ),
      )}
    </TuiOverlayFrame>
  );
}
