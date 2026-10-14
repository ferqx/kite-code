import { Box, Text } from 'ink';
import { useInkTheme } from '../presentation';
import { wrapDisplayLines } from './soft-wrap';

export const MAX_USER_MESSAGE_LINES = 30;
const OMITTED_USER_MESSAGE_LINES_PREFIX = '【已省略 ';

/** The original Ink user bubble renders prompt text literally, including Markdown. */
export function visibleUserMessageLines(content: string, columns: number): string[] {
  const lines = wrapDisplayLines(`❯ ${content}`, Math.max(20, columns));
  if (lines.length <= MAX_USER_MESSAGE_LINES) return lines;
  const headCount = Math.ceil(MAX_USER_MESSAGE_LINES / 2);
  const tailCount = MAX_USER_MESSAGE_LINES - headCount;
  const omitted = lines.length - headCount - tailCount;
  return [
    ...lines.slice(0, headCount),
    `${OMITTED_USER_MESSAGE_LINES_PREFIX}${omitted} 行】`,
    ...lines.slice(lines.length - tailCount),
  ];
}

export default function UserMessageBlock({
  content,
  columns,
}: {
  content: string;
  columns: number;
}) {
  const theme = useInkTheme();
  return (
    <Box flexDirection="column">
      {visibleUserMessageLines(content, columns).map((line, index) => (
        <Box key={index} backgroundColor={theme.userMsgBg} width={columns}>
          <Text color={line.startsWith(OMITTED_USER_MESSAGE_LINES_PREFIX) ? theme.dim : undefined}>
            {line || ' '}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
