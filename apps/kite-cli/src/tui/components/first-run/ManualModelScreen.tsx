import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useTheme } from '../../theme';
import FirstRunShell from './FirstRunShell';

interface ManualModelScreenProps {
  modelName: string;
  onModelNameChange: (name: string) => void;
  onSubmit: () => void;
  onBack: () => void;
}

export default function ManualModelScreen({
  modelName,
  onModelNameChange,
  onSubmit,
  onBack,
}: ManualModelScreenProps) {
  const t = useTheme();

  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
  });

  return (
    <FirstRunShell title="Model detection was unavailable" footer="Enter Continue   Esc Back">
      <Text color={t.dim}>The endpoint is reachable, but it did not return a model list.</Text>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={t.muted}>Model name</Text>
        </Box>
        <Box>
          <Text color={t.primary}>{'\u203A'} </Text>
          <TextInput
            value={modelName}
            onChange={onModelNameChange}
            placeholder="model-name"
            focus={true}
            onSubmit={onSubmit}
          />
        </Box>
      </Box>
    </FirstRunShell>
  );
}
