import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { afterAll, expect, test } from '#kite-test';
import { build as buildBundle } from '../../../../../scripts/tooling/build';
import { spawn as spawnProcess } from '../../../../../scripts/tooling/process';
import { ownedProcessKernelState } from '../../../src/platform/process/owned-process-observation';
import {
  BrowserExecutorStartupError,
  createBrowserExecutor,
} from '../../../src/tools/browser/executor';
import { createExecutorCpuBudget } from '../../../src/tools/browser/executor/cpu-budget';
import { fixtureNodeExecutable, fixtureRuntimeBuild } from '../../fixtures/node-runtime';

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-executor-test-')));
writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
const built = await buildBundle({
  entrypoints: [join(import.meta.dirname, '../../../src/mcp/stdio-guardian.ts')],
  ...fixtureRuntimeBuild(root),
  outdir: root,
  naming: '[name].js',
});
const worker = await buildBundle({
  entrypoints: [join(import.meta.dirname, '../../../src/tools/browser/executor/worker.ts')],
  ...fixtureRuntimeBuild(root),
  outdir: root,
  naming: 'worker.mjs',
});
if (!built.success || !worker.success) throw Error('fixture_build_failed');
afterAll(() => rmSync(root, { recursive: true, force: true }));
const macTest = process.platform === 'darwin' ? test : test.skip;
const signal = () => new AbortController().signal;
const fixture = () =>
  createBrowserExecutor({
    scope: crypto.randomUUID(),
    workerPath: join(root, 'worker.mjs'),
    guardianPath: join(root, 'stdio-guardian.js'),
    runtimeExecutable: fixtureNodeExecutable(),
  });

macTest(
  'evaluation failure preserves the same suspended VM and variables for the next batch',
  async () => {
    const executor = await fixture();
    try {
      await executor.execute({
        code: 'var retained = 7;',
        signal: signal(),
        call: async () => null,
      });
      expect(
        await executor.execute({
          code: 'throw new TypeError("known_evaluation");',
          signal: signal(),
          call: async () => null,
        }),
      ).toMatchObject({ failure: { kind: 'evaluation', message: 'TypeError: known_evaluation' } });
      const budget = createExecutorCpuBudget(executor.readProcessEvidence().root!);
      try {
        expect(budget.isSuspended()).toBe(true);
      } finally {
        budget.close();
      }
      expect(
        await executor.execute({
          code: 'retained += 1; retained',
          signal: signal(),
          call: async () => null,
        }),
      ).toEqual({ value: 8, output: '' });
    } finally {
      expect(await executor.close()).toEqual({ confirmed: true });
    }
  },
);

macTest(
  'old timer and promise continuations cannot borrow a later batch API identity',
  async () => {
    const executor = await fixture();
    const seen: string[] = [];
    const call = async (method: string) => {
      seen.push(method);
      return null;
    };
    try {
      await executor.execute({
        code: 'var late = new Promise(resolve => setTimeout(resolve, 60)).then(() => browser.call("late")).catch(() => null); 7',
        signal: signal(),
        call,
      });
      await executor.execute({
        code: 'await new Promise(resolve => setTimeout(resolve, 150)); await browser.call("fresh")',
        signal: signal(),
        call,
      });
      expect(seen).toEqual(['fresh']);
    } finally {
      expect(await executor.close()).toEqual({ confirmed: true });
    }
  },
);

macTest(
  'OS sandbox runs persistent await and page handles over the original owned-program channel',
  async () => {
    const executor = await fixture();
    const calls: unknown[] = [];
    const call = async (method: string, args: unknown) => {
      calls.push([method, args]);
      return method === 'open' ? 'opaque-page' : { text: 'verified' };
    };
    try {
      expect(
        await executor.execute({
          code: 'var p = await browser.open("http://localhost/example"); var count = 4; const signature="kept"; let mutable=1; await p.dialogs(); await p.snapshot()',
          signal: signal(),
          call,
        }),
      ).toMatchObject({ value: { text: 'verified' } });
      expect(
        await executor.execute({
          code: 'count += mutable; console.log(signature, p.id); count',
          signal: signal(),
          call,
        }),
      ).toEqual({ value: 5, output: 'kept opaque-page\n' });
      expect(calls).toEqual([
        ['open', { url: 'http://localhost/example' }],
        ['dialogs', { page: 'opaque-page', args: [] }],
        ['snapshot', { page: 'opaque-page', args: [] }],
      ]);
    } finally {
      expect(await executor.close()).toEqual({ confirmed: true });
    }
  },
);

