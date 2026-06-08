import React, { type ReactNode } from "react";
import { Box } from "ink";
import StatusBar from "./StatusBar";
import StatsLine from "./StatsLine";
import type { StatusState } from "./types";

interface FooterProps {
  status: StatusState;
  running: boolean;
  timerKey: number;
  children?: ReactNode;
}

export default function Footer({
  status, running, timerKey, children,
}: FooterProps) {
  return (
    <Box flexDirection="column">
      <StatusBar
        status={status}
        running={running}
        timerKey={timerKey}
      />
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
