import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, win32 } from 'node:path';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { selectProfile } from '@kite-ai/agent/profile';
import { defaultWindowsPathSecurity, privateDirectory } from '@kite-ai/agent/windows-path-security';
import { verifyTerminalRuntimeBundle } from '@kite-ai/service/runtime-assets';
import {
  startWindowsOwnedChild,
  type WindowsOwnedChild,
  WindowsOwnedChildStartError,
} from '../../../packages/agent/src/platform/process/windows-owned-child';
import {
  packTerminalBundle,
  unpackTerminalBundle,
} from '../../../scripts/release/terminal-archive';
import {
  installTerminalBundle,
  rollbackTerminalBundle,
  uninstallTerminalBundle,
} from '../../../scripts/release/terminal-bundle';

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const samePath = (a: string, b: string) =>
  win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();
// The installed candidate's public Runtime owns both plain and sealed decoding.
// This external read-only host has no Model or publication binding.
export const WINDOWS_TERMINAL_CODE_READER = `
import {readFileSync} from 'node:fs';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
const [root,dataRoot,sessionId]=process.argv.slice(2);if(!root||!dataRoot||!sessionId)throw Error('reader_arguments');
const leaf=(name)=>pathToFileURL(join(root,'node_modules/@kite-ai/agent',name+'.js')).href;
const {acquireArtifactAccess}=await import(leaf('artifact-access'));const {selectProfile}=await import(leaf('profile'));const {openSqliteStore}=await import(leaf('sqlite'));const {getLoadedSqliteEngine}=await import(leaf('sqlite-engine'));const {createRuntime}=await import(leaf('index'));
const use=acquireArtifactAccess({root,mode:'shared'});let store,runtime,first;try{store=await openSqliteStore({dataRoot,profile:'default',mode:'readonly'});const profile=selectProfile({dataRoot,profile:'default'});
runtime=createRuntime({store,permissions:{async authorize(){throw Error('reader_dispatch_forbidden');}},artifacts:{async publish(){throw Error('reader_publication_forbidden');},async read(input){const ref=await store.getArtifactReference(input);if(!ref)throw Error('reader_reference_missing');return readFileSync(join(profile.profilePath,'blobs',ref.hash.slice(0,2),ref.hash));},async close(){}}});
const metadata=await store.getMetadata(),view=await store.getView(sessionId),messages=await store.listMessages(sessionId),executions=await store.listExecutions(sessionId);const commands=await Promise.all(view.runs.map(run=>store.getCommand(run.originCommandId)));const outputs=[];
for(const execution of executions.filter(e=>e.kind==='model')){const scope={expectedStoreId:metadata.storeId,sessionId,subjectId:'local-user',executionId:execution.id};const saved=await store.getModelOutputSnapshot(scope);if(!saved.complete)throw Error('complete_original_output_required');const result=await runtime.readModelOutput(scope);if(!result.output.complete)throw Error('complete_public_output_required');outputs.push({executionId:execution.id,saved,full:result.output,contentBytes:result.contentBytes});}
if(JSON.stringify(await store.getMetadata())!==JSON.stringify(metadata))throw Error('readonly_metadata_changed');console.log(JSON.stringify({metadata,session:view.session,runs:view.runs,messages,executions,commands,outputs,engine:getLoadedSqliteEngine()}));}catch(error){first=error;}try{if(runtime)await runtime.close();else await store?.close();}catch(error){first=first===undefined?error:new AggregateError([first,error],'reader_resource_close_failed');}if(first===undefined)use.release();else throw first;
`;
type Snapshot = {
  metadata: { storeId: string; lastChangeCursor: string };
  session: { id: string };
  runs: { id: string; originCommandId: string; status: string }[];
  messages: { id: string; role: string; content: string }[];
  executions: {
    id: string;
    runId: string;
    originStoreId: string;
    originCommandId: string;
    kind: string;
    status: string;
  }[];
  commands: { id: string; originStoreId: string; status: string }[];
  outputs: {
    executionId: string;
    saved: {
      complete: boolean;
      originStoreId: string;
      identity: { originCommandId: string };
      content: string;
      reasoning: string;
      toolCalls: unknown[];
      output: { contentBytes: string; head: { storeId: string; [key: string]: unknown } } | null;
    };
    full: { complete: boolean; content: string; reasoning: string; toolCalls: unknown[] };
    contentBytes: string;
  }[];
  engine: { version: string; sourceId: string };
};

