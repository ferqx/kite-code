import { Box, Text, useInput } from 'ink';
import { ScrollList } from 'ink-scroll-list';
import { useState } from 'react';
import type { CheckpointEntry } from '@/core/persistence/checkpoint';
import { useOverlayHeight } from '../hooks/useOverlayHeight';
import { useTheme } from '../theme';

export type { CheckpointEntry };

interface CheckpointSelectorProps {
  checkpoints: CheckpointEntry[];
  onRevert: (checkpointId: string) => void;
  onFork: (checkpointId: string) => void;
  onClose: () => void;
}

export default function CheckpointSelector({
  checkpoints,
  onRevert,
  onFork,
  onClose,
}: CheckpointSelectorProps) {
  const t = useTheme();
  const [selected, setSelected] = useState(0);
  const maxContentHeight = useOverlayHeight(8);

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelected((s) => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((s) => Math.min(checkpoints.length - 1, s + 1));
      return;
    }
    if (key.return) {
      const cp = checkpoints[selected];
      if (cp) onRevert(cp.checkpointId);
      return;
    }
    const char = _input.toLowerCase();
    if (char === 'r') {
      const cp = checkpoints[selected];
      if (cp) onRevert(cp.checkpointId);
      return;
    }
    if (char === 'f') {
      const cp = checkpoints[selected];
      if (cp) onFork(cp.checkpointId);
      return;
    }
  });

  if (checkpoints.length === 0) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={t.primary}
        paddingX={1}
        marginY={1}
      >
        <Text bold color={t.primary}>
          Rewind
        </Text>
        <Box marginTop={1}>
          <Text color={t.muted}>No checkpoints found for the current session.</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={t.dim}>按任意键关闭</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.primary}
      paddingX={1}
      marginY={1}
    >
      <Text bold color={t.primary}>
        回退 — 选择检查点
      </Text>

      <Box marginTop={1} flexGrow={1} maxHeight={maxContentHeight}>
        <ScrollList selectedIndex={selected} scrollAlignment="auto">
          {checkpoints.map((cp, i) => {
            const isSelected = i === selected;
            const prefix = isSelected ? '\u276f' : ' ';
            const color = isSelected ? t.primary : t.muted;
            const displayId = cp.checkpointId.slice(0, 8);
            const rawMsg = cp.firstUserMessage || '';
            const displayMsg =
              rawMsg.length > 60 ? `${rawMsg.slice(0, 60)}...` : rawMsg || '(no message)';
            const displayTime = cp.createdAt ? cp.createdAt.slice(0, 19) : '';

            return (
              <Text key={cp.checkpointId} color={color}>
                {prefix} {i + 1}. [{displayId}] {displayMsg}
                {displayTime ? ` \u2014 ${displayTime}` : ''}
              </Text>
            );
          })}
        </ScrollList>
      </Box>

      <Box marginTop={1}>
        <Text color={t.dim}>
          Enter/R \u56de\u9000 F \u5206\u53c9 Esc \u53d6\u6d88 \u2191\u2193 \u5bfc\u822a
        </Text>
      </Box>
    </Box>
  );
}
