import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpStdioLinuxEvidence } from '../../../src/mcp/stdio-process-evidence';
import type {
  LinuxOwnedProgram,
  LinuxOwnedProgramCompletion,
} from '../../../src/platform/process/linux-owned-program';

const { root, guardian, initExecutable, bubblewrapPath, proof, binding } = JSON.parse(
  process.argv[2]!,
) as {
  root: string;
  guardian: string;
  initExecutable: string;
  bubblewrapPath: string;
  proof: McpStdioLinuxEvidence;
  binding: McpStdioLinuxEvidence['binding'];
};
Object.defineProperty(process, 'platform', { value: 'linux' });
let current!: {
    unknown: boolean;
    cancels: number;
    evidence: McpStdioLinuxEvidence['process'];
    terminal(): void;
  },
  opens = 0,
  writes = 0,
  admissions = 0,
  fresh = true;
const full = `完整原结果🙂${'x'.repeat(65536)}`;
class LinuxOwnedProgramStartError extends Error {}
mock.module(
  new URL('../../../src/platform/process/linux-owned-program.ts', import.meta.url).pathname,
  () => ({
    LinuxOwnedProgramStartError,
    startLinuxOwnedProgram(options: {
      initExecutable: string;
      bubblewrapPath: string;
      executable: string;
      argv: string[];
      env: Record<string, string>;
      cwd: string;
      nonce: string;
    }): LinuxOwnedProgram {
      opens++;
      assert.equal(options.initExecutable, initExecutable);
      assert.equal(options.bubblewrapPath, bubblewrapPath);
      assert.equal(options.executable, process.execPath);
      assert.deepEqual(options.argv, ['literal ; $() original']);
      assert.deepEqual(options.env, { ONLY_ORIGINAL: 'original-value' });
      assert.equal(options.cwd, root);
      const evidence = structuredClone(proof.process);
      evidence.ownerPid = process.pid;
      evidence.admission.nonce = options.nonce;
      evidence.wrapper = {
        ...evidence.wrapper,
        pid: process.pid + 1,
        parentPid: process.pid,
        exit: null,
        closed: false,
        stdoutEof: false,
        stderrEof: false,
      };
      evidence.namespace!.init = {
        ...evidence.namespace!.init,
        pid: process.pid + 2,
        parentPid: process.pid + 1,
        dead: false,
      };
      evidence.namespace!.root = {
        ...evidence.namespace!.root!,
        pid: process.pid + 3,
        parentPid: process.pid + 2,
        dead: false,
        waitReceipt: null,
      };
      evidence.namespace!.treeStopped = false;
      evidence.phase = 'ready';
      evidence.fdClosed = false;
      const stdout = new PassThrough(),
        stderr = new PassThrough();
      let complete!: (result: LinuxOwnedProgramCompletion) => void;
      const completion = new Promise<LinuxOwnedProgramCompletion>((resolve) => {
        complete = resolve;
      });
      const terminal = () => {
        evidence.phase = 'terminal';
        evidence.fdClosed = true;
        evidence.closeUnknown = false;
        evidence.wrapper.exit = { code: 0, signal: null, reaped: true };
        evidence.wrapper.closed = true;
        evidence.wrapper.stdoutEof = true;
        evidence.wrapper.stderrEof = true;
        evidence.namespace!.init.dead = true;
        evidence.namespace!.root!.dead = true;
        evidence.namespace!.treeStopped = true;
        evidence.namespace!.root!.waitReceipt = structuredClone(
          proof.process.namespace!.root!.waitReceipt,
        );
      };
      const active = { unknown: false, cancels: 0, evidence, terminal };
      current = active;
      return {
        pid: evidence.wrapper.pid,
        stdout,
        stderr,
        ready: Promise.resolve(),
        completion,
        readProcessEvidence: () => structuredClone(evidence),
        async writeStdin(bytes, beforeWrite) {
          await Promise.resolve();
          beforeWrite?.();
          writes++;
          const request = JSON.parse(Buffer.from(bytes).toString());
          let result: unknown;
          if (request.method === 'initialize')
            result = {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'original', version: '1' },
              capabilities: { tools: {} },
            };
          else if (request.method === 'tools/list')
            result = {
              tools: [
                {
                  name: 'exact',
                  description: 'original SDK Tool',
                  inputSchema: {
                    type: 'object',
                    required: ['value'],
                    properties: { value: { type: 'string' } },
                  },
                },
              ],
            };
          else if (request.method === 'tools/call') {
            assert.deepEqual(request.params, {
              name: 'exact',
              arguments: { value: 'exact input' },
            });
            result = { content: [{ type: 'text', text: full }] };
          } else {
            assert.equal(request.method, 'notifications/initialized');
            return;
          }
          const raw = Buffer.from(
            `${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`,
          );
          for (let at = 0; at < raw.length; at += 7) stdout.write(raw.subarray(at, at + 7));
        },
        async endStdin() {},
        cancel() {
          active.cancels++;
          stdout.end();
          stderr.end();
          if (active.unknown) {
            evidence.phase = 'unknown';
            evidence.closeUnknown = true;
            complete({ confirmed: false, code: null, signal: null, reason: 'cancel' });
            setTimeout(terminal, 5);
          } else {
            terminal();
            complete({ confirmed: true, code: 7, signal: null, reason: 'cancel' });
          }
          return completion;
        },
      };
    },
  }),
);
const { createMcpStdioTransportPort } = await import('../../../src/mcp/stdio-port');
const { createMcpAdapter } = await import('../../../src/mcp/index');
const { decodeMcpStdioProcessEvidence } = await import('../../../src/mcp/stdio-process-evidence');
const configuration = {
  type: 'stdio' as const,
  command: process.execPath,
  args: ['literal ; $() original'],
  cwd: root,
  env: { ONLY_ORIGINAL: 'original-value' },
};
const originalBinding = {
  ...binding,
  configDigest: createMcpAdapter({ id: 'server', transport: configuration }).getCatalogue()
    .configDigest,
  configuration,
};
const controller = new AbortController();
const port = createMcpStdioTransportPort({
  servers: [{ id: 'server', configuration }],
  guardianPath: guardian,
  bunExecutable: process.execPath,
  linux: { initExecutable, bubblewrapPath },
  allowedEnvNames: ['ONLY_ORIGINAL'],
  async admit(value) {
    admissions++;
    assert.deepEqual(value, originalBinding);
  },
  assertFresh(value, { signal }) {
    assert.deepEqual(value, originalBinding);
    assert.equal(signal, controller.signal);
    if (!fresh) throw Error('original_source_changed');
  },
});
const owned = await port.open(originalBinding, { signal: controller.signal });
const client = new Client({ name: 'formal SDK', version: '1' });
await client.connect(owned.transport);
assert.deepEqual(
  (await client.listTools()).tools.map((row) => row.name),
  ['exact'],
);
const result = await client.callTool({ name: 'exact', arguments: { value: 'exact input' } });
assert.deepEqual(result.content, [{ type: 'text', text: full }]);
const ready = owned.readProcessEvidence!();
assert.equal(ready.version, 4);
assert.deepEqual(ready.binding, { ...binding, configDigest: originalBinding.configDigest });
assert.ok(decodeMcpStdioProcessEvidence(ready, originalBinding, process.pid));
const before = writes;
const stale = owned.transport.send({ jsonrpc: '2.0', id: 100, method: 'fixture' });
fresh = false;
await assert.rejects(stale, /mcp_stdio_write_failed/);
assert.equal(writes, before);
fresh = true;
await client.close();
assert.equal((await owned.stopped).supervision, 'ended');
assert.equal((await owned.stop()).status, 'stopped');
assert.equal(current.cancels, 1);
const stoppedEvidence = owned.readProcessEvidence!();
assert.equal(stoppedEvidence.version, 4);
if (stoppedEvidence.version !== 4) throw Error('linux_original_proof_required');
assert.equal(stoppedEvidence.process.fdClosed, true);
assert.ok(decodeMcpStdioProcessEvidence(stoppedEvidence, originalBinding, process.pid));
const unknown = await port.open(originalBinding, { signal: controller.signal });
await unknown.transport.start();
current.unknown = true;
assert.equal((await unknown.stop()).status, 'unknown');
assert.equal((await unknown.stopped).supervision, 'unknown');
const first = unknown.readProcessEvidence!();
await new Promise((resolve) => setTimeout(resolve, 15));
assert.equal(current.evidence.phase, 'terminal');
assert.deepEqual(unknown.readProcessEvidence!(), first);
assert.equal((await unknown.stop()).status, 'unknown');
assert.equal(opens, 2);
assert.equal(admissions, 2);
assert.equal(current.cancels, 1);
process.exit(0);
