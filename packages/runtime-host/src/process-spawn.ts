/**
 * Single Runtime process-creation primitive. Builtin domain code supplies an
 * already-authorized argv/environment; Runtime Host alone touches Bun.spawn.
 */
export const spawnRuntimeHostProcessV1: typeof Bun.spawn = Bun.spawn;
