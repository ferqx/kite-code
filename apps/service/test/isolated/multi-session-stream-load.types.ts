export type LoadTelemetry = {
  pid: number;
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  cpu: { user: number; system: number };
  elapsedMs: number;
  lagMaxMs: number;
  samples: number;
};

export type LoadResourcePhase = LoadTelemetry & {
  phase: 'warmup' | 'middle' | 'tail' | 'quiescent';
  descriptors: number | null;
};