macTest(
  'API failure is sticky even when caught, and queued dependent calls never reach host',
  async () => {
    const executor = await fixture();
    const seen: string[] = [];
    try {
      await expect(
        executor.execute({
          code: 'try { await browser.call("denied") } catch {} await browser.call("after")',
          signal: signal(),
          call: async (method) => {
            seen.push(method);
            throw Error('explicit_denial');
          },
        }),
      ).rejects.toThrow('browser_executor_failed');
      expect(seen).toEqual(['denied']);
    } finally {
      expect(await executor.close()).toEqual({ confirmed: true });
    }
  },
);

macTest('deadline terminates an actual infinite loop and closes its owned tree', async () => {
  const executor = await fixture();
  await expect(
    executor.execute({
      code: 'while (true) {}',
      signal: signal(),
      call: async () => null,
      timeoutMs: 100,
    }),
  ).rejects.toThrow('browser_executor_timeout');
  expect(await executor.close()).toEqual({ confirmed: true });
});

macTest(
  'cancellation hard-stops code after API dispatch and prevents subsequent calls',
  async () => {
    const executor = await fixture();
    const cancellation = new AbortController();
    let count = 0;
    await expect(
      executor.execute({
        code: 'await browser.call("first"); await browser.call("second")',
        signal: cancellation.signal,
        call: async () => {
          count++;
          cancellation.abort();
          return null;
        },
      }),
    ).rejects.toThrow('browser_executor_cancelled');
    expect(count).toBe(1);
    expect(await executor.close()).toEqual({ confirmed: true });
  },
);

macTest(
  'OS denies private-file reads, writes and subprocesses without removing JS globals',
  async () => {
    const executor = await fixture();
    const secret = join(root, 'synthetic-secret');
    writeFileSync(secret, 'SYNTHETIC_PRIVATE_MATERIAL');
    const dataAlias = `/System/Volumes/Data${secret}`;
    const original = statSync(secret, { bigint: true }),
      alias = statSync(dataAlias, { bigint: true });
    expect([alias.dev, alias.ino]).toEqual([original.dev, original.ino]);
    try {
      const value = await executor.execute({
        code: `var failures = []; for (var action of [async () => await process.getBuiltinModule("node:fs/promises").readFile(${JSON.stringify(secret)}, "utf8"), async () => await process.getBuiltinModule("node:fs/promises").readFile(${JSON.stringify(dataAlias)}, "utf8"), async () => await process.getBuiltinModule("node:fs/promises").writeFile(${JSON.stringify(secret)}, "changed"), async () => new Promise((resolve, reject) => process.getBuiltinModule("node:child_process").spawn("/bin/echo", ["forbidden"]).once("error", reject).once("spawn", resolve))]) { try { await action(); failures.push(false) } catch { failures.push(true) } }; failures`,
        signal: signal(),
        call: async () => null,
      });
      expect(value.value).toEqual([true, true, true, true]);
      expect(readFileSync(secret, 'utf8')).toBe('SYNTHETIC_PRIVATE_MATERIAL');
    } finally {
      expect(await executor.close()).toEqual({ confirmed: true });
    }
  },
);

macTest(
  'actual TCP and Unix listeners accept host controls but zero sandbox connections',
  async () => {
    let accepted = 0;
    const tcp = createServer((socket) => {
      accepted++;
      socket.end();
    });
    const unix = createServer((socket) => {
      accepted++;
      socket.end();
    });
    const unixPath = join(root, 'network.sock');
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => unix.listen(unixPath, resolve));
    const port = (tcp.address() as { port: number }).port;
    const targets = [{ host: '127.0.0.1', port }, { path: unixPath }];
    const executor = await fixture();
    try {
      for (const target of targets)
        await new Promise<void>((resolve, reject) => {
          const socket = createConnection(target, () => {
            socket.end();
            resolve();
          });
          socket.once('error', reject);
        });
      await sleepTimer(25);
      expect(accepted).toBe(2);
      accepted = 0;
      const result = await executor.execute({
        code: `var denied = []; for(var target of ${JSON.stringify(targets)}) { try { await new Promise((resolve, reject) => { const socket = process.getBuiltinModule('node:net').createConnection(target, () => { socket.end(); resolve(); }); socket.once('error', reject); }); denied.push(false) } catch { denied.push(true) } }; denied`,
        signal: signal(),
        call: async () => null,
      });
      expect(result.value).toEqual([true, true]);
      expect(accepted).toBe(0);
    } finally {
      expect(await executor.close()).toEqual({ confirmed: true });
      await Promise.all(
        [tcp, unix].map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
      );
    }
  },
);

