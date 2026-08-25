import { Box, Text, useInput, useStdout } from 'ink';
import { ScrollList } from 'ink-scroll-list';
import { type MutableRefObject, useEffect, useMemo, useRef, useState } from 'react';
import stringWidth from 'string-width';
import { useOverlayHeight } from '../hooks/useOverlayHeight';
import { useI18n } from '../i18n';
import type { RewindFilePreview, RuntimeCheckpointEntry } from '../runtime-presentation';
import { useTheme } from '../theme';
import type { RewindScope } from '../types';
import OverlayChoiceList, { type OverlayChoiceOption } from './OverlayChoiceList';
import OverlayFrame, { OverlayShortcutBar } from './OverlayFrame';
import {
  OverlayEmptyState,
  OverlayImpactNotice,
  OverlayList,
  OverlayListRow,
} from './OverlayPrimitives';

export type { RuntimeCheckpointEntry };

type RewindStage = 'browse' | 'confirm';
type ConfirmChoice = RewindScope;

interface CheckpointSelectorProps {
  checkpoints: RuntimeCheckpointEntry[];
  onConfirm: (checkpointId: string, scope: RewindScope) => void;
  onClose: () => void;
  getRewindPreview?: (checkpointId: string) => RewindFilePreview | null;
  layeredEscRef?: MutableRefObject<boolean>;
}

function normalizeMessage(content: string | undefined, fallback: string): string {
  return content?.replace(/\s+/g, ' ').trim() || fallback;
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

function previewFileLabel(
  preview: RewindFilePreview,
  translate: (key: 'rewind.moreFiles', values: { path: string; count: number }) => string,
): string {
  const primaryPath = preview.files[0]?.path;
  if (!primaryPath) return '';
  const remainingFiles = preview.files.length - 1;
  return remainingFiles > 0
    ? translate('rewind.moreFiles', { path: primaryPath, count: remainingFiles })
    : primaryPath;
}

export default function CheckpointSelector({
  checkpoints,
  onConfirm,
  onClose,
  getRewindPreview,
  layeredEscRef,
}: CheckpointSelectorProps) {
  const t = useTheme();
  const { formatDateTime, t: translate } = useI18n();
  const { stdout } = useStdout();
  const [stage, setStage] = useState<RewindStage>('browse');
  const [selected, setSelected] = useState(0);
  const [confirmChoice, setConfirmChoice] = useState<ConfirmChoice>('code_and_conversation');
  const [filePreview, setFilePreview] = useState<RewindFilePreview | null>(null);
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
  const confirmOptions: readonly OverlayChoiceOption<ConfirmChoice>[] = [
    {
      id: 'code_and_conversation',
      label: translate('rewind.codeAndConversation'),
      description: translate('rewind.codeAndConversationDescription'),
    },
    {
      id: 'conversation_only',
      label: translate('rewind.conversationOnly'),
      description: translate('rewind.conversationOnlyDescription'),
    },
    {
      id: 'code_only',
      label: translate('rewind.codeOnly'),
      description: translate('rewind.codeOnlyDescription'),
    },
  ];
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
        title={translate('rewind.title')}
        footer={
          <OverlayShortcutBar shortcuts={[{ keys: 'Esc', label: translate('common.close') }]} />
        }
      >
        <OverlayEmptyState>{translate('rewind.empty')}</OverlayEmptyState>
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
      normalizeMessage(selectedCheckpoint.targetMessage, translate('rewind.defaultMessage')),
      messageWidth * 2,
    );
    const messageTime = formatDateTime(
      (selectedCheckpoint.targetMessageCreatedAt ?? selectedCheckpoint.createdAt) * 1000,
    );

    return (
      <OverlayFrame
        title={translate('rewind.beforeMessage')}
        footer={
          <OverlayShortcutBar
            shortcuts={[
              { keys: '↑↓', label: translate('common.navigate') },
              { keys: 'Enter', label: translate('common.confirm') },
              { keys: 'Esc', label: translate('common.back') },
            ]}
          />
        }
      >
        <Box flexDirection="column">
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
                        ? translate('rewind.noSafeFiles')
                        : translate('rewind.codeUnchanged')
                      : filePreview.lineStatsAvailable
                        ? translate('rewind.restoreLines', {
                            added: filePreview.addedLines,
                            removed: filePreview.removedLines,
                            files: previewFileLabel(filePreview, translate),
                          })
                        : translate('rewind.restoreFiles', {
                            files: previewFileLabel(filePreview, translate),
                          })}
                  </Text>
                  {filePreview.conflictCount > 0 && (
                    <Text color={t.warning}>
                      {translate('rewind.skipConflicts', { count: filePreview.conflictCount })}
                    </Text>
                  )}
                  {filePreview.failureCount > 0 && (
                    <Text color={t.warning}>
                      {translate('rewind.previewFailures', { count: filePreview.failureCount })}
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
          <OverlayImpactNotice>
            {confirmChoice === 'code_and_conversation'
              ? translate('rewind.impactCodeAndConversation')
              : confirmChoice === 'conversation_only'
                ? translate('rewind.impactConversationOnly')
                : translate('rewind.impactCodeOnly')}
          </OverlayImpactNotice>
        </Box>
      </OverlayFrame>
    );
  }

  return (
    <OverlayFrame
      title={translate('rewind.title')}
      meta={
        <Text color={t.dim}>
          {selected + 1} / {actionableCheckpoints.length}
        </Text>
      }
      footer={
        <OverlayShortcutBar
          shortcuts={[
            { keys: '↑↓', label: translate('common.navigate') },
            { keys: 'Enter', label: translate('rewind.continue') },
            { keys: 'Esc', label: translate('common.close') },
          ]}
        />
      }
    >
      <Box flexGrow={1} maxHeight={maxContentHeight}>
        <ScrollList selectedIndex={selected} scrollAlignment="auto">
          <OverlayList>
            {actionableCheckpoints.map((checkpoint, index) => {
              const isSelected = index === selected;
              const message = truncateByDisplayWidth(
                normalizeMessage(checkpoint.targetMessage, translate('rewind.defaultMessage')),
                messageWidth * 2,
              );
              const messageTime = formatDateTime(
                (checkpoint.targetMessageCreatedAt ?? checkpoint.createdAt) * 1000,
              );

              return (
                <OverlayListRow
                  key={checkpoint.snapshotId}
                  selected={isSelected}
                  primary={message}
                  secondary={`${messageTime} · ${
                    (checkpoint.affectedFileCount ?? 0) > 0
                      ? translate('rewind.fileImpact', { count: checkpoint.affectedFileCount ?? 0 })
                      : translate('rewind.noFileChanges')
                  }`}
                />
              );
            })}
          </OverlayList>
        </ScrollList>
      </Box>
    </OverlayFrame>
  );
}
