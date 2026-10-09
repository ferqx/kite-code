import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentClient, ServerInfo } from '@kite-ai/client';
import { queryBranch } from '../electron/git';
import { NativeCaller } from '../electron/native-caller';
import { NativeProcessOwner } from '../electron/native-processes';

const owners = new Set<NativeProcessOwner>();
let draining = false;
function checkActive() {
  if (draining) throw Error('owned_node_draining');
}
function createOwner<T extends NativeProcessOwner>(create: () => T): T {
  checkActive();
  const owner = create();
  owners.add(owner);
  return owner;
}
let caller: NativeCaller | undefined;
let firstFailure: unknown;
let failed = false;
let cleanupFailure: unknown;
let cleanupFailed = false;
let cleanupPromise: Promise<void> | undefined;
function cleanup(): Promise<void> {
  draining = true;
  if (cleanupPromise) return cleanupPromise;
  const pending: Promise<void>[] = [];
  const errors: unknown[] = [];
  // Every owner seals synchronously before any cleanup await or serial continuation.
  for (const owner of owners) {
    try {
      pending.push(owner.close());
    } catch (error) {
      errors.push(error);
    }
  }
  if (caller) {
    try {
      pending.push(caller.close());
    } catch (error) {
      errors.push(error);
    }
  }
  cleanupPromise = Promise.allSettled(pending).then((results) => {
    for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
    if (errors.length) throw new AggregateError(errors, 'owned_node_cleanup_failed');
  });
  return cleanupPromise;
}
process.once('SIGTERM', () => {
  void cleanup().then(
    () => {
      process.exit(143);
    },
    (error: unknown) => {
      console.error(
        firstFailure === undefined
          ? error
          : new AggregateError([firstFailure, error], 'owned_node_failed_cleanup'),
      );
      process.exit(1);
    },
  );
});
try {
  const owner = createOwner(() => new NativeProcessOwner());
  const task = owner.start(
    process.execPath,
    [
      '-e',
      "process.stdout.write('OWNED_NODE_READY\\n');process.stderr.write('OWNED_NODE_STDERR\\n');setInterval(()=>{},1000)",
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
    { timeoutMs: 5000, timeoutError: 'fixture timeout', launchError: 'fixture launch' },
  );
  const terminal = task.result.catch((error: unknown) => error);
  const pid = task.child.pid;
  if (!pid || !task.child.stdout || !task.child.stderr) throw Error('owned_node_pipes_missing');
  let stdout = '',
    stderr = '',
    stdoutEOF = false,
    stderrEOF = false,
    closed = false,
    closePid = 0;
  task.child.stdout.on('data', (value: Buffer) => {
    stdout += value.toString('utf8');
  });
  task.child.stderr.on('data', (value: Buffer) => {
    stderr += value.toString('utf8');
  });
  task.child.stdout.once('end', () => {
    stdoutEOF = true;
  });
  task.child.stderr.once('end', () => {
    stderrEOF = true;
  });
  task.child.once('close', () => {
    closed = true;
    closePid = task.child.pid!;
  });
  await Promise.race([
    new Promise<void>((resolve) => {
      task.child.stderr!.once('data', () => resolve());
    }),
    task.result.then(() => {
      throw Error('owned_node_closed_before_ready');
    }),
  ]);
  await owner.close();
  const result = await terminal;
  if (!(result instanceof Error)) throw Error('owned_node_close_failure_missing');
  let admissionDenied = false;
  try {
    owner.start(
      process.execPath,
      [],
      {},
      { timeoutMs: 1, timeoutError: 'timeout', launchError: 'launch' },
    );
  } catch {
    admissionDenied = true;
  }
  let absent = false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    absent = (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
  const workspace = process.argv[2]!;
  mkdirSync(join(workspace, '.git'));
  const calls: { command: string; args: readonly string[]; timeoutMs: number }[] = [];
  const helperPids: number[] = [];
  let editorActualClosed = false;
  let editorReady!: () => void;
  const readyEditor = new Promise<void>((resolve) => {
    editorReady = resolve;
  });
  class RecordingOwner extends NativeProcessOwner {
    override start(...args: Parameters<NativeProcessOwner['start']>) {
      calls.push({ command: args[0], args: [...args[1]], timeoutMs: args[3].timeoutMs });
      return super.start(...args);
    }
  }
  const helpers = createOwner(
    () =>
      new RecordingOwner((command, args, options) => {
        let program: string;
        if (command === 'git') {
          const operation = args.slice(4).join(' ');
          const text =
            operation === 'rev-parse --show-toplevel'
              ? `${workspace}\n`
              : operation === 'symbolic-ref --quiet --short HEAD'
                ? 'main\n'
                : operation === 'rev-parse --verify HEAD'
                  ? `${'a'.repeat(40)}\n`
                  : operation === 'for-each-ref --format=%(refname:short) refs/heads'
                    ? 'main\n'
                    : operation === 'status --porcelain=v1 -z --untracked-files=all'
                      ? ''
                      : undefined;
          if (text === undefined) throw Error('unowned_git_command');
          program = `process.stdout.write(${JSON.stringify(text)});`;
        } else if (
          command === '/usr/bin/open' &&
          args.join('\0') ===
            ['-a', 'Visual Studio Code', '--', join(workspace, 'owned.txt')].join('\0')
        ) {
          program = "process.stdout.write('EDITOR_HELPER_READY\\n');setInterval(()=>{},1000)";
        } else throw Error('unowned_helper_command');
        // Keep the actual product command/options observed; substitute only this fixture's executable.
        const child = spawn(process.execPath, ['-e', program], {
          ...options,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (!child.pid) throw Error('helper_pid_missing');
        helperPids.push(child.pid);
        if (command === '/usr/bin/open') {
          child.stdout!.once('data', () => editorReady());
          child.once('close', () => {
            editorActualClosed = true;
          });
        }
        return child;
      }),
  );
  const branch = await queryBranch(workspace, helpers);
  checkActive();
  let networkDisposed = 0;
  const serverInfo: ServerInfo = {
    instanceId: 'owned-node',
    buildId: 'owned-node',
    apiMajor: 1,
    capabilities: [],
    profile: { dataRoot: workspace, name: 'owned-node', accessKey: 'owned-node' },
    dataAvailability: 'available',
    storeId: 'owned-node-store',
    subjectId: 'owned-node-user',
  };
  const readOnlyClient = new Proxy(
    {
      serverInfo,
      disposeNetwork() {
        networkDisposed++;
      },
    },
    {
      get(target, key, receiver) {
        if (!Reflect.has(target, key)) throw Error('unplanned_client_access');
        return Reflect.get(target, key, receiver);
      },
    },
  ) as unknown as AgentClient;
  caller = new NativeCaller(readOnlyClient, () => {}, undefined, [], undefined, helpers);
  let editorStopped = process.platform !== 'darwin';
  let callerWaitedForEditor = process.platform !== 'darwin';
  if (process.platform === 'darwin') {
    const opening = caller
      .openEditor('vscode', join(workspace, 'owned.txt'))
      .catch((error: unknown) => error);
    await Promise.race([
      readyEditor,
      opening.then((result) => {
        throw result instanceof Error ? result : Error('editor_closed_before_ready');
      }),
    ]);
    await caller.close();
    callerWaitedForEditor = editorActualClosed;
    editorStopped = (await opening) instanceof Error;
  } else await caller.close();
  const beforeClosedOpen = calls.length;
  let closedCallerDenied = false;
  try {
    await caller.openEditor('vscode', join(workspace, 'owned.txt'));
  } catch (error) {
    closedCallerDenied = error instanceof Error && error.message === 'native_draining';
  }
  const callsStableAfterClose = calls.length === beforeClosedOpen;
  const helpersAbsent = helperPids.every((original) => {
    try {
      process.kill(original, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  });
  console.log(
    JSON.stringify({
      actualNode: typeof Bun === 'undefined',
      pid,
      closePid,
      stdout,
      stderr,
      stdoutEOF,
      stderrEOF,
      closed,
      absent,
      admissionDenied,
      branch,
      calls,
      helpersAbsent,
      editorStopped,
      callerWaitedForEditor,
      closedCallerDenied,
      networkDisposed,
      callsStableAfterClose,
    }),
  );
} catch (error) {
  firstFailure = error;
  failed = true;
} finally {
  try {
    await cleanup();
  } catch (error) {
    cleanupFailure = error;
    cleanupFailed = true;
  }
}
if (cleanupFailed)
  throw new AggregateError(
    failed ? [firstFailure, cleanupFailure] : [cleanupFailure],
    'owned_node_failed_cleanup',
  );
if (failed) throw firstFailure;
