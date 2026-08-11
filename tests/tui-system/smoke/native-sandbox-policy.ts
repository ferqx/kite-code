export function nativeSandboxSmokeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KITE_RUN_NATIVE_SANDBOX_SMOKE === '1';
}
