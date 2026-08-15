import { Box, Text, useApp, useInput } from 'ink';
import { useI18n } from '../../i18n';
import { useTheme } from '../../theme';
import FirstRunShell from './FirstRunShell';
import type { ProviderDefinition } from './types';
import { PROVIDERS } from './types';

interface ProviderScreenProps {
  selectedIndex: number;
  onSelect: (index: number) => void;
  onConfirm: (provider: ProviderDefinition) => void;
}

export default function ProviderScreen({
  selectedIndex,
  onSelect,
  onConfirm,
}: ProviderScreenProps) {
  const t = useTheme();
  const { t: translate } = useI18n();
  const { exit } = useApp();

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      exit();
      return;
    }
    if (key.upArrow) {
      onSelect(Math.max(0, selectedIndex - 1));
      return;
    }
    if (key.downArrow) {
      onSelect(Math.min(PROVIDERS.length - 1, selectedIndex + 1));
      return;
    }
    if (key.return) {
      const provider = PROVIDERS[selectedIndex];
      if (provider) onConfirm(provider);
      return;
    }
  });

  const isWide = (process.stdout.columns ?? 80) >= 40;
  const maxLabelLen = Math.max(...PROVIDERS.map((p) => p.label.length));

  return (
    <FirstRunShell
      title={translate('firstRun.chooseProvider')}
      step={translate('firstRun.setupStep', { current: 1, total: 2 })}
      footer={translate('firstRun.navigateContinue')}
    >
      <Text color={t.dim}>{translate('firstRun.providerUsage')}</Text>
      <Box marginTop={1} flexDirection="column">
        {PROVIDERS.map((p, i) => {
          const marker = i === selectedIndex ? '\u203A' : ' ';
          const labelWithMarker = `${marker} ${p.label}`;
          const padLen = Math.max(1, maxLabelLen - p.label.length + 4);
          const padding = ' '.repeat(padLen);

          return (
            <Box key={p.type}>
              <Text color={i === selectedIndex ? t.primary : t.muted}>{labelWithMarker}</Text>
              {isWide && p.description ? (
                <Text color={t.dim}>
                  {padding}
                  {p.description}
                </Text>
              ) : null}
            </Box>
          );
        })}
        {!isWide
          ? PROVIDERS.map((p) =>
              p.description ? (
                <Box key={`desc-${p.type}`} paddingLeft={2}>
                  <Text color={t.dim}>{p.description}</Text>
                </Box>
              ) : null,
            )
          : null}
      </Box>
    </FirstRunShell>
  );
}