macTest('missing fixed runtime assets report unavailable without a fallback process', async () => {
  try {
    await createBrowserExecutor({
      scope: 'missing',
      workerPath: join(root, 'missing.mjs'),
      guardianPath: join(root, 'stdio-guardian.js'),
    });
    throw Error('expected_startup_failure');
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserExecutorStartupError);
    expect((error as BrowserExecutorStartupError).cleanupConfirmed).toBe(true);
    expect((error as Error).message).toBe('browser_executor_unavailable');
  }
});

macTest(
  'host approval wait pauses wall budget while kernel CPU budget still kills a spinning caller',
  async () => {
    const executor = await fixture();
    try {
      expect(
        await executor.execute({
          code: 'await browser.call("approval")',
          signal: signal(),
          timeoutMs: 100,
          call: async () => {
            await sleepTimer(250);
            return 'allowed';
          },
        }),
      ).toMatchObject({ value: 'allowed' });
      const started = performance.now();
      await expect(
        executor.execute({
          code: 'browser.call("approval"); while (true) {}',
          signal: signal(),
          timeoutMs: 100,
          call: async () => {
            await sleepTimer(250);
            return 'too late';
          },
        }),
      ).rejects.toThrow('browser_executor_timeout');
      expect(performance.now() - started).toBeLessThan(1000);
      expect(await executor.close()).toEqual({ confirmed: true });
    } finally {
      await executor.close();
    }
  },
);

macTest('forged replayed worker RPC IDs are rejected before the host dispatch', async () => {
  const executor = await fixture();
  let calls = 0;
  try {
    await expect(
      executor.execute({
        code: 'process.stdout.write(JSON.stringify({type:"call",batch:1,id:2,method:"forged",args:null})+"\\n"); await new Promise(() => {})',
        signal: signal(),
        call: async () => {
          calls++;
          return null;
        },
      }),
    ).rejects.toThrow('browser_executor_call_limit');
    expect(calls).toBe(0);
    expect(await executor.close()).toEqual({ confirmed: true });
  } finally {
    await executor.close();
  }
});

macTest('distinct host scopes have distinct JavaScript state', async () => {
  const a = await fixture(),
    b = await fixture();
  try {
    await a.execute({ code: 'var onlyA = 42', signal: signal(), call: async () => null });
    expect(
      await b.execute({ code: 'typeof onlyA', signal: signal(), call: async () => null }),
    ).toMatchObject({ value: 'undefined' });
    expect(a.scope).not.toBe(b.scope);
  } finally {
    expect(await a.close()).toEqual({ confirmed: true });
    expect(await b.close()).toEqual({ confirmed: true });
  }
});

macTest(
  'rejected top-level await returns a real evaluation failure without destroying its VM',
  async () => {
    const executor = await fixture();
    expect(
      await executor.execute({
        code: 'await Promise.reject(Error("synthetic_failure"))',
        signal: signal(),
        call: async () => null,
      }),
    ).toMatchObject({ failure: { kind: 'evaluation', message: 'Error: synthetic_failure' } });
    expect(await executor.close()).toEqual({ confirmed: true });
  },
);

for (const [name, code, expected] of [
  ['missing browser method', 'await browser.help()', /TypeError:.*browser\.help/],
  [
    'rejected top-level await',
    'await Promise.reject(Object.assign(new TypeError("synthetic_rejected_await"), {privateDetail:"DIAGNOSTIC_PRIVATE_SENTINEL"}))',
    /TypeError:.*synthetic_rejected_await/,
  ],
  ['long UTF8 message', 'await Promise.reject(Error("雪".repeat(400)))', /Error:.*雪/],
  [
    'synchronous exception',
    'throw new ReferenceError("synthetic_sync_failure")',
    /ReferenceError:.*synthetic_sync_failure/,
  ],
  [
    'private stack',
    'await Promise.reject(Object.assign(Error("synthetic_stack_message"), {stack: "Error: synthetic_stack_message\\n    at DIAGNOSTIC_PRIVATE_SENTINEL"}))',
    /Error:.*synthetic_stack_message/,
  ],
  [
    'non-Error rejection',
    'await Promise.reject({privateDetail:"DIAGNOSTIC_PRIVATE_SENTINEL"})',
    /browser_executor_evaluation_failed/,
  ],
] as const)
  macTest(
    `packaged worker preserves a bounded safe diagnostic for ${name} and can be reused`,
    async () => {
      const executor = await fixture();
      let calls = 0;
      try {
        const result = await executor.execute({
          code,
          signal: signal(),
          call: async () => {
            calls++;
            return null;
          },
        });
        expect(result.failure?.kind).toBe('evaluation');
        const message = result.failure!.message;
        expect(message).toMatch(expected);
        expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(512);
        expect(message).not.toContain('\n');
        expect(message).not.toContain('DIAGNOSTIC_PRIVATE_SENTINEL');
        expect(message).not.toContain('computer-use:');
        expect(message).not.toContain('\u001b');
        expect(message).not.toContain('\ufffd');
        expect(calls).toBe(0);
        expect(
          await executor.execute({ code: '42', signal: signal(), call: async () => null }),
        ).toEqual({ value: 42, output: '' });
        expect(await executor.close()).toEqual({ confirmed: true });
      } finally {
        await executor.close();
      }
    },
  );

