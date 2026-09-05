import { Box } from 'ink';
import type { ReactNode } from 'react';
import type { RunStatusSnapshot } from './run-status';
import StatsLine from './StatsLine';
import StatusBar from './StatusBar';
import type { StatusState } from './types';

interface FooterProps {
  status: StatusState;
  runStatus?: RunStatusSnapshot;
  running: boolean;
  interactionMode?: 'accept_edits' | 'auto' | 'full';
  hideGlobalStatus?: boolean;
  children?: ReactNode;
}

export default function Footer({
  status,
  runStatus,
  running,
  interactionMode,
  hideGlobalStatus = false,
  children,
}: FooterProps) {
  return (
    <Box flexDirection="column">
      <StatusBar runStatus={runStatus} running={running} />
      {children}
      {!hideGlobalStatus && (
        <StatsLine
          status={status}
          running={running}
          modelProvider={status.modelProvider}
          modelName={status.modelName}
          interactionMode={interactionMode}
          planMode={status.phase === 'planning'}
        />
      )}
    </Box>
  );
}
