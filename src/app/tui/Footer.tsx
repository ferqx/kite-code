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
  children?: ReactNode;
}

export default function Footer({
  status, running, compacting, thinkingVisible, timerKey, children,
}: FooterProps) {
  return (
    <Box flexDirection="column">
      <StatusBar
        status={status}
        running={running}
        compacting={compacting}
        timerKey={timerKey}
      />
      {children}
      <StatsLine
        status={status}
        thinkingVisible={thinkingVisible}
        running={running}
        modelProvider={status.modelProvider}
        modelName={status.modelName}
      />
    </Box>
  );
}