macTest('forged done cannot leave generated code running between batches', async () => {
  const executor = await fixture();
  try {
    expect(
      await executor.execute({
        code: 'process.stdout.write(JSON.stringify({type:"done",batch:1,pending:0,value:"forged"})+"\\n"); while(true){}',
        signal: signal(),
        call: async () => null,
      }),
    ).toMatchObject({ value: 'forged' });
    const budget = createExecutorCpuBudget(executor.readProcessEvidence().root!);
    try {
      expect(budget.isSuspended()).toBe(true);
      const before = budget.read();
      await sleepTimer(100);
      expect(budget.isSuspended()).toBe(true);
      // Kernel accounting may charge a few microseconds after SSTOP; a genuine
      // running dead loop would consume the whole interval.
      expect(budget.read() - before).toBeLessThan(1000000n);
    } finally {
      budget.close();
    }
    await expect(
      executor.execute({ code: '42', signal: signal(), timeoutMs: 100, call: async () => null }),
    ).rejects.toThrow('browser_executor_timeout');
    expect(await executor.close()).toEqual({ confirmed: true });
  } finally {
    await executor.close();
  }
});

macTest(
  'parent SIGKILL closes the private channel and original guardian kills sandbox dead loop',
  async () => {
    const source = join(root, 'parent-fixture.ts');
    writeFileSync(
      source,
      `import {createBrowserExecutor} from ${JSON.stringify(join(import.meta.dirname, '../../../src/tools/browser/executor/index.ts'))};
const executor=await createBrowserExecutor({scope:'parent-death',workerPath:${JSON.stringify(join(root, 'worker.mjs'))},guardianPath:${JSON.stringify(join(root, 'stdio-guardian.js'))}});
await executor.execute({code:'await browser.call("ready"); while(true){}',signal:new AbortController().signal,timeoutMs:30000,call:async()=>{console.log(JSON.stringify(executor.readProcessEvidence()));return null;}});`,
    );
    const parentBuilt = await buildBundle({
      entrypoints: [source],
      ...fixtureRuntimeBuild(root),
      outdir: root,
      naming: 'parent-fixture.js',
    });
    expect(parentBuilt.success).toBe(true);
    const child = spawnProcess([fixtureNodeExecutable(), parentBuilt.outputs[0]!.path], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      const reader = child.stdout.getReader();
      let bytes = '';
      while (!bytes.includes('\n')) {
        const read = await reader.read();
        if (read.done) throw Error('parent_fixture_ended_before_ready');
        bytes += new TextDecoder().decode(read.value);
      }
      reader.releaseLock();
      const evidence = JSON.parse(bytes.slice(0, bytes.indexOf('\n')));
      expect(evidence.phase).toBe('ready');
      child.kill('SIGKILL');
      await child.exited;
      const until = Date.now() + 4000;
      const identities = [evidence.broker, evidence.guardian, evidence.root];
      while (
        identities.some((identity) => ownedProcessKernelState(identity) !== 'absent') &&
        Date.now() < until
      )
        await sleepTimer(20);
      expect(identities.map((identity) => ownedProcessKernelState(identity))).toEqual([
        'absent',
        'absent',
        'absent',
      ]);
    } finally {
      child.kill('SIGKILL');
      await child.exited;
    }
  },
);

