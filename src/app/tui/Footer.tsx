import React, { useState, type ReactNode } from "react";
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
  children?: ReactNode;
}

export default function Footer({
  status, running, compacting, thinkingVisible, timerKey, children,
}: FooterProps) {
  const [elapsed, setElapsed] = useState(0);

  return (
    <Box flexDirection="column">
      <StatusBar
        status={status}
        running={running}
        compacting={compacting}
        timerKey={timerKey}
        onTick={(e) => setElapsed(e)}
      />
      {children}
      <StatsLine
        status={status}
        thinkingVisible={thinkingVisible}
        running={running}
        elapsed={elapsed}
      />
    </Box>
  );
}
