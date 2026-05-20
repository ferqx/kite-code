import React, { useState, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import { darkTheme as t } from "./theme";

export interface ActivityBarProps {
  running: boolean;
  timerKey: number;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export default React.memo(function ActivityBar({ running, timerKey }: ActivityBarProps) {
  const [elapsed, setElapsed] = useState(0);
  const [spinnerIdx, setSpinnerIdx] = useState(0);
  const prevTimerKeyRef = useRef(timerKey);

  useEffect(() => {
    if (timerKey !== prevTimerKeyRef.current) {
      prevTimerKeyRef.current = timerKey;
      setElapsed(0);
      setSpinnerIdx(0);
    }
  }, [timerKey]);

  useEffect(() => {
    if (!running) {
      setSpinnerIdx(0);
      return;
    }
    const timer = setInterval(() => {
      setSpinnerIdx((prev) => (prev + 1) % SPINNER.length);
    }, 80);
    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [timerKey, running]);

  if (!running) return null;

  const elapsedStr = `${Math.floor(elapsed / 60).toString().padStart(2, "0")}:${(elapsed % 60).toString().padStart(2, "0")}`;

  return (
    <Box>
      <Text color={t.primary}>{SPINNER[spinnerIdx]} Thinking</Text>
      <Text color={t.muted}>  {elapsedStr}</Text>
    </Box>
  );
});
