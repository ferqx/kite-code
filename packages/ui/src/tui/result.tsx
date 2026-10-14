import { Box } from 'ink';
import { terminalText } from './controller';
import { TuiText as Text, useTuiPresentation } from './presentation';

/** Every business result field is retained; only the protocol-shaped presentation changes. */
export function TuiResult({ value }: { value: unknown }) {
  const { testDiagnostics } = useTuiPresentation();
  if (testDiagnostics) return <Text>{terminalText(JSON.stringify(value, null, 2) ?? '')}</Text>;
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return <Text>{terminalText(String(value))}</Text>;
  const entries = Object.entries(value);
  if (!entries.length) return <Text>{Array.isArray(value) ? '[]' : '{}'}</Text>;
  return (
    <Box flexDirection="column">
      {entries.map(([key, part]) => (
        <Box key={key} flexDirection="column">
          <Text dimColor>{Array.isArray(value) ? `${Number(key) + 1}.` : terminalText(key)}</Text>
          <Box paddingLeft={2}>
            <TuiResult value={part} />
          </Box>
          {part === null && <Text dimColor>null</Text>}
        </Box>
      ))}
    </Box>
  );
}
