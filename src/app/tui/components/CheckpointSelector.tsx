import { Box, Text, useInput, useStdout } from 'ink';
import { ScrollList } from 'ink-scroll-list';
import { type MutableRefObject, useEffect, useMemo, useRef, useState } from 'react';
import stringWidth from 'string-width';
import { formatLocalDateTime } from '@/core/persistence/sessions';
import type { FileRestorePreview } from '@/core/runtime/file-checkpoints';
import type { RuntimeSnapshotEntry } from '@/core/runtime/store';
import { useOverlayHeight } from '../hooks/useOverlayHeight';
import { useTheme } from '../theme';
import type { RewindScope } from '../types';
import OverlayChoiceList, { type OverlayChoiceOption } from './OverlayChoiceList';
import OverlayFrame, { OverlayShortcutBar } from './OverlayFrame';

export type { RuntimeSnapshotEntry };

type RewindStage = 'browse' | 'confirm';
type ConfirmChoice = RewindScope;

interface CheckpointSelectorProps {
  checkpoints: RuntimeSnapshotEntry[];
  onConfirm: (checkpointId: string, scope: RewindScope) => void;
  onClose: () => void;
  getRewindPreview?: (checkpointId: string) => FileRestorePreview | null;
  layeredEscRef?: MutableRefObject<boolean>;
}

function normalizeMessage(content: string | undefined): string {
  return content?.replace(/\s+/g, ' ').trim() || '未完成的后续操作';
}

function truncateByDisplayWidth(text: string, maxCols: number): string {
  if (maxCols <= 0) return '';
  if (stringWidth(text) <= maxCols) return text;
  const ellipsisWidth = stringWidth('…');
  let result = '';
  let used = 0;
  for (const char of text) {
    const width = stringWidth(char);
    if (used + width + ellipsisWidth > maxCols) break;
    result += char;
    used += width;
  }
  return result ? `${result}…` : '…';
}

function fileImpactLabel(count: number): string {
  return count > 0 ? `${count} 个已记录文件` : '无已记录文件变更';
}

function previewFileLabel(preview: FileRestorePreview): string {
  const primaryPath = preview.files[0]?.path;
  if (!primaryPath) return '';
  const remainingFiles = preview.files.length - 1;
  return remainingFiles > 0 ? `${primaryPath} 和另外 ${remainingFiles} 个文件` : primaryPath;
}

const confirmOptions: readonly OverlayChoiceOption<ConfirmChoice>[] = [
  {
    id: 'code_and_conversation',
    label: '恢复代码和会话',
    description: '创建新会话并恢复工作区文件；当前会话保留',
  },
  {
    id: 'conversation_only',
    label: '仅恢复会话',
    description: '创建新会话，保留当前工作区代码',
  },
  {
    id: 'code_only',
    label: '仅恢复代码',
    description: '保留当前会话，只恢复工作区文件',
  },
];

