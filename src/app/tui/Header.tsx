import { homedir } from 'node:os';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { useTheme } from './theme';

const LABEL_WIDTH = 11;
const MIN_HEADER_WIDTH = 20;
const MAX_HEADER_WIDTH = 60;
const EFFORT_MIN_WIDTH = 40;
const HEADER_PADDING_X = 1;

function takeStartByWidth(text: string, maxWidth: number): string {
  let result = '';
  let width = 0;
  for (const char of text) {
    const charWidth = stringWidth(char);
    if (width + charWidth > maxWidth) break;
    result += char;
    width += charWidth;
  }
  return result;
}

function takeEndByWidth(text: string, maxWidth: number): string {
  let result = '';
  let width = 0;
  for (const char of Array.from(text).reverse()) {
    const charWidth = stringWidth(char);
    if (width + charWidth > maxWidth) break;
    result = `${char}${result}`;
    width += charWidth;
  }
  return result;
}

export function truncateMiddleByDisplayWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (stringWidth(text) <= maxWidth) return text;
  if (maxWidth === 1) return '…';

  const available = maxWidth - stringWidth('…');
  const startWidth = Math.ceil(available * 0.4);
  const endWidth = available - startWidth;
  return `${takeStartByWidth(text, startWidth)}…${takeEndByWidth(text, endWidth)}`;
}

export function formatHeaderWorkspace(workspace: string, homeDirectory = homedir()): string {
  const normalizedWorkspace = workspace.replaceAll('\\', '/').replace(/\/+$/, '');
  const normalizedHome = homeDirectory.replaceAll('\\', '/').replace(/\/+$/, '');
  const compareWorkspace =
    process.platform === 'win32' ? normalizedWorkspace.toLowerCase() : normalizedWorkspace;
  const compareHome = process.platform === 'win32' ? normalizedHome.toLowerCase() : normalizedHome;

  if (compareWorkspace === compareHome) return '~';
  if (compareWorkspace.startsWith(`${compareHome}/`)) {
    return `~${normalizedWorkspace.slice(normalizedHome.length)}`;
  }
  return normalizedWorkspace || workspace;
}

export interface HeaderProps {
  modelName: string;
  thinkingMode?: string | null;
  reasoningEnabled?: boolean;
  workspace: string;
  columns?: number;
}

export default function Header({
  modelName,
  thinkingMode,
  reasoningEnabled,
  workspace,
  columns,
}: HeaderProps) {
  const t = useTheme();
  const terminalWidth = columns ?? process.stdout.columns ?? 80;
  const width = Math.max(MIN_HEADER_WIDTH, Math.min(MAX_HEADER_WIDTH, terminalWidth));
  const innerWidth = Math.max(1, width - 2 - HEADER_PADDING_X * 2);
  const showEffort = width >= EFFORT_MIN_WIDTH && reasoningEnabled !== false && !!thinkingMode;
  const valueWidth = Math.max(1, innerWidth - LABEL_WIDTH);
  const modelSummary = showEffort ? `${modelName} ${thinkingMode}` : modelName;
  const workspaceSummary = formatHeaderWorkspace(workspace);

  return (
    <Box
      flexDirection="column"
      width={width}
      paddingX={HEADER_PADDING_X}
      borderStyle="round"
      borderColor={t.dim}
    >
      <Box>
        <Text color={t.dim}>──</Text>
        <Text color={t.primary}>◆</Text>
        <Text bold color={t.primary}>
          {' Kite Code'}
        </Text>
      </Box>
      <Box height={1} />
      <Box>
        <Box width={LABEL_WIDTH} flexShrink={0}>
          <Text color={t.dim}>model</Text>
        </Box>
        <Text>{truncateMiddleByDisplayWidth(modelSummary, valueWidth)}</Text>
      </Box>
      <Box>
        <Box width={LABEL_WIDTH} flexShrink={0}>
          <Text color={t.dim}>workspace</Text>
        </Box>
        <Text color={t.muted}>
          {truncateMiddleByDisplayWidth(workspaceSummary, Math.max(1, innerWidth - LABEL_WIDTH))}
        </Text>
      </Box>
    </Box>
  );
}
