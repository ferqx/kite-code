import React, { type ReactNode } from "react";
import { Box } from "ink";
import StatusBar from "./StatusBar";
import StatsLine from "./StatsLine";
import type { StatusState } from "./types";

interface FooterProps {
  status: StatusState;
  running: boolean;
  compacting: boolean;
  thinkingVisible: boolean;
  timerKey: number;
  elapsedRef: React.MutableRefObject<number>;
  children?: ReactNode;
}

export default function Footer({
  status, running, compacting, thinkingVisible, timerKey, elapsedRef, children,
}: FooterProps) {
  return (
    <Box flexDirection="column">
      <StatusBar
        status={status}
        running={running}
        compacting={compacting}
        timerKey={timerKey}
        onTick={(e) => { elapsedRef.current = e; }}
      />
      {children}
      <StatsLine
        status={status}
        thinkingVisible={thinkingVisible}
        running={running}
        elapsed={elapsedRef.current}
      />
    </Box>
  );
}
