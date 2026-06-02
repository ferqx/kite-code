import React, { useState, useEffect, type ReactNode } from "react";
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

  useEffect(() => {
    setElapsed(0);
  }, [timerKey]);

  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [timerKey, running]);

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
        elapsed={elapsed}
        modelProvider={status.modelProvider}
        modelName={status.modelName}
      />
    </Box>
  );
}
