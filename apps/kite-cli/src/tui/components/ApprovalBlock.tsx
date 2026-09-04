import type { RuntimeClientInteraction, ShellApprovalGrant } from '@kite-ai/runtime-contract';
import { Box, Text, useInput } from 'ink';
import { useRef, useState } from 'react';
import type { TuiUserInputProvider } from '#kite-cli/tui/provider';
import { useTheme } from '#kite-cli/tui/theme';
import { useI18n } from '../i18n';
import {
  classifyInteractionSubmissionFailure,
  type InteractionSubmissionFailure,
} from '../interaction-submission-diagnostic';
import type { TuiPendingApproval } from '../types';
import OverlayChoiceList from './OverlayChoiceList';
import OverlayFrame, { OverlayShortcutBar } from './OverlayFrame';

export interface ApprovalBlockProps {
  approval: Extract<RuntimeClientInteraction, { readonly kind: 'approval' }>;
  provider: TuiUserInputProvider;
  onResolved: (action: string, grant?: string) => void;
  queueEntry?: TuiPendingApproval;
  externalSubmissionFailure?: InteractionSubmissionFailure;
}

interface Option {
  label: string;
  action: 'approve' | 'deny';
  grant?: ShellApprovalGrant;
}

export default function ApprovalBlock({
  approval,
  provider,
  onResolved,
  queueEntry,
  externalSubmissionFailure,
}: ApprovalBlockProps) {
  const t = useTheme();
  const { t: translate } = useI18n();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submissionFailure, setSubmissionFailure] = useState<InteractionSubmissionFailure>();
  const visibleSubmissionFailure = submissionFailure ?? externalSubmissionFailure;
  const selectedIndexRef = useRef(0);
  const submittingRef = useRef(false);
  const rawInputBuffer = useRef('');
  const approvalLabel =
    approval.command ?? approval.title ?? approval.summary ?? translate('approval.genericTool');
  const route = queueEntry?.route ?? 'user';
  const generation = approval.generation;
  const visibleOptions: Option[] = [
    { label: translate('approval.once'), action: 'approve', grant: 'approve_once' },
    { label: translate('approval.session'), action: 'approve', grant: 'same_command' },
    { label: translate('approval.deny'), action: 'deny' },
  ];
  const options = visibleOptions.filter(
    (option) => option.action === 'deny' || approval.grants.includes(option.grant!),
  );
  const choiceOptions = options.map((option) => ({
    id: option.grant ?? 'deny',
    label: option.label,
    description:
      option.grant === 'approve_once'
        ? translate('approval.onceDescription')
        : option.grant === 'same_command'
          ? translate('approval.sessionToolDescription')
          : translate('approval.denyToolDescription'),
  }));

  async function resolve(opt: Option) {
    // Approval actions are accepted only with the focused durable identity
    // pair. Legacy/off-screen cards without that pair cannot grant anything.
    if (
      !queueEntry?.interactionId ||
      queueEntry.interactionId !== approval.interactionId ||
      queueEntry.generation !== generation
    ) {
      return;
    }
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmissionFailure(undefined);
    try {
      if (opt.action === 'approve') {
        const grant = opt.grant ?? 'approve_once';
        const accepted = await provider.submitActionAsync({
          type: 'approve',
          grant,
          interactionId: queueEntry.interactionId,
          generation,
        });
        if (!accepted) throw new Error('Approval submission was not accepted.');
        // The optimistic projection is safe only after Runtime accepts the
        // respond_interaction command receipt.
        onResolved('approve', grant);
      } else {
        const accepted = await provider.submitActionAsync({
          type: 'reject',
          interactionId: queueEntry.interactionId,
          generation,
        });
        if (!accepted) throw new Error('Approval rejection was not accepted.');
        onResolved('denied');
      }
    } catch (error) {
      setSubmissionFailure(classifyInteractionSubmissionFailure(error));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  useInput((input: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean }) => {
    rawInputBuffer.current = `${rawInputBuffer.current}${input}`.slice(-4);
    const upArrow =
      key.upArrow ||
      rawInputBuffer.current.endsWith('\u001b[A') ||
      rawInputBuffer.current.endsWith('[A');
    const downArrow =
      key.downArrow ||
      rawInputBuffer.current.endsWith('\u001b[B') ||
      rawInputBuffer.current.endsWith('[B');
    if (upArrow) {
      rawInputBuffer.current = '';
      const nextIndex = Math.max(0, selectedIndexRef.current - 1);
      selectedIndexRef.current = nextIndex;
      setSelectedIndex(nextIndex);
      return;
    }
    if (downArrow) {
      rawInputBuffer.current = '';
      const nextIndex = Math.min(options.length - 1, selectedIndexRef.current + 1);
      selectedIndexRef.current = nextIndex;
      setSelectedIndex(nextIndex);
      return;
    }
    if (key.return) {
      const opt = options[selectedIndexRef.current];
      if (opt) void resolve(opt);
      return;
    }
  });

  if (submitting) {
    return (
      <OverlayFrame
        title={translate('approval.title', { tool: translate('approval.genericTool') })}
      >
        <Box marginLeft={1}>
          <Text color={t.dim}>{translate('approval.submitting')}</Text>
        </Box>
      </OverlayFrame>
    );
  }

  return (
    <OverlayFrame
      title={translate('approval.title', { tool: translate('approval.genericTool') })}
      footer={
        <OverlayShortcutBar
          shortcuts={[
            { keys: '↑↓', label: translate('common.navigate') },
            { keys: 'Enter', label: translate('common.confirm') },
            { keys: 'Esc', label: translate('common.cancel') },
          ]}
        />
      }
    >
      <Box
        marginLeft={1}
        paddingLeft={1}
        width="100%"
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderColor={t.dim}
      >
        <Text wrap="truncate-end">{approvalLabel}</Text>
      </Box>
      {(route === 'auto' ||
        (queueEntry?.matchCount != null && queueEntry.matchCount > 1) ||
        queueEntry?.status === 'authorized_queued') && (
        <Box marginTop={1} marginLeft={1} flexDirection="column">
          {route === 'auto' && <Text color={t.dim}>{translate('approval.routeAuto')}</Text>}
          {queueEntry?.matchCount != null && queueEntry.matchCount > 1 && (
            <Text color={t.dim}>
              {queueEntry.grant === 'same_command'
                ? translate('approval.batchReleased', { count: queueEntry.matchCount })
                : translate('approval.matchCount', { count: queueEntry.matchCount })}
            </Text>
          )}
          {queueEntry?.status === 'authorized_queued' && (
            <Text color={t.success}>{translate('approval.authorizedQueued')}</Text>
          )}
        </Box>
      )}
      <Box marginTop={1}>
        <OverlayChoiceList
          options={choiceOptions}
          selectedId={choiceOptions[selectedIndex]?.id}
          selectionBackground={false}
        />
      </Box>
      {visibleSubmissionFailure && (
        <Box marginTop={1} marginLeft={1}>
          <Text color={t.error}>
            {translate(`approval.submissionFailed.${visibleSubmissionFailure}`)}
          </Text>
        </Box>
      )}
    </OverlayFrame>
  );
}
