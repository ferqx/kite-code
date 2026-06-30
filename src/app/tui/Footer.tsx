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
  timerKey: number;
  children?: ReactNode;
}

export default function Footer({ status, runStatus, running, timerKey, children }: FooterProps) {
  return (
    <Box flexDirection="column">
      <StatusBar status={status} runStatus={runStatus} running={running} timerKey={timerKey} />
      {children}
      <StatsLine
        status={status}
        running={running}
        modelProvider={status.modelProvider}
        modelName={status.modelName}
      />
    </Box>
  );
}
