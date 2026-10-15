import { Box } from 'ink';
import { terminalText } from './controller';
import { TuiText as Text, useTuiPresentation } from './presentation';

// Keep the result's own receipt visible before potentially large catalogues.
// This only orders existing fields; it never supplies missing receipt facts.
const diagnosticReceiptFields = ['executionId', 'toolsMetadata'];
function diagnosticOrder(_key: string, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const entries = Object.entries(value);
  return Object.fromEntries([
    ...diagnosticReceiptFields.flatMap((key) => entries.filter(([name]) => name === key)),
    ...entries.filter(([key]) => !diagnosticReceiptFields.includes(key)),
  ]);
}

/** Every business result field is retained; only the protocol-shaped presentation changes. */
export function TuiResult({ value }: { value: unknown }) {
  const { testDiagnostics } = useTuiPresentation();
  if (testDiagnostics)
    return <Text>{terminalText(JSON.stringify(value, diagnosticOrder, 2) ?? '')}</Text>;
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
