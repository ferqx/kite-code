// Guard the actual argv process against accidental networking or owned child startup.
Bun.spawn = (() => {
  throw new Error('trace_started_child');
}) as typeof Bun.spawn;
Bun.spawnSync = (() => {
  throw new Error('trace_started_child');
}) as typeof Bun.spawnSync;
globalThis.fetch = (() => {
  throw new Error('trace_network_attempt');
}) as unknown as typeof fetch;
