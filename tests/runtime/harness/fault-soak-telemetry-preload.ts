import { afterAll, beforeAll } from 'bun:test';
import { appendFileSync, readdirSync } from 'node:fs';

interface ProcessResourceSample {
  rssBytes: number;
  activeResources: number;
  fileDescriptors?: number;
  listeners: number;
  handles?: number;
}

function fileDescriptorCount(): number | undefined {
  if (process.platform === 'win32') return undefined;
  const directory = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
  try {
    return readdirSync(directory).length;
  } catch {
    return undefined;
  }
}

function activeHandleCount(): number | undefined {
  const getActiveHandles = (
    process as typeof process & { _getActiveHandles?: () => readonly unknown[] }
  )._getActiveHandles;
  return typeof getActiveHandles === 'function' ? getActiveHandles().length : undefined;
}

function sample(): ProcessResourceSample {
  return {
    rssBytes: process.memoryUsage.rss(),
    activeResources: process.getActiveResourcesInfo().length,
    fileDescriptors: fileDescriptorCount(),
    listeners: process
      .eventNames()
      .reduce((total, eventName) => total + process.listenerCount(eventName), 0),
    handles: activeHandleCount(),
  };
}

const telemetryFile = process.env.KITE_FAULT_SOAK_TELEMETRY_FILE;
if (telemetryFile) {
  let before: ProcessResourceSample | undefined;
  beforeAll(() => {
    before = sample();
  });
  afterAll(() => {
    appendFileSync(
      telemetryFile,
      `${JSON.stringify({ version: 1, before: before ?? sample(), after: sample() })}\n`,
      { mode: 0o600 },
    );
  });
}
