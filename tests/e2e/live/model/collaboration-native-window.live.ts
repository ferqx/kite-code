import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { createCredentialVault, createOsCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { initializeSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { verifyNativeRuntimeBundle } from '@kite-ai/service/native-runtime-assets';
import { buildNativeCandidate } from '../../../../apps/desktop/scripts/build-native';
import { cleanupOwnedNativeCandidate } from '../../../../apps/desktop/test/owned-native-cleanup.fixture';
import {
  createUserConfiguration,
  parseModelPreset,
} from '../../../../apps/service/src/configuration';
import { ordinaryHostConfigurationDefaults } from '../../../../apps/service/src/configuration-defaults';
import { buildTerminalBundle } from '../../../../scripts/release/terminal-bundle';
import { liveCodeEvidence } from './live-code-evidence';

type Row = Record<string, string | number | null>;
function check(value: unknown, code: string): asserts value {
  if (!value) throw Error(code);
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const parse = (value: string | number | null | undefined) =>
  object(JSON.parse(String(value ?? '{}')));

/** Explicit paid test artifact. Business entry and both answers use the ordinary window. */
export async function runLiveNativeWindow(options: {
  output: string;
  evidenceRoot?: string;
  requestLimit?: number;
}) {
  check(process.platform === 'darwin', 'native_window_platform_unavailable');
  check(isAbsolute(options.output), 'native_window_output_invalid');
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const codeEvidence = liveCodeEvidence();
  const requestLimit = options.requestLimit ?? 40;
  check(
    Number.isSafeInteger(requestLimit) && requestLimit > 0 && requestLimit <= 40,
    'native_window_budget_invalid',
  );
  const root = options.evidenceRoot ?? `${options.output}.workspace`;
  check(
    isAbsolute(root) && !existsSync(root) && !existsSync(options.output),
    'native_window_evidence_exists',
  );
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const home = join(root, 'home'),
    workspace = join(home, 'workspace'),
    candidate = join(root, 'candidate');
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const profile = selectProfile({
    dataRoot: join(home, '.kite-code/unified-agent'),
    profile: 'default',
  });
  const targetA = join(root, 'external-A.txt'),
    targetB = join(root, 'external-B.txt'),
    targetC = join(root, 'external-A-followup.txt');
  const contentA = `approved-${crypto.randomUUID()}\n`,
    contentB = `denied-${crypto.randomUUID()}\n`,
    contentC = `followup-${crypto.randomUUID()}\n`;
  const prompt = `New task: this is a synthetic two-child approval test. Use spawn_agent exactly twice, with worker/default children. Child A must make exactly one write_user_file call: path ${JSON.stringify(targetA)}, content ${JSON.stringify(contentA)}, base null. Child B must make exactly one write_user_file call: path ${JSON.stringify(targetB)}, content ${JSON.stringify(contentB)}, base null. Put each instruction only in its own child prompt. Neither parent nor child may create any other child or file, run shell, ask questions, retry a denied action, or use any other mutation. After creating BOTH children, keep the parent waiting using wait_agent_events on both accurate agent IDs with timeout_ms 30000; continue waiting until both are terminal, then summarize their real outcomes. Each child must stop after its one write attempt, whether approved or denied. A human will answer each exact child approval in the ordinary window. These two paths are explicitly authorized synthetic targets outside this workspace; do not weaken the current permission mode.`;
  const followupChildInstruction = `You are the same original collaborator in a new round. Do not delegate or create another child. Make exactly one write_user_file call: path ${JSON.stringify(targetC)}, content ${JSON.stringify(contentC)}, base null. Stop after that one attempt. This is a new external target and needs its own fresh human approval; previous approvals do not authorize it.`;
  const checks: Record<string, boolean | number> = {};
  const wire: {
    attempt: number;
    status: number;
    toolCount: number;
    usage: null;
    startedOffsetMs: number;
    responseHeadersMs: number | null;
  }[] = [];
  const modelMetadata: Record<string, unknown> = {};
  let buildMetadata: Record<string, unknown> | null = null;
  let canonicalUsage: Record<string, number | null>[] | null = null;
  const deadline = AbortSignal.timeout(600000);
  const leases: ReturnType<typeof acquireArtifactAccess>[] = [];
  let proxy: ReturnType<typeof Bun.serve> | undefined;
  let driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let seedStore: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let stage = 'configuration',
    failure = false,
    cleanupSucceeded = true,
    budgetReached = false;
  let completed = false;
  let failureCode = '',
    cleanupCode = '';
  const safeCode = (error: unknown) => {
    const code = object(error).code;
    if (typeof code === 'string' && ['EACCES', 'EPERM', 'EADDRINUSE', 'ENOENT'].includes(code))
      return code;
    const message = error instanceof Error ? error.message : '';
    return /^(native_window_|credential_|model_|configuration_|os_credential_)[a-z0-9_]{1,65}$/.test(
      message,
    )
      ? message
      : error instanceof Error
        ? error.name
        : 'unknown_error';
  };
  let driverReceipt: {
    passed?: boolean;
    stage?: string;
    checks?: Record<string, boolean | number>;
  } = {};
  try {
    // Secrets stay in this process. The isolated user's configuration only contains a loopback route.
    stage = 'configuration_create';
    const configuration = createUserConfiguration();
    stage = 'configuration_read';
    const settings = configuration.read().value;
    stage = 'configuration_select';
    const selected = (Array.isArray(settings.models) ? settings.models : []).find(
      (model) =>
        model &&
        typeof model === 'object' &&
        !Array.isArray(model) &&
        model.id === settings.modelId,
    );
    check(
      selected &&
        typeof selected === 'object' &&
        !Array.isArray(selected) &&
        selected.enabled !== false,
      'native_window_default_missing',
    );
    check(
      typeof selected.model === 'string' && typeof selected.baseURL === 'string',
      'native_window_model_invalid',
    );
    const protocol = selected.protocol ?? 'chat-completions';
    check(
      protocol === 'chat-completions' || protocol === 'responses',
      'native_window_protocol_invalid',
    );
    const preset = parseModelPreset(selected.options);
    Object.assign(modelMetadata, {
      provider: selected.provider,
      model: selected.model,
      protocol,
      preset: { ...preset, maxOutputTokens: Math.min(preset.maxOutputTokens ?? 4096, 4096) },
    });
    stage = 'credential_backend';
    const vault = createCredentialVault({
      backend: createOsCredentialBackend({
        service: 'kite-agent',
        accountNamespace: 'user-models',
      }),
    });
    stage = 'credential_resolve';
    const apiKey =
      typeof selected.credentialRef === 'string'
        ? (configuration.resolveCredential(selected.credentialRef) ??
          (await vault.resolve(selected.credentialRef)))
        : undefined;
    stage = 'proxy';
    const upstream = selected.baseURL.replace(/\/$/, '');
    const controlToken = crypto.randomUUID();
    let storeId = '';
    function snapshot() {
      const db = new Database(profile.databasePath, { readonly: true });
      try {
        const rows = (sql: string, ...args: (string | number)[]) =>
          db.query<Row, (string | number)[]>(sql).all(...args);
        const allCarriers = rows(
          "SELECT * FROM execution WHERE session_id='native-root' AND child_session_id IS NOT NULL ORDER BY rowid",
        );
        const allCards = rows(
          "SELECT * FROM interaction WHERE presentation_session_id='native-root' AND kind='approval' AND definition_id='files.write_path' ORDER BY id",
        );
        const carriers = allCarriers.slice(0, 2);
        const cards = allCards.filter((card) =>
          [targetA, targetB].includes(String(object(parse(card.request_json).input).path)),
        );
        const followupCard = allCards.find(
          (card) => object(parse(card.request_json).input).path === targetC,
        );
        const originalA = cards.find(
          (card) => object(parse(card.request_json).input).path === targetA,
        );
        const originalCarrier = carriers.find(
          (carrier) => carrier.child_session_id === originalA?.session_id,
        );
        const approvals = cards.flatMap((card) => {
          const input = object(parse(card.request_json).input);
          const label = input.path === targetA ? 'A' : input.path === targetB ? 'B' : undefined;
          return label ? [{ id: String(card.id), label, pending: card.state === 'pending' }] : [];
        });
        const runs = rows('SELECT * FROM run');
        const allTools = rows(
          "SELECT * FROM execution WHERE kind='tool' AND adapter_id='files.write_path'",
        );
        const tools = allTools.filter((tool) =>
          [targetA, targetB].includes(String(parse(tool.intent_json).path)),
        );
        const followupTool = allTools.find((tool) => parse(tool.intent_json).path === targetC);
        const successor = allCarriers.find(
          (carrier) =>
            carrier.child_session_id === originalA?.session_id &&
            parse(carrier.reference_json).runId === followupCard?.run_id,
        );
        const delegationCard = rows(
          "SELECT * FROM interaction WHERE presentation_session_id='native-root' AND kind='approval' AND definition_id='task.follow_up' ORDER BY rowid",
        ).find((card) => {
          const input = object(parse(card.request_json).input);
          return (
            input.agentId === originalA?.session_id &&
            typeof input.content === 'string' &&
            input.content.includes(targetC)
          );
        });
        const delegationTool = delegationCard
          ? rows('SELECT * FROM execution WHERE id=?', String(delegationCard.execution_id))[0]
          : undefined;
        const originalChildRun = runs.find((run) => run.id === originalA?.run_id);
        const followupChildRun = runs.find((run) => run.id === followupCard?.run_id);
        const exactLineage =
          carriers.length === 2 &&
          new Set(carriers.map((entry) => entry.child_session_id)).size === 2 &&
          cards.length === 2 &&
          cards.every(
            (card) =>
              carriers.some((carrier) => carrier.child_session_id === card.session_id) &&
              tools.some(
                (tool) =>
                  tool.id === card.execution_id &&
                  tool.session_id === card.session_id &&
                  tool.run_id === card.run_id,
              ) &&
              card.origin_store_id === storeId &&
              card.presentation_session_id === 'native-root',
          );
        const exactAnswers =
          cards.length === 2 &&
          cards.every((card) => {
            const input = object(parse(card.request_json).input),
              answer = parse(card.answer_json);
            return input.path === targetA
              ? card.state === 'answered' &&
                  card.accepted_decision_revision !== null &&
                  answer.decision === 'approve'
              : input.path === targetB &&
                  card.state === 'cancelled' &&
                  answer.decision === 'deny' &&
                  card.accepted_decision_revision === null &&
                  runs.some(
                    (run) =>
                      run.id === card.run_id &&
                      run.session_id === card.session_id &&
                      run.status === 'cancelled' &&
                      run.reason === 'approval_denied',
                  );
          });
        const exactDispatch =
          tools.length === 2 &&
          tools.every((tool) => {
            const input = parse(tool.intent_json),
              result = parse(tool.result_json);
            return input.path === targetA
              ? tool.state === 'succeeded' && tool.dispatched === 1
              : input.path === targetB &&
                  tool.state === 'failed' &&
                  tool.dispatched === 0 &&
                  result.content === 'approval_denied' &&
                  object(result.details).adapterAttempted === false &&
                  object(result.details).dispatchCommitted === false;
          });
        const mode = rows(
          "SELECT safe_request_json FROM host_mutation WHERE kind='permission.mode' AND state='applied' AND scope='session:native-root' ORDER BY rowid DESC LIMIT 1",
        )[0];
        return {
          approvals,
          delegationApproval: {
            id: delegationCard?.id ?? null,
            agentId: originalA?.session_id ?? null,
            pending: delegationCard?.state === 'pending',
            exactLineage:
              !!delegationCard &&
              !!delegationTool &&
              !!originalCarrier &&
              delegationCard.origin_store_id === storeId &&
              delegationCard.session_id === 'native-root' &&
              delegationCard.presentation_session_id === 'native-root' &&
              delegationCard.run_id === delegationTool.run_id &&
              delegationTool.session_id === 'native-root' &&
              delegationTool.root_work_command_id === originalCarrier.root_work_command_id &&
              parse(delegationTool.intent_json).agentId === originalA?.session_id &&
              parse(delegationTool.intent_json).content ===
                object(parse(delegationCard.request_json).input).content,
            answered:
              delegationCard?.state === 'answered' &&
              delegationCard.accepted_decision_revision !== null &&
              parse(delegationCard.answer_json).decision === 'approve' &&
              parse(delegationCard.answer_json).grant === 'approve_once',
            dispatched: delegationTool?.state === 'succeeded' && delegationTool.dispatched === 1,
          },
          followupInputUnresolved: rows(
            "SELECT receipt_json FROM command WHERE session_id='native-root' AND kind='run.start' AND status='accepted'",
          ).some((command) => parse(command.receipt_json).outcome === 'human_input_unresolved'),
          originalMetadata: [
            ...carriers.map((carrier) => ({
              kind: 'carrier',
              id: carrier.id,
              sessionId: carrier.session_id,
              childSessionId: carrier.child_session_id,
              parentExecutionId: carrier.parent_execution_id,
              rootWorkCommandId: carrier.root_work_command_id,
              rootWorkSeq: carrier.root_work_seq,
              reference: carrier.reference_json,
              configuration: carrier.child_configuration_json,
            })),
            ...cards.map((card) => ({
              id: card.id,
              sessionId: card.session_id,
              runId: card.run_id,
              executionId: card.execution_id,
              request: card.request_json,
              answer: card.answer_json,
              state: card.state,
              acceptedDecisionRevision: card.accepted_decision_revision,
            })),
          ],
          followup: {
            id: followupCard?.id ?? null,
            pending: followupCard?.state === 'pending',
            effectAbsent: !existsSync(targetC),
            effectExact: existsSync(targetC) && readFileSync(targetC, 'utf8') === contentC,
            exactLineage:
              !!originalA &&
              !!originalCarrier &&
              !!successor &&
              !!followupCard &&
              !!followupTool &&
              !!originalChildRun &&
              !!followupChildRun &&
              allCarriers.length === 3 &&
              allCards.length === 3 &&
              Number(
                rows(
                  "SELECT COUNT(*) AS count FROM interaction WHERE presentation_session_id='native-root'",
                )[0]!.count,
              ) === 4 &&
              allTools.length === 3 &&
              followupCard.session_id === originalA.session_id &&
              followupCard.run_id !== originalA.run_id &&
              followupCard.execution_id === followupTool.id &&
              followupTool.run_id === followupCard.run_id &&
              successor.id !== originalCarrier.id &&
              successor.root_work_command_id === originalCarrier.root_work_command_id &&
              followupChildRun.root_work_command_id === originalChildRun.root_work_command_id &&
              followupCard.origin_store_id === storeId &&
              followupCard.presentation_session_id === 'native-root',
            answered:
              followupCard?.state === 'answered' &&
              followupCard.accepted_decision_revision !== null &&
              parse(followupCard.answer_json).decision === 'approve',
            dispatched: followupTool?.state === 'succeeded' && followupTool.dispatched === 1,
          },
          followupPrompt:
            originalA && originalCarrier && originalChildRun
              ? `Continue ${String(originalCarrier.root_work_command_id)}. Use follow_up_agent exactly once on the same original A agent_id ${String(originalA.session_id)} and pass this exact quoted new instruction as its content: ${JSON.stringify(followupChildInstruction)}. Do not spawn another child. Keep waiting for the exact new child round to become terminal, then summarize its real outcome. Never retry a denied call. Mutate no other path.`
              : null,
          twoChildren: allCarriers.length === 2,
          exactLineage,
          rootWaiting:
            rows(
              "SELECT id FROM execution WHERE session_id='native-root' AND adapter_id='task.events' AND state IN('dispatching','running')",
            ).length > 0 &&
            runs.some((run) => run.session_id === 'native-root' && run.is_active === 1),
          effectsAbsent: !existsSync(targetA) && !existsSync(targetB) && !existsSync(targetC),
          approvedEffect: existsSync(targetA) && readFileSync(targetA, 'utf8') === contentA,
          deniedEffectAbsent: !existsSync(targetB),
          terminal:
            runs.length >= 3 &&
            runs.every(
              (run) =>
                run.is_active === 0 &&
                ['completed', 'cancelled', 'failed'].includes(String(run.status)),
            ) &&
            carriers.length === 2 &&
            allCarriers.every((carrier) =>
              ['succeeded', 'failed', 'cancelled'].includes(String(carrier.state)),
            ),
          exactAnswers,
          exactDispatch,
          modeSelected: mode && parse(mode.safe_request_json).mode === 'accept_edits',
          physicalRequests: wire.length,
          footprint: {
            runs: runs.length,
            executions: Number(rows('SELECT COUNT(*) AS count FROM execution')[0]!.count),
            commands: Number(rows('SELECT COUNT(*) AS count FROM command')[0]!.count),
            sources: Number(
              rows("SELECT COUNT(*) AS count FROM context_snapshot WHERE kind='result_ref'")[0]!
                .count,
            ),
            controls: Number(rows('SELECT COUNT(*) AS count FROM host_mutation')[0]!.count),
          },
        };
      } finally {
        db.close();
      }
    }
    stage = 'proxy_bind';
    proxy = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === 'GET' && path === `/${controlToken}/prompt`)
          return new Response(prompt);
        if (request.method === 'GET' && path === `/${controlToken}/followup`) {
          const next = snapshot().followupPrompt;
          return new Response(next ?? '', { status: next ? 200 : 409 });
        }
        if (request.method === 'GET' && path === `/${controlToken}/state`) {
          try {
            return Response.json(snapshot());
          } catch {
            return Response.json({ unavailable: true }, { status: 503 });
          }
        }
        if (request.method !== 'POST' || !['/v1/chat/completions', '/v1/responses'].includes(path))
          return new Response(null, { status: 404 });
        if (wire.length >= requestLimit || deadline.aborted) {
          budgetReached = true;
          return Response.json({ error: { message: 'live_budget_exhausted' } }, { status: 429 });
        }
        const entry = {
          attempt: wire.length + 1,
          status: 0,
          toolCount: 0,
          usage: null,
          startedOffsetMs: performance.now() - started,
          responseHeadersMs: null as number | null,
        };
        wire.push(entry);
        try {
          const body = await request.text();
          const parsed = object(JSON.parse(body));
          check(parsed.model === selected.model, 'native_window_unexpected_model');
          entry.toolCount = Array.isArray(parsed.tools) ? parsed.tools.length : 0;
          const response = await fetch(`${upstream}${path.slice(3)}`, {
            method: 'POST',
            body,
            redirect: 'error',
            headers: {
              'content-type': 'application/json',
              ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            },
            signal: AbortSignal.any([deadline, request.signal, AbortSignal.timeout(60000)]),
          });
          entry.status = response.status;
          entry.responseHeadersMs = performance.now() - started - entry.startedOffsetMs;
          return new Response(response.body, {
            status: response.status,
            headers: {
              'content-type': response.headers.get('content-type') ?? 'text/event-stream',
            },
          });
        } catch {
          return Response.json({ error: { message: 'live_transport_failed' } }, { status: 502 });
        }
      },
    });
    const enabled = new Set([
      'files.read_path',
      'files.write_path',
      'task.spawn',
      'task.follow_up',
      'task.message',
      'task.events',
      'task.list',
      'task.interrupt',
    ]);
    const toolIds = new Set([
      ...ordinaryHostConfigurationDefaults(true, true).tools.map((tool) => tool.id),
      ...enabled,
    ]);
    mkdirSync(join(home, '.kite-code'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, '.kite-code/kite-code.jsonc'),
      JSON.stringify({
        modelId: 'live-native',
        models: [
          {
            id: 'live-native',
            provider: 'compatible',
            model: selected.model,
            protocol,
            baseURL: `${proxy.url.href}v1`,
            enabled: true,
            options: { ...preset, maxOutputTokens: Math.min(preset.maxOutputTokens ?? 4096, 4096) },
          },
        ],
        tools: [...toolIds].map((id) => ({ id, enabled: enabled.has(id) })),
      }),
      { mode: 0o600 },
    );
    stage = 'build';
    const require = createRequire(
      resolve(import.meta.dir, '../../../../apps/desktop/package.json'),
    );
    const terminal = await buildTerminalBundle({ destination: join(root, 'terminal-build') });
    const built = await buildNativeCandidate({
      testDiagnostics: false,
      terminalRoot: terminal.root,
      electronDist: resolve(dirname(dirname(require('electron') as string)), '../..'),
      outdir: join(root, 'build'),
    });
    renameSync(join(root, 'build'), candidate);
    const bundle = verifyNativeRuntimeBundle(candidate);
    check(bundle.digest === built.digest, 'native_window_candidate_mismatch');
    buildMetadata = {
      testDiagnostics: false,
      nativeManifestSha256: createHash('sha256')
        .update(readFileSync(join(candidate, 'native-manifest.json')))
        .digest('hex'),
      nativeDigest: bundle.digest,
      terminalManifestSha256: bundle.manifest.terminalManifestSha256,
      electronVersion: bundle.manifest.electronVersion,
      platform: bundle.manifest.target,
      clientEntries: bundle.manifest.entries,
      serviceEntry: bundle.terminal.manifest.entries.service,
    };
    leases.push(
      acquireArtifactAccess({ root: candidate, mode: 'shared' }),
      acquireArtifactAccess({ root: bundle.terminal.root, mode: 'shared' }),
    );
    initializeSqliteEngine({
      root: join(bundle.terminal.root, 'node_modules/@kite-ai/agent/storage/engine'),
      manifestSha256: bundle.terminal.manifest.sqlite.manifestSha256,
    });
    stage = 'setup';
    seedStore = await openSqliteStore(profile);
    storeId = (await seedStore.getMetadata()).storeId;
    await seedStore.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'Live workspace',
      rootUri: pathToFileURL(workspace).href,
    });
    await seedStore.createSession({
      expectedStoreId: storeId,
      subjectId: 'local-user',
      commandId: 'setup-root',
      sessionId: 'native-root',
      workspaceId: 'w',
      title: 'Live collaboration',
    });
    await seedStore.createSession({
      expectedStoreId: storeId,
      subjectId: 'local-user',
      commandId: 'setup-switch',
      sessionId: 'native-switch',
      workspaceId: 'w',
      title: 'Switch target',
    });
    await seedStore.close();
    seedStore = undefined;
    checks.workspaceAndEmptyRootSetupOnly = true;
    checks.setupNoModelRequests = wire.length === 0;
    stage = 'driver';
    const driverBuild = await Bun.build({
      entrypoints: [
        resolve(
          import.meta.dir,
          '../../../../apps/desktop/test/live-collaboration-native-window.fixture.ts',
        ),
      ],
      target: 'node',
      packages: 'external',
      format: 'esm',
      outdir: root,
      naming: 'driver.js',
    });
    check(driverBuild.success, 'native_window_driver_build_failed');
    const receipt = join(root, 'window-receipt.json');
    driver = Bun.spawn(
      [
        realpathSync(Bun.which('node')!),
        join(root, 'driver.js'),
        candidate,
        home,
        `${proxy.url.href}${controlToken}`,
        receipt,
        resolve(import.meta.dir, '../../../../apps/desktop/package.json'),
      ],
      {
        cwd: home,
        env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    // Never persist driver exception text, argv, config, Provider payloads, or endpoint details.
    const outputDrain = Promise.all([
      new Response(driver.stdout).text(),
      new Response(driver.stderr).text(),
    ]);
    const abort = () => {
      driver?.kill('SIGTERM');
    };
    deadline.addEventListener('abort', abort, { once: true });
    try {
      const code = await driver.exited;
      await outputDrain;
      if (existsSync(receipt)) driverReceipt = JSON.parse(readFileSync(receipt, 'utf8'));
      Object.assign(checks, driverReceipt.checks);
      check(code === 0 && driverReceipt.passed, 'native_window_driver_failed');
      check(
        !budgetReached && wire.length > 0 && wire.every((entry) => entry.status === 200),
        'native_window_provider_failed',
      );
    } finally {
      deadline.removeEventListener('abort', abort);
    }
  } catch (error) {
    failureCode = safeCode(error);
    failure = true;
  } finally {
    try {
      if (driver?.exitCode === null) driver.kill('SIGTERM');
      if (existsSync(candidate)) await cleanupOwnedNativeCandidate(candidate);
      if (driver) await driver.exited;
    } catch (error) {
      cleanupCode = safeCode(error);
      cleanupSucceeded = false;
    }
    try {
      if (seedStore) await seedStore.close();
    } catch {
      cleanupSucceeded = false;
    }
    proxy?.stop(true);
    for (const lease of leases.reverse()) {
      try {
        lease.release();
      } catch {
        cleanupSucceeded = false;
      }
    }
    try {
      for (const owned of [candidate, join(candidate, 'terminal')]) {
        if (!existsSync(owned)) continue;
        const exclusive = acquireArtifactAccess({ root: owned, mode: 'exclusive' });
        exclusive.release();
      }
    } catch {
      cleanupSucceeded = false;
    }
    // Closed, checkpointed Store only: inspect a private memory copy, never reopen a writer.
    if (existsSync(profile.databasePath) && !existsSync(`${profile.databasePath}-wal`)) {
      let memory: Database | undefined;
      try {
        const bytes = readFileSync(profile.databasePath);
        bytes[18] = 1;
        bytes[19] = 1;
        memory = Database.deserialize(bytes);
        canonicalUsage = memory
          .query<{ result_json: string }, []>(
            "SELECT result_json FROM execution WHERE kind='model' ORDER BY rowid",
          )
          .all()
          .map((row) => {
            const usage = object(parse(row.result_json).usage);
            return Object.fromEntries(
              [
                'inputTokens',
                'outputTokens',
                'totalTokens',
                'cachedInputTokens',
                'reasoningTokens',
              ].map((key) => [
                key,
                typeof usage[key] === 'number' && Number.isFinite(usage[key])
                  ? (usage[key] as number)
                  : null,
              ]),
            );
          });
      } catch {
        canonicalUsage = null;
      } finally {
        memory?.close();
      }
    }
    checks.physicalProviderRequests = wire.length;
    checks.requestBudgetRespected = wire.length <= requestLimit && !budgetReached;
    checks.cleanupSucceeded = cleanupSucceeded;
    const u01Passed =
      cleanupSucceeded &&
      !budgetReached &&
      wire.length > 0 &&
      wire.every((entry) => entry.status === 200) &&
      checks.canonicalAnswersAndDispatch === true &&
      checks.allOriginalRunsAndCarriersTerminal === true &&
      checks.approvedFileExactDeniedFileAbsent === true &&
      checks.firstWindowCleanExit === true;
    const coldPassed =
      cleanupSucceeded &&
      checks.coldReopenNoModelReplay === true &&
      checks.coldReopenNoBusinessOrSourceMutation === true &&
      checks.cleanWindowExit === true;
    const u02SubsetPassed =
      checks.sameChildTwoAccurateRounds === true &&
      checks.originalMetadataUnchanged === true &&
      checks.oldApprovalControlsDetached === true &&
      checks.freshFollowupApprovalAndEffect === true &&
      checks.accurateFollowupDelegationApprovedViaOrdinaryUI === true &&
      checks.ordinarySessionSwitchReturn === true;
    completed = u01Passed && u02SubsetPassed && coldPassed && !failure;
    const report = {
      artifact: 'live-native-window',
      startedAt,
      finishedAt: new Date().toISOString(),
      monotonicDurationMs: performance.now() - started,
      code: codeEvidence,
      model: modelMetadata,
      build: buildMetadata,
      physicalHttp: wire,
      physicalUsageObservation:
        'not_parsed_to_preserve_transparent_stream; usage is null per attempt',
      canonicalModelUsage: canonicalUsage,
      canonicalUsageObservation:
        canonicalUsage === null
          ? 'unavailable'
          : 'saved model receipts; no physical-attempt reconstruction',
      cleanup: {
        succeeded: cleanupSucceeded,
        driverExitCode: driver?.exitCode ?? null,
        firstWindowNormalExit: checks.firstWindowCleanExit === true,
        coldWindowNormalExit: checks.cleanWindowExit === true,
      },
      retained: {
        root,
        canonicalStore: join(root, 'home/.kite-code/unified-agent/default/core.db'),
        windowReceipt: join(root, 'window-receipt.json'),
        screenshots: join(root, 'home'),
      },
      cases: [
        {
          id: 'U01-Native',
          status: u01Passed ? 'passed' : 'failed',
          checks,
          failurePoint: u01Passed ? null : (driverReceipt.stage ?? stage),
          failureCode: u01Passed ? null : failureCode,
          cleanupCode: cleanupCode || null,
        },
        {
          id: 'U02-Native-two-round-history-controls-subset',
          status: u02SubsetPassed
            ? 'passed'
            : checks.allOriginalRunsAndCarriersTerminal
              ? 'failed'
              : 'not_run',
          scope:
            'same child two rounds; old approval controls detached; ordinary session switch and return; fresh exact approval',
          untested:
            'No late historical answer or stop request was submitted; removed controls are not a server rejection test. Disconnect/reconnect and job.report linkage are not covered.',
          checks,
        },
        {
          id: 'U03-Native-cold-subset',
          status: coldPassed ? 'passed' : checks.firstWindowCleanExit ? 'failed' : 'not_run',
          scope: 'normal cold history reopen only',
          failurePoint: coldPassed ? null : (driverReceipt.stage ?? null),
        },
      ],
      budget: { requestLimit, timeoutMs: 600000, actualRequests: wire.length },
      canonicalEvidenceRetained: true,
    };
    writeFileSync(options.output, JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  return completed;
}

if (import.meta.main) {
  check(process.env.KITE_RUN_LIVE_COLLABORATION === '1', 'native_window_live_opt_in_required');
  const match = /^--output=(\/.*\.json)$/.exec(process.argv[2] ?? '');
  check(match && process.argv.length === 3, 'native_window_arguments_invalid');
  if (!(await runLiveNativeWindow({ output: match[1]! }))) process.exitCode = 1;
}