/** Complete real-code CLI chain; both candidates are original builder outputs, never relabelled. */
export async function qualifyWindowsTerminalCrossVersion(input: {
  candidate: string;
  predecessor: string;
  predecessorCommit: string;
  wholeDeadline?: number;
}) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('windows_terminal_cross_version_platform_required');
  const started = performance.now(),
    deadline =
      started +
      Math.min(
        360000,
        input.wholeDeadline === undefined ? 360000 : input.wholeDeadline - Date.now(),
      );
  assert(Number.isFinite(deadline) && deadline > started);
  for (const path of [input.candidate, input.predecessor]) assert(isAbsolute(path));
  const currentInput = realpathSync(input.candidate),
    previousInput = realpathSync(input.predecessor);
  const current = verifyTerminalRuntimeBundle(currentInput),
    previous = verifyTerminalRuntimeBundle(previousInput);
  assert.equal(previous.manifest.source.commit, input.predecessorCommit);
  assert.equal(previous.manifest.source.dirty, false);
  assert.equal(current.manifest.source.dirty, false);
  assert(/^[a-f0-9]{40}$/.test(current.manifest.source.commit));
  assert.deepEqual(current.manifest.target, { platform: 'win32', arch: 'x64' });
  assert.deepEqual(previous.manifest.target, current.manifest.target);
  assert.notEqual(current.manifest.source.commit, previous.manifest.source.commit);
  assert.equal(current.manifest.productVersion, previous.manifest.productVersion);
  assert.notEqual(current.digest, previous.digest);
  const oldCode = new Map(previous.manifest.files.map((file) => [file.path, file.sha256]));
  const changedAgentCode = current.manifest.files.filter(
    (file) =>
      file.path.startsWith('node_modules/@kite-ai/agent/') &&
      file.path.endsWith('.js') &&
      oldCode.get(file.path) !== file.sha256,
  );
  assert(changedAgentCode.length > 0, 'actual_agent_code_change_required');
  const security = defaultWindowsPathSecurity()!;
  const root = join(realpathSync(tmpdir()), `kite-windows-terminal-code-${randomUUID()}`);
  assert(!existsSync(root));
  privateDirectory(root);
  const home = join(root, 'home'),
    workspace = join(root, 'workspace'),
    prefix = join(root, 'installed');
  privateDirectory(home);
  privateDirectory(workspace);
  const profile = selectProfile({
    dataRoot: join(home, '.kite-code', 'unified-agent'),
    profile: 'default',
  });
  privateDirectory(profile.profilePath);
  const cli = join(prefix, 'bin', 'kite.exe'),
    sessionId = 'windows-terminal-real-code';
  const tasks = [
    'Windows original A task',
    'Windows current B continuation',
    'Windows rollback A continuation',
  ];
  const bodies = [
    'ORIGINAL WINDOWS A BODY',
    `B CURRENT FULL BODY\n${'二代🙂\n'.repeat(32000)}B EXACT ORIGINAL TAIL`,
    'A AFTER ROLLBACK BODY',
  ];
  const owners = new Set<WindowsOwnedChild>();
  const records: Record<string, unknown>[] = [];
  const remaining = () => {
    const value = deadline - performance.now();
    assert(value > 0, 'windows_terminal_cross_version_deadline');
    return value;
  };
  const clean: Record<string, string> = {};
  const denied = new Set([
    'NODE_PATH',
    'NODE_OPTIONS',
    'BUN_OPTIONS',
    'BUN_BE_BUN',
    'ELECTRON_RUN_AS_NODE',
  ]);
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !denied.has(key.toUpperCase())) clean[key] = value;
  clean.HOME = home;
  clean.USERPROFILE = home;
  clean.LANG = 'C.UTF-8';
  const poison = join(workspace, 'poison.mjs'),
    poisonMarker = join(root, 'preload-ran');
  security.writePrivateFile(
    poison,
    Buffer.from(
      `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(poisonMarker)},'executed');throw Error('unexpected_preload');`,
    ),
  );
  security.writePrivateFile(
    join(workspace, 'bunfig.toml'),
    Buffer.from(`preload = [${JSON.stringify(poison)}]\n`),
  );
  const poisoned = {
    ...clean,
    NODE_PATH: workspace,
    NODE_OPTIONS: `--require ${JSON.stringify(poison)}`,
    BUN_OPTIONS: `--preload ${JSON.stringify(poison)}`,
    BUN_BE_BUN: '1',
    ELECTRON_RUN_AS_NODE: '1',
  };
  const within = async <T>(promise: Promise<T>, ms: number, phase: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error(`windows_terminal_code_command_timeout:${phase}`)),
            ms,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const begin = async (phase: string, executable: string, argv: string[], frontdoor = true) => {
    const commandEnd = performance.now() + Math.min(30000, remaining());
    const commandRemaining = () => {
      const value = Math.min(commandEnd - performance.now(), remaining());
      assert(value > 0, `${phase}_command_deadline`);
      return Math.ceil(value);
    };
    let owner: WindowsOwnedChild;
    try {
      owner = startWindowsOwnedChild({
        executable,
        argv,
        cwd: workspace,
        env: frontdoor ? poisoned : clean,
        stdin: 'ignore',
      });
    } catch (error) {
      if (error instanceof WindowsOwnedChildStartError) {
        try {
          await within(error.cleanup, Math.min(5000, commandRemaining()), `${phase}_start_cleanup`);
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'windows_terminal_code_start_cleanup_unknown');
        }
      }
      throw error;
    }
    owners.add(owner);
    const read = async (stream: AsyncIterable<Uint8Array>, maximum: number) => {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of stream) {
        bytes += chunk.length;
        assert(bytes <= maximum, `${phase}_output_limit`);
        chunks.push(chunk);
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    };
    const stdout = read(owner.stdout, 8 * 1024 * 1024),
      stderr = read(owner.stderr, 65536);
    void stdout.catch(() => {});
    void stderr.catch(() => {});
    const completion = (async () => {
      let first: unknown;
      try {
        const result = await within(
          Promise.all([owner.exited, stdout, stderr]),
          commandRemaining(),
          phase,
        );
        assert.equal(result[0], 0, `${phase}:${result[2]}`);
        const stopped = await within(
          owner.stop({ graceMs: 0 }),
          Math.min(5000, commandRemaining()),
          `${phase}_natural_exit`,
        );
        assert(stopped.root.waitConfirmed && stopped.job.treeStopped);
        assert.equal(stopped.root.exitCode, 0);
        assert.equal(stopped.job.activeProcesses, 0);
        assert.equal(stopped.job.terminationRequested, false);
        await within(owner.close(), Math.min(5000, commandRemaining()), `${phase}_close`);
        const evidence = owner.readEvidence();
        assert(
          evidence.closed &&
            !evidence.closeUnknown &&
            evidence.root.waitConfirmed &&
            evidence.job.treeStopped,
        );
        assert.equal(evidence.job.activeProcesses, 0);
        assert.equal(evidence.job.terminationRequested, false);
        assert(!existsSync(poisonMarker));
        remaining();
        records.push({
          phase,
          code: result[0],
          stdoutBytes: Buffer.byteLength(result[1]),
          stderrBytes: Buffer.byteLength(result[2]),
          stdoutEOF: true,
          stderrEOF: true,
          naturalJob: evidence,
        });
        owners.delete(owner);
        return { stdout: result[1], stderr: result[2] };
      } catch (error) {
        first = error;
      }
      if (owner.readEvidence().closeUnknown) throw first;
      try {
        await within(
          (async () => {
            await owner.stop({ graceMs: 0 });
            await owner.close();
          })(),
          Math.max(1, Math.min(5000, deadline - performance.now())),
          `${phase}_failure_cleanup`,
        );
        owners.delete(owner);
      } catch (cleanup) {
        throw new AggregateError([first, cleanup], 'windows_terminal_code_command_cleanup_failed');
      }
      throw first;
    })();
    void completion.catch(() => {});
    return { owner, completion };
  };
  const execute = async (phase: string, executable: string, argv: string[], frontdoor = true) =>
    await (await begin(phase, executable, argv, frontdoor)).completion;
  const leases = (roots: readonly string[], busy: boolean) => {
    for (const selected of roots) {
      if (busy) {
        let unexpected: ReturnType<typeof acquireArtifactAccess> | undefined;
        try {
          assert.throws(() => {
            unexpected = acquireArtifactAccess({ root: selected, mode: 'exclusive' });
          }, /busy|in.use/i);
        } finally {
          unexpected?.release();
        }
      } else {
        const exclusive = acquireArtifactAccess({ root: selected, mode: 'exclusive' });
        exclusive.release();
      }
    }
  };
  let announce!: () => void, release!: () => void;
  const admitted = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requestFacts: { task: string; contextHasA: boolean; contextHasB: boolean }[] = [];
  const providerErrors: unknown[] = [];
  const text = (value: unknown): string =>
    typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? value.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
        : '';
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      try {
        const body = (await request.json()) as { messages: { role: string; content: unknown }[] };
        const task = text(
            body.messages.filter((message) => message.role === 'user').at(-1)?.content,
          ),
          index = tasks.indexOf(task);
        assert.equal(index, requestFacts.length);
        assert(index >= 0);
        const fact = {
          task,
          contextHasA: body.messages.some((message) => text(message.content) === bodies[0]),
          contextHasB: body.messages.some((message) => text(message.content) === bodies[1]),
        };
        if (index === 1) assert(fact.contextHasA, 'B_actual_request_must_include_original_A');
        if (index === 2)
          assert(fact.contextHasB, 'rollback_A_actual_request_must_include_complete_B');
        requestFacts.push(fact);
        if (index === 0) {
          announce();
          await held;
        }
        const frame = (delta: unknown, reason: string | null) =>
          `data: ${JSON.stringify({ id: `windows-code-${index}`, object: 'chat.completion.chunk', model: 'fixed', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
        let response = '';
        for (let offset = 0; offset < bodies[index]!.length; ) {
          let end = Math.min(offset + 16000, bodies[index]!.length);
          if (end < bodies[index]!.length && /^[\uD800-\uDBFF]$/.test(bodies[index]![end - 1]!))
            end++;
          response += frame({ content: bodies[index]!.slice(offset, end) }, null);
          offset = end;
        }
        response += `${frame({}, 'stop')}data: [DONE]\n\n`;
        return new Response(response, { headers: { 'content-type': 'text/event-stream' } });
      } catch (error) {
        providerErrors.push(error);
        return new Response('unexpected original work', { status: 500 });
      }
    },
  });
  const configPath = join(profile.profilePath, 'config.jsonc');
  security.writePrivateFile(
    configPath,
    Buffer.from(
      JSON.stringify({
        modelId: 'fixed',
        tools: [],
        models: [
          {
            id: 'fixed',
            provider: 'compatible',
            model: 'fixed',
            baseURL: `${provider.url.href}v1`,
          },
        ],
      }),
    ),
  );
  const configBytes = readFileSync(configPath);
  let firstError: unknown,
    completed = false;
  try {
    const candidates = [];
    for (const [name, source, expected] of [
      ['A', previousInput, previous],
      ['B', currentInput, current],
    ] as const) {
      const copy = join(root, `input-${name}`);
      cpSync(source, copy, { recursive: true, dereference: false, verbatimSymlinks: true });
      const archive = await packTerminalBundle({
        bundleRoot: copy,
        archivePath: join(root, `${name}.tar.gz`),
      });
      const relocated = await unpackTerminalBundle({
        archivePath: archive.archivePath,
        sha256: archive.sha256,
        destination: join(root, `relocated-${name}`),
      });
      assert.equal(relocated.candidateId, expected.digest);
      rmSync(copy, { recursive: true });
      assert(!existsSync(copy));
      candidates.push(relocated);
      remaining();
    }
    const a = candidates[0]!,
      b = candidates[1]!;
    const installedA = installTerminalBundle({ bundleRoot: a.root, prefix });
    const commandIds: string[] = [],
      executionIds: string[] = [],
      snapshots: Snapshot[] = [];
    const reader = join(home, 'installed-code-reader.mjs');
    security.writePrivateFile(reader, Buffer.from(WINDOWS_TERMINAL_CODE_READER));
    const read = async (phase: string, releaseRoot: string, candidate: typeof a) => {
      const runtime = join(releaseRoot, candidate.manifest.entries.runtime);
      const result = await execute(
        phase,
        runtime,
        [
          '--no-env-file',
          '--config',
          join(win32.dirname(runtime), 'windows-bunfig.toml'),
          '--tsconfig-override',
          join(win32.dirname(runtime), 'windows-tsconfig.json'),
          reader,
          releaseRoot,
          profile.dataRoot,
          sessionId,
        ],
        false,
      );
      const snapshot = JSON.parse(result.stdout) as Snapshot;
      assert.equal(snapshot.session.id, sessionId);
      assert.equal(snapshot.engine.version, candidate.manifest.sqlite.version);
      assert.equal(snapshot.engine.sourceId, candidate.manifest.sqlite.sourceId);
      assert.equal(snapshot.runs.length, commandIds.length);
      assert.equal(snapshot.outputs.length, commandIds.length);
      assert(snapshot.runs.every((run) => run.status === 'completed'));
      assert.deepEqual(
        new Set(snapshot.commands.map((command) => command.id)),
        new Set(commandIds),
      );
      assert(
        snapshot.commands.every(
          (command) =>
            command.status === 'applied' && command.originStoreId === snapshot.metadata.storeId,
        ),
      );
      for (const [index, executionId] of executionIds.entries()) {
        const output = snapshot.outputs.find((value) => value.executionId === executionId);
        assert(output);
        const execution = snapshot.executions.find((value) => value.id === executionId);
        assert(execution);
        assert.equal(execution.kind, 'model');
        assert.equal(execution.status, 'succeeded');
        assert.equal(execution.originCommandId, commandIds[index]);
        assert.equal(execution.originStoreId, snapshot.metadata.storeId);
        assert(output.saved.complete);
        assert.equal(output.saved.originStoreId, snapshot.metadata.storeId);
        assert.equal(output.saved.identity.originCommandId, commandIds[index]);
        if (output.saved.output) {
          assert.equal(output.saved.output.head.storeId, snapshot.metadata.storeId);
          assert.equal(output.saved.output.contentBytes, String(Buffer.byteLength(bodies[index]!)));
        } else {
          assert.equal(output.saved.content, bodies[index]);
          assert.equal(output.saved.reasoning, output.full.reasoning);
          assert.deepEqual(output.saved.toolCalls, output.full.toolCalls);
        }
        if (index === 1) assert(output.saved.output, 'B_sealed_long_output_required');
        assert(output.full.complete);
        assert.equal(output.full.content, bodies[index]);
        assert.equal(hash(output.full.content), hash(bodies[index]!));
        assert.equal(output.contentBytes, String(Buffer.byteLength(bodies[index]!)));
      }
      if (snapshots.length) {
        const prior = snapshots.at(-1)!;
        assert.equal(snapshot.metadata.storeId, prior.metadata.storeId);
        for (const command of prior.commands)
          assert.deepEqual(
            snapshot.commands.find((value) => value.id === command.id),
            command,
          );
        for (const message of prior.messages)
          assert.deepEqual(
            snapshot.messages.find((value) => value.id === message.id),
            message,
          );
        for (const execution of prior.executions)
          assert.deepEqual(
            snapshot.executions.find((value) => value.id === execution.id),
            execution,
          );
        for (const original of prior.outputs) {
          const output = snapshot.outputs.find(
            (value) => value.executionId === original.executionId,
          );
          assert(output);
          assert.deepEqual(output.full, original.full);
          assert.deepEqual(output.saved.output, original.saved.output);
          assert.equal(output.saved.originStoreId, original.saved.originStoreId);
        }
      }
      assert.equal(requestFacts.length, commandIds.length);
      assert.equal(providerErrors.length, 0);
      return snapshot;
    };
    const argv = (index: number) => [
      'run',
      '--thread',
      sessionId,
      '--task',
      tasks[index]!,
      '--workspace',
      workspace,
      '--trust-workspace',
      '--full',
    ];
    const accept = (index: number, stdout: string) => {
      const intent = /^work intent (\{.*\})$/m.exec(stdout);
      assert(intent);
      const parsed = JSON.parse(intent[1]!) as {
        storeId: string;
        sessionId: string;
        commandId: string;
      };
      assert.equal(parsed.sessionId, sessionId);
      assert(!commandIds.includes(parsed.commandId));
      const answers = stdout.split('\n').filter((line) => line.startsWith('answer '));
      assert.equal(answers.length, 1);
      const answer = JSON.parse(answers[0]!.slice(7)) as {
        storeId: string;
        sessionId: string;
        commandId: string;
        executionId: string;
        complete: boolean;
        content: string;
      };
      assert.equal(answer.storeId, parsed.storeId);
      assert.equal(answer.sessionId, sessionId);
      assert.equal(answer.commandId, parsed.commandId);
      assert.equal(answer.complete, true);
      assert.equal(answer.content, bodies[index]);
      assert.equal(hash(answer.content), hash(bodies[index]!));
      assert(!executionIds.includes(answer.executionId));
      commandIds.push(parsed.commandId);
      executionIds.push(answer.executionId);
    };
    const runA = await begin('original_A_held_task', cli, argv(0));
    let admissionTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        admitted,
        runA.completion.then(() => {
          throw Error('A_exited_before_admission');
        }),
        new Promise<never>((_, reject) => {
          admissionTimer = setTimeout(
            () => reject(Error('A_admission_timeout')),
            Math.min(10000, remaining()),
          );
        }),
      ]);
    } finally {
      clearTimeout(admissionTimer);
    }
    const members = runA.owner.retainMembers();
    const verifier = members.filter((member) =>
      samePath(member.executablePath, join(prefix, 'bin', 'terminal-verifier.exe')),
    );
    const runtimePath = join(installedA.releaseRoot, a.manifest.entries.runtime);
    const cliMembers = members.filter(
      (member) =>
        samePath(member.executablePath, runtimePath) &&
        verifier.some(
          (parent) =>
            member.parentPid === parent.pid &&
            BigInt(member.creationTime) >= BigInt(parent.creationTime),
        ),
    );
    const services = members.filter(
      (member) =>
        samePath(member.executablePath, runtimePath) &&
        cliMembers.some(
          (parent) =>
            member.parentPid === parent.pid &&
            BigInt(member.creationTime) >= BigInt(parent.creationTime),
        ),
    );
    assert.equal(cliMembers.length, 1);
    assert.equal(services.length, 1);
    for (const member of [...verifier, ...cliMembers, ...services])
      assert.equal(member.inspect(), 'alive');
    leases([installedA.releaseRoot], true);
    assert.throws(() => uninstallTerminalBundle(prefix), /busy|in.use/i);
    const installedB = installTerminalBundle({ bundleRoot: b.root, prefix });
    assert.equal(installedB.previousCandidateId, a.candidateId);
    assert.equal(readFileSync(join(prefix, 'active'), 'utf8').split('\n')[0], b.candidateId);
    for (const member of [...cliMembers, ...services]) assert.equal(member.inspect(), 'alive');
    leases([installedA.releaseRoot], true);
    leases([installedB.releaseRoot], false);
    records.push({
      phase: 'A_fixed_after_real_B_selection',
      members: members.map(({ pid, parentPid, creationTime, executablePath }) => ({
        pid,
        parentPid,
        creationTime,
        executablePath,
      })),
    });
    release();
    accept(0, (await runA.completion).stdout);
    leases([installedA.releaseRoot, installedB.releaseRoot], false);
    snapshots.push(await read('B_cold_original_A', installedB.releaseRoot, b));
    const cold = async (phase: string, releaseRoot: string, candidate: typeof a) => {
      const before = await read(`${phase}_before`, releaseRoot, candidate);
      const result = await execute(phase, cli, [
        'context',
        'read',
        sessionId,
        '--input',
        JSON.stringify({ storeId: before.metadata.storeId }),
        '--workspace',
        workspace,
      ]);
      const context = JSON.parse(result.stdout) as {
        selection: { sessionId: string };
        messages: { id: string }[];
      };
      assert.equal(context.selection.sessionId, sessionId);
      assert.deepEqual(
        new Set(context.messages.map((message) => message.id)),
        new Set(before.messages.map((message) => message.id)),
      );
      const after = await read(`${phase}_after`, releaseRoot, candidate);
      assert.deepEqual(after, before);
      leases([installedA.releaseRoot, installedB.releaseRoot], false);
      assert.equal(requestFacts.length, commandIds.length);
      return after;
    };
    await cold('B_formal_cold_before_new_task', installedB.releaseRoot, b);
    accept(1, (await execute('B_actual_continuation', cli, argv(1))).stdout);
    snapshots.push(await read('B_complete_history', installedB.releaseRoot, b));
    const beforeRollback = readFileSync(profile.databasePath),
      rollback = rollbackTerminalBundle(prefix);
    assert.equal(rollback.candidateId, a.candidateId);
    assert.equal(rollback.previousCandidateId, b.candidateId);
    assert.deepEqual(readFileSync(profile.databasePath), beforeRollback);
    await cold('rollback_A_formal_cold_B_full_body', installedA.releaseRoot, a);
    accept(2, (await execute('rollback_A_actual_continuation', cli, argv(2))).stdout);
    snapshots.push(await read('rollback_A_complete_history', installedA.releaseRoot, a));
    assert.equal(rollbackTerminalBundle(prefix).candidateId, b.candidateId);
    const final = await cold('final_B_formal_cold_all_history', installedB.releaseRoot, b);
    assert.equal(requestFacts.length, 3);
    assert.equal(new Set(final.runs.map((run) => run.id)).size, 3);
    leases([installedA.releaseRoot, installedB.releaseRoot], false);
    const database = readFileSync(profile.databasePath);
    assert.deepEqual(readFileSync(configPath), configBytes);
    uninstallTerminalBundle(prefix);
    assert(!existsSync(prefix));
    assert.deepEqual(readFileSync(profile.databasePath), database);
    assert.deepEqual(readFileSync(configPath), configBytes);
    assert.equal(verifyTerminalRuntimeBundle(currentInput).digest, current.digest);
    assert.equal(verifyTerminalRuntimeBundle(previousInput).digest, previous.digest);
    const evidence = {
      crossCodeQualified: true,
      localUnpublishedComparison: true,
      previousSource: previous.manifest.source,
      currentSource: current.manifest.source,
      candidates: [a.candidateId, b.candidateId],
      changedAgentCode,
      storeId: final.metadata.storeId,
      commandIds,
      executionIds,
      fullBodyBytes: Buffer.byteLength(bodies[1]!),
      fullBodyHash: hash(bodies[1]!),
      requests: requestFacts,
      records,
      databaseBytesRetained: true,
      dataRestored: false,
      budgetMs: 360000,
    };
    remaining();
    console.log(`WINDOWS_TERMINAL_REAL_CODE_COMPATIBILITY ${JSON.stringify(evidence)}`);
    completed = true;
  } catch (error) {
    firstError = error;
  }
  release();
  const cleanupErrors: unknown[] = [];
  for (const owner of owners) {
    if (owner.readEvidence().closeUnknown) {
      cleanupErrors.push(Error('windows_terminal_code_original_close_unknown'));
      continue;
    }
    try {
      await within(
        (async () => {
          await owner.stop({ graceMs: 0 });
          await owner.close();
        })(),
        Math.max(1, Math.min(5000, deadline - performance.now())),
        'whole_cleanup',
      );
      owners.delete(owner);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    provider.stop(true);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (performance.now() > deadline)
    cleanupErrors.push(Error('windows_terminal_code_whole_deadline'));
  if (firstError !== undefined || cleanupErrors.length) {
    console.error(`OWNED_WINDOWS_TERMINAL_CODE_FAILURE_ROOT ${root}`);
    throw cleanupErrors.length
      ? new AggregateError(
          firstError === undefined ? cleanupErrors : [firstError, ...cleanupErrors],
          'windows_terminal_code_qualification_failed',
        )
      : firstError;
  }
  assert(completed);
  return {
    root,
    previousCandidate: previous.digest,
    currentCandidate: current.digest,
    sourceCommit: current.manifest.source.commit,
    budgetMs: 360000,
  };
}
