import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProfileSelection } from '@kite-ai/agent/profile';
import type { ShellConfigurationOptions } from '../../src/configuration';

export type MixedShellLedger = {
  label: string;
  pid: number;
  descendantPid: number;
  startedAt: number;
  elapsedMs: number;
  seq: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutHash: string;
  stderrHash: string;
  cpuUserUs: number;
  cpuSystemUs: number;
  complete: boolean;
  reason: 'running' | 'finish' | 'signal' | 'deadline';
};
export type MixedShellOptions = {
  durationSeconds?: number;
  tickMs?: number;
  payloadBytes?: number;
  cpuMillis?: number;
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** Private owned fixture only. Business cancellation must still use the real Shell Job. */
export function writeMixedShellScript(workspace: string, input: MixedShellOptions = {}) {
  const settings = {
    durationSeconds: 90,
    tickMs: 200,
    payloadBytes: 2048,
    cpuMillis: 10,
    ...input,
  };
  const ledgerDir = join(workspace, 'mixed-shell-ledgers');
  mkdirSync(ledgerDir, { recursive: true });
  const scriptPath = join(workspace, 'mixed-shell-workload.mjs');
  const finishPath = join(ledgerDir, 'finish-all');
  const script = `
import { createHash } from 'node:crypto';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const settings = ${JSON.stringify(settings)};
const ledgerDir = ${JSON.stringify(ledgerDir)};
const finishPath = ${JSON.stringify(finishPath)};
const label = process.argv[2];
if (!/^[A-Za-z0-9_-]{1,100}$/.test(label)) throw Error('invalid_owned_label');
const ledgerPath = ledgerDir + '/' + label + '.json';
const finishOne = ledgerDir + '/finish-' + label;
const startedAt = Date.now();
const initialCpu = process.cpuUsage();
let reason = 'running', seq = 0, stdoutBytes = 0, stderrBytes = 0;
const hashes = { stdout: createHash('sha256'), stderr: createHash('sha256') };
const descendant = spawn('/bin/sleep', [String(settings.durationSeconds)], { stdio: 'ignore' });
const descendantDone = once(descendant, 'close');
await once(descendant, 'spawn');
function save(complete = false) {
  const cpu = process.cpuUsage(initialCpu);
  const value = { label, pid: process.pid, descendantPid: descendant.pid, startedAt, elapsedMs: Date.now() - startedAt, seq, stdoutBytes, stderrBytes, stdoutHash: hashes.stdout.copy().digest('hex'), stderrHash: hashes.stderr.copy().digest('hex'), cpuUserUs: cpu.user, cpuSystemUs: cpu.system, complete, reason };
  writeFileSync(ledgerPath + '.pending', JSON.stringify(value));
  renameSync(ledgerPath + '.pending', ledgerPath);
}
process.on('SIGTERM', () => { reason = 'signal'; });
process.on('SIGINT', () => { reason = 'signal'; });
const hard = setTimeout(() => { reason = 'deadline'; save(false); descendant.kill('SIGTERM'); process.exit(124); }, settings.durationSeconds * 1000);
function payload(stream, phase, bytes) {
  const prefix = label + '|' + phase + '|' + seq + '|' + stream + '|中文🙂|';
  const prefixBytes = Buffer.byteLength(prefix, 'utf8');
  if (prefixBytes + 1 > bytes) throw Error('fixture_payload_too_small');
  return prefix + (stream === 'stdout' ? 'O' : 'E').repeat(bytes - prefixBytes - 1) + String.fromCharCode(10);
}
async function emit(stream, value) {
  const bytes = Buffer.from(value, 'utf8');
  await new Promise((resolve, reject) => process[stream].write(bytes, error => error ? reject(error) : resolve()));
  hashes[stream].update(bytes);
  if (stream === 'stdout') stdoutBytes += bytes.length; else stderrBytes += bytes.length;
}
try {
  save();
  await emit('stdout', payload('stdout', 'burst', 128 * 1024));
  await emit('stderr', payload('stderr', 'burst', 128 * 1024));
  save();
  while (reason === 'running' && !existsSync(finishPath) && !existsSync(finishOne)) {
    const tick = performance.now();
    let value = 1;
    while (performance.now() - tick < settings.cpuMillis) for (let i = 0; i < 1000; i++) value = Math.imul(value ^ i, 1664525) + 1013904223;
    seq++;
    await emit('stdout', payload('stdout', 'tick', settings.payloadBytes * 3 / 4));
    await emit('stderr', payload('stderr', 'tick', settings.payloadBytes / 4));
    save();
    await new Promise(resolve => setTimeout(resolve, Math.max(0, settings.tickMs - (performance.now() - tick))));
  }
  if (reason === 'running') reason = 'finish';
} finally {
  clearTimeout(hard);
  descendant.kill('SIGTERM');
  await descendantDone;
  save(true);
}
`;
  writeFileSync(scriptPath, script, { mode: 0o600 });
  const validate = (label: string) => {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(label)) throw Error('invalid_owned_label');
    return label;
  };
  return {
    scriptPath,
    ledgerDir,
    finishPath,
    settings,
    ledgerPath: (label: string) => join(ledgerDir, `${validate(label)}.json`),
    finishOnePath: (label: string) => join(ledgerDir, `finish-${validate(label)}`),
    shellCommand: (label: string) =>
      `exec ${quote(process.execPath)} ${quote(scriptPath)} ${quote(validate(label))}`,
  };
}
export async function buildMixedShellSupervisor(directory: string) {
  const output = await Bun.build({
    entrypoints: [
      join(import.meta.dir, '../../../../packages/agent/src/platform/process/shell-supervisor.ts'),
    ],
    target: 'bun',
    outdir: join(directory, 'mixed-shell-assets'),
    naming: 'shell-supervisor.js',
  });
  if (!output.success || !output.outputs[0]) throw Error('mixed_shell_supervisor_build_failed');
  return output.outputs[0].path;
}
/** Same macOS host factory/Seatbelt/coalition contract as packaged defaults; source tests supply built assets explicitly. */
export function mixedShellConfiguration(
  profile: ProfileSelection,
  supervisorPath: string,
): ShellConfigurationOptions {
  return {
    platform: 'darwin',
    configurationId: 'isolated-mixed-macos-host-shell-v1',
    env: { PATH: '/usr/bin:/bin' },
    supervisorPath,
    bunExecutable: process.execPath,
    shellExecutable: '/bin/sh',
    host: {
      controlBase: profile.coordinationPath,
      protectedRoots: [profile.dataRoot, profile.coordinationPath],
      readonlyAssets: [dirname(supervisorPath)],
      runtimeReadOnlyRoots: [dirname(process.execPath)],
    },
  };
}