export default function CheckpointSelector({
  checkpoints,
  onConfirm,
  onClose,
  getRewindPreview,
  layeredEscRef,
}: CheckpointSelectorProps) {
  const t = useTheme();
  const { stdout } = useStdout();
  const [stage, setStage] = useState<RewindStage>('browse');
  const [selected, setSelected] = useState(0);
  const [confirmChoice, setConfirmChoice] = useState<ConfirmChoice>('code_and_conversation');
  const [filePreview, setFilePreview] = useState<FileRestorePreview | null>(null);
  const submittingRef = useRef(false);
  const maxContentHeight = useOverlayHeight(9);
  const columns = stdout?.columns ?? 80;
  const messageWidth = Math.max(20, columns - 8);
  const actionableCheckpoints = useMemo(
    () =>
      checkpoints.filter(
        (checkpoint) => checkpoint.targetMessage || (checkpoint.affectedFileCount ?? 0) > 0,
      ),
    [checkpoints],
  );
  const selectedCheckpoint = actionableCheckpoints[selected];
  const confirmIndex = confirmOptions.findIndex((option) => option.id === confirmChoice);

  if (layeredEscRef) layeredEscRef.current = stage === 'confirm';

  useEffect(
    () => () => {
      if (layeredEscRef) layeredEscRef.current = false;
    },
    [layeredEscRef],
  );

  useEffect(() => {
    setSelected((current) => Math.min(current, Math.max(0, actionableCheckpoints.length - 1)));
  }, [actionableCheckpoints.length]);

  const selectConfirmChoice = (choice: ConfirmChoice) => {
    setConfirmChoice(choice);
    if (
      selectedCheckpoint &&
      getRewindPreview &&
      (choice === 'code_and_conversation' || choice === 'code_only')
    ) {
      setFilePreview(getRewindPreview(selectedCheckpoint.snapshotId));
      return;
    }
    setFilePreview(null);
  };

  useInput((_input, key) => {
    if (stage === 'confirm') {
      if (key.escape) {
        setStage('browse');
        setFilePreview(null);
        return;
      }
      if (key.upArrow) {
        selectConfirmChoice(
          confirmOptions[Math.max(0, confirmIndex - 1)]?.id ?? 'code_and_conversation',
        );
        return;
      }
      if (key.downArrow) {
        selectConfirmChoice(
          confirmOptions[Math.min(confirmOptions.length - 1, confirmIndex + 1)]?.id ??
            'code_and_conversation',
        );
        return;
      }
      if (key.return) {
        if (selectedCheckpoint && !submittingRef.current) {
          submittingRef.current = true;
          onConfirm(selectedCheckpoint.snapshotId, confirmChoice);
        }
      }
      return;
    }

    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelected((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((current) => Math.min(actionableCheckpoints.length - 1, current + 1));
      return;
    }
    if (key.return && selectedCheckpoint) {
      selectConfirmChoice('code_and_conversation');
      setStage('confirm');
    }
  });

  if (actionableCheckpoints.length === 0) {
    return (
      <OverlayFrame
        title="回退"
        footer={<OverlayShortcutBar shortcuts={[{ keys: 'Esc', label: '关闭' }]} />}
      >
        <Box marginTop={1}>
          <Text color={t.muted}>当前会话暂无可回退的检查点。</Text>
        </Box>
      </OverlayFrame>
    );
  }

  if (stage === 'confirm' && selectedCheckpoint) {
    const affectsCode = confirmChoice === 'code_and_conversation' || confirmChoice === 'code_only';
    const hasCodePreview =
      filePreview != null &&
      (filePreview.files.length > 0 ||
        filePreview.conflictCount > 0 ||
        filePreview.failureCount > 0);
    const showPreview = hasCodePreview;
    const message = truncateByDisplayWidth(
      normalizeMessage(selectedCheckpoint.targetMessage),
      messageWidth * 2,
    );
    const messageTime = formatLocalDateTime(
      selectedCheckpoint.targetMessageCreatedAt ?? selectedCheckpoint.createdAt,
    );

    return (
      <OverlayFrame
        title="回退 · 恢复到此消息之前"
        footer={
          <OverlayShortcutBar
            shortcuts={[
              { keys: '↑↓', label: '导航' },
              { keys: 'Enter', label: '确认' },
              { keys: 'Esc', label: '返回' },
            ]}
          />
        }
      >
        <Box flexDirection="column" marginTop={1}>
          <Box
            marginLeft={1}
            paddingLeft={1}
            width={Math.max(20, columns - 6)}
            borderStyle="single"
            borderTop={false}
            borderRight={false}
            borderBottom={false}
            borderColor={t.dim}
            flexDirection="column"
          >
            <Text color={t.muted}>{message}</Text>
            <Text color={t.dim}>{messageTime}</Text>
          </Box>

          {showPreview && (
            <Box flexDirection="column" marginTop={1} paddingLeft={1}>
              {affectsCode && hasCodePreview && filePreview && (
                <>
                  <Text color={t.muted}>
                    {filePreview.files.length === 0
                      ? filePreview.conflictCount || filePreview.failureCount
                        ? '没有可安全恢复的文件。'
                        : '代码将保持不变。'
                      : filePreview.lineStatsAvailable
                        ? `代码将恢复 +${filePreview.addedLines} −${filePreview.removedLines}，涉及 ${previewFileLabel(filePreview)}。`
                        : `代码将恢复，涉及 ${previewFileLabel(filePreview)}。`}
                  </Text>
                  {filePreview.conflictCount > 0 && (
                    <Text color={t.warning}>
                      {`将跳过 ${filePreview.conflictCount} 个后续已变更的文件。`}
                    </Text>
                  )}
                  {filePreview.failureCount > 0 && (
                    <Text color={t.warning}>
                      {`有 ${filePreview.failureCount} 个文件无法预览。`}
                    </Text>
                  )}
                </>
              )}
            </Box>
          )}

          <Box marginTop={1}>
            <OverlayChoiceList
              options={confirmOptions}
              selectedId={confirmChoice}
              selectionBackground={false}
            />
          </Box>
        </Box>
      </OverlayFrame>
    );
  }

  return (
    <OverlayFrame
      title="回退"
      meta={
        <Text color={t.dim}>
          {selected + 1} / {actionableCheckpoints.length}
        </Text>
      }
      footer={
        <OverlayShortcutBar
          shortcuts={[
            { keys: '↑↓', label: '导航' },
            { keys: 'Enter', label: '继续' },
            { keys: 'Esc', label: '取消' },
          ]}
        />
      }
    >
      <Box marginTop={1} flexGrow={1} maxHeight={maxContentHeight}>
        <ScrollList selectedIndex={selected} scrollAlignment="auto">
          {actionableCheckpoints.map((checkpoint, index) => {
            const isSelected = index === selected;
            const message = truncateByDisplayWidth(
              normalizeMessage(checkpoint.targetMessage),
              messageWidth * 2,
            );
            const messageTime = formatLocalDateTime(
              checkpoint.targetMessageCreatedAt ?? checkpoint.createdAt,
            );

            return (
              <Box
                key={checkpoint.snapshotId}
                width="100%"
                paddingX={1}
                flexDirection="column"
                backgroundColor={isSelected ? t.userMsgBg : undefined}
              >
                <Box>
                  <Box width={2} flexShrink={0}>
                    <Text bold color={isSelected ? t.primary : t.dim}>
                      {isSelected ? '❯ ' : '  '}
                    </Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text bold={isSelected} color={isSelected ? t.primary : t.muted}>
                      {message}
                    </Text>
                  </Box>
                </Box>
                <Box paddingLeft={2} gap={1}>
                  <Text color={t.dim}>{messageTime}</Text>
                  <Text color={t.dim}>·</Text>
                  <Text color={t.dim}>{fileImpactLabel(checkpoint.affectedFileCount ?? 0)}</Text>
                </Box>
              </Box>
            );
          })}
        </ScrollList>
      </Box>
    </OverlayFrame>
  );
}