macTest(
  'Host-classified failure blocks caught and queued dependencies but retains the VM',
  async () => {
    const executor = await fixture();
    const refusal = Error('trusted_refusal');
    const seen: string[] = [];
    const call = async (method: string) => {
      seen.push(method);
      if (method === 'denied') throw refusal;
      return null;
    };
    try {
      const result = await executor.execute({
        code: 'var saved = 23; await Promise.allSettled([browser.call("denied"), browser.call("queued")]); try { await browser.call("caught"); } catch {} saved',
        signal: signal(),
        call,
        recoverableFailure: (error) =>
          error === refusal ? { message: 'trusted_refusal' } : undefined,
      });
      expect(result).toMatchObject({ failure: { kind: 'api', message: 'trusted_refusal' } });
      expect(seen).toEqual(['denied']);
      expect(
        await executor.execute({
          code: 'await browser.call("fresh"); saved',
          signal: signal(),
          call,
        }),
      ).toEqual({ value: 23, output: '' });
      expect(seen).toEqual(['denied', 'fresh']);
    } finally {
      expect(await executor.close()).toEqual({ confirmed: true });
    }
  },
);

for (const failed of [false, true])
  macTest(
    `sealed ${failed ? 'failed' : 'successful'} evaluation cannot attach old console or diagnostics to a new batch`,
    async () => {
      const executor = await fixture();
      const seen: string[] = [];
      const call = async (method: string) => {
        seen.push(method);
        return null;
      };
      try {
        await executor.execute({
          code:
            'var oldTimer = setTimeout(() => { console.log("OLD_OUTPUT"); throw new TypeError("OLD_DIAGNOSTIC"); }, 50); var oldPromise = new Promise(resolve => setTimeout(resolve, 70)).then(() => { console.log("OLD_PROMISE_OUTPUT"); throw Error("OLD_PROMISE_DIAGNOSTIC"); });' +
            (failed ? 'throw Error("original_evaluation")' : '7'),
          signal: signal(),
          call,
        });
        expect(
          await executor.execute({
            code: 'await new Promise(resolve => setTimeout(resolve, 140)); console.log("FRESH"); await browser.call("fresh")',
            signal: signal(),
            call,
          }),
        ).toEqual({ value: null, output: 'FRESH\n' });
        expect(seen).toEqual(['fresh']);
      } finally {
        expect(await executor.close()).toEqual({ confirmed: true });
      }
    },
  );

macTest(
  'forged idle done cannot settle a registered Host API or enable another batch',
  async () => {
    const executor = await fixture();
    try {
      await expect(
        executor.execute({
          code: 'browser.call("pending"); process.stdout.write(JSON.stringify({type:"done",batch:1,pending:0,error:"TypeError: forged"})+"\\n");',
          signal: signal(),
          call: async () => {
            await sleepTimer(60);
            return null;
          },
        }),
      ).rejects.toThrow('browser_executor_unawaited_calls');
      await expect(
        executor.execute({ code: '42', signal: signal(), call: async () => null }),
      ).rejects.toThrow('browser_executor_closed');
    } finally {
      expect(await executor.close()).toEqual({ confirmed: true });
    }
  },
);

macTest(
  'a saved Promise callback retains its sealed origin when resolved by a new batch',
  async () => {
    const executor = await fixture();
    const seen: string[] = [];
    const call = async (method: string) => {
      seen.push(method);
      return null;
    };
    try {
      await executor.execute({
        code: 'var release; var prior = new Promise(resolve => {release = resolve}).then(() => browser.call("late-promise")).catch(() => null); 7',
        signal: signal(),
        call,
      });
      expect(
        await executor.execute({
          code: 'release(); await prior; await browser.call("fresh")',
          signal: signal(),
          call,
        }),
      ).toEqual({ value: null, output: '' });
      expect(seen).toEqual(['fresh']);
    } finally {
      expect(await executor.close()).toEqual({ confirmed: true });
    }
  },
);

macTest(
  'a caught known API failure cannot disable the budget or leave a spinning VM reusable',
  async () => {
    const executor = await fixture();
    const known = Error('known_failure');
    try {
      await expect(
        executor.execute({
          code: 'try { await browser.call("known"); } catch {} while (true) {}',
          signal: signal(),
          timeoutMs: 100,
          call: async () => {
            throw known;
          },
          recoverableFailure: (error) =>
            error === known ? { message: 'known_failure' } : undefined,
        }),
      ).rejects.toThrow('browser_executor_timeout');
      await expect(
        executor.execute({ code: '42', signal: signal(), call: async () => null }),
      ).rejects.toThrow('browser_executor_closed');
    } finally {
      expect(await executor.close()).toEqual({ confirmed: true });
    }
  },
);
