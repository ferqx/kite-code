import {
  type KiteAppControlClient,
  WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
  WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
  type WorkspaceTrustQueryResponse,
} from '@kite-ai/kite-app-contract';
import { Box, Text, useInput } from 'ink';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { useTheme } from '../theme';

interface WorkspaceTrustGateProps {
  workspace: string;
  /** The App Control client is connected by the composition root. */
  appControl?: KiteAppControlClient;
  onTrusted: (workspace: import('@kite-ai/kite-app-contract').KiteWorkspaceIdentity) => void;
  onExit?: () => void;
}

type TrustChoice = 'trust' | 'decline';
type GateState = 'loading' | 'ready' | 'saving' | 'error';

export default function WorkspaceTrustGate({
  workspace,
  appControl,
  onTrusted,
  onExit = () => undefined,
}: WorkspaceTrustGateProps) {
  const t = useTheme();
  const { t: translate } = useI18n();
  // Default focus on "Exit Kite Code" — prevents accidental Enter → trust
  const [choice, setChoice] = useState<TrustChoice>('decline');
  const [gateState, setGateState] = useState<GateState>('loading');
  const [trustSnapshot, setTrustSnapshot] = useState<WorkspaceTrustQueryResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const requestVersion = useRef(0);

  const queryTrust = useCallback(
    async (version = requestVersion.current): Promise<WorkspaceTrustQueryResponse | null> => {
      if (!appControl) {
        if (version === requestVersion.current) {
          setTrustSnapshot(null);
          setGateState('error');
          setErrorMessage(null);
        }
        return null;
      }
      try {
        const response = await appControl.queryWorkspaceTrust({
          schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
          workspace,
        });
        if (version !== requestVersion.current) return null;
        setTrustSnapshot(response);
        setGateState('ready');
        setErrorMessage(null);
        if (response.status === 'trusted') onTrusted(response.workspace);
        return response;
      } catch {
        if (version !== requestVersion.current) return null;
        setTrustSnapshot(null);
        setGateState('error');
        setErrorMessage(null);
        return null;
      }
    },
    [appControl, onTrusted, workspace],
  );

  useEffect(() => {
    const version = ++requestVersion.current;
    setTrustSnapshot(null);
    setGateState('loading');
    setErrorMessage(null);
    void queryTrust(version);
    return () => {
      if (requestVersion.current === version) requestVersion.current += 1;
    };
  }, [queryTrust]);

  const submitTrust = useCallback(async () => {
    const observed = trustSnapshot;
    if (!appControl || !observed || observed.status === 'trusted' || !observed.canDecide) {
      if (!observed?.canDecide) {
        setGateState('error');
        setErrorMessage(translate('trust.needsAttention'));
      }
      return;
    }

    const version = ++requestVersion.current;
    setGateState('saving');
    setErrorMessage(null);
    try {
      const response = await appControl.decideWorkspaceTrust({
        schema: WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
        workspace: observed.workspace,
        observedStatus: observed.status,
        expectedRevision: observed.revision,
        decision: 'trust',
        externalReadScopeDigest: observed.externalReadScope.digest,
      });
      if (version !== requestVersion.current) return;
      if (
        response.status === 'trusted' &&
        (response.outcome === 'recorded' || response.outcome === 'already_trusted')
      ) {
        onTrusted(response.workspace);
        return;
      }
      const refreshed = await queryTrust(version);
      if (version !== requestVersion.current) return;
      if (refreshed?.status !== 'trusted') {
        setGateState('error');
        setErrorMessage(translate('trust.saveFailed'));
      }
    } catch {
      // A lost response is not permission to replay the mutation. Re-query
      // authoritative state once, then leave the explicit decision to the user.
      const refreshed = await queryTrust(version);
      if (version !== requestVersion.current) return;
      if (refreshed?.status !== 'trusted') {
        setGateState('error');
        setErrorMessage(translate('trust.saveFailed'));
      }
    }
  }, [appControl, onTrusted, queryTrust, translate, trustSnapshot]);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onExit();
      return;
    }
    if (key.upArrow || key.downArrow) {
      setChoice((current) => (current === 'trust' ? 'decline' : 'trust'));
      setErrorMessage(null);
      if (gateState === 'error') setGateState('ready');
      return;
    }
    if (key.return) {
      if (choice === 'decline' || gateState === 'saving') {
        if (choice === 'decline') onExit();
        return;
      }
      if (gateState === 'loading') return;
      void submitTrust();
      return;
    }
  });

  const trustStatus = trustSnapshot?.status ?? 'unavailable';

  if (gateState === 'loading') {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color={t.primary}>Kite Code</Text>
        <Box marginTop={1}>
          <Text color={t.muted}>{translate('common.loading')}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={t.dim}>{workspace}</Text>
        </Box>
      </Box>
    );
  }

  if (gateState === 'saving') {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color={t.primary}>Kite Code</Text>
        <Box marginTop={1}>
          <Text color={t.muted}>{translate('trust.saving')}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={t.dim}>{workspace}</Text>
        </Box>
      </Box>
    );
  }

  const isError = gateState === 'error' || trustStatus !== 'unknown';

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box flexDirection="column">
        <Text color={t.primary}>Kite Code</Text>
        <Box marginTop={1}>
          <Text color={t.muted}>{translate('trust.openWorkspace')}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={t.dim}>{workspace}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={t.muted}>{translate('trust.providesConfiguration')}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={t.muted}>{translate('trust.approvalSettings')}</Text>
        </Box>
        {trustSnapshot && trustSnapshot.externalReadScope.roots.length > 0 ? (
          <Box marginTop={1} flexDirection="column">
            <Text color={t.muted}>{translate('trust.externalReadScope')}</Text>
            {trustSnapshot.externalReadScope.roots.map((root) => (
              <Text key={root} color={t.dim}>
                {root}
              </Text>
            ))}
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Text color={t.dim}>Trust status: {trustStatus}</Text>
        </Box>
        {isError && errorMessage ? (
          <Box marginTop={1} flexDirection="column">
            <Text color={t.error}>{translate('trust.saveFailed')}</Text>
            <Box marginTop={1}>
              <Text color={t.muted}>{errorMessage}</Text>
            </Box>
          </Box>
        ) : null}
        {isError && !errorMessage ? (
          <Box marginTop={1}>
            <Text color={t.error}>{translate('trust.needsAttention')}</Text>
          </Box>
        ) : null}
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color={choice === 'trust' ? t.primary : t.muted}>
              {choice === 'trust' ? '\u203A' : ' '} {translate('trust.accept')}
            </Text>
          </Box>
          <Box>
            <Text color={choice === 'decline' ? t.primary : t.muted}>
              {choice === 'decline' ? '\u203A' : ' '} {translate('trust.exit')}
            </Text>
          </Box>
        </Box>
        <Box marginTop={1}>
          <Text color={t.dim}>
            {'\u2191\u2193'} {translate('common.navigate')} Enter {translate('common.confirm')}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
