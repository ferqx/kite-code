import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCredentialVault, createOsCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import { buildNativeDesktop } from '../../../../apps/desktop/scripts/build-native';
import {
  createUserConfiguration,
  parseModelPreset,
} from '../../../../apps/service/src/configuration';
import { ordinaryHostConfigurationDefaults } from '../../../../apps/service/src/configuration-defaults';
import { ownedUserConfiguration } from '../../../../apps/service/test/fixtures/user-configuration-fixture';
import { directoryLink } from '../../../fixtures/test-filesystem';
import { liveCodeEvidence } from './live-code-evidence';

type Row = Record<string, string | number | null>;
type Attempt = {
  marker: string;
  ordinal: number;
  phase: 'held' | 'forwarding' | 'done' | 'cancelled';
  runId: string;
  executionId: string;
  commandId: string;
  commandRequestJson: string;
  commandRequestDigest: string;
  upstreamStatus: number;
  receivedBytes: number;
  forwardedBytes: number;
  requestSha256: string;
  responseSha256: string | null;
  cancelRequested: boolean;
  cancelCompleted: boolean;
  cancelFailed: boolean;
  cancelErrorName: string | null;
  cancelErrorCode: string | number | null;
  readerClosed: boolean;
  readerClosedErrorName: string | null;
  readerClosedErrorCode: string | number | null;
  transportAborted: boolean;
  eof: boolean;
  failed: boolean;
};
const repository = resolve(import.meta.dir, '../../../..');
const require = createRequire(resolve(repository, 'apps/desktop/package.json'));
const markers = [
  'ANOMALY_DISCONNECT',
  'ANOMALY_DISCONNECT_CONTINUE',
  'ANOMALY_RECEIPT',
  'ANOMALY_RECEIPT_CONTINUE',
  'ANOMALY_CRASH',
  'ANOMALY_CRASH_CONTINUE',
] as const;
function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw Error(code);
}
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const safeCode = (error: unknown) => {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (/^(?:SQLITE_[A-Z_]+|EACCES|EPERM|ENOENT|EADDRINUSE)$/.test(code)) return code;
  const message = error instanceof Error ? error.message : '';
  return /^live_anomaly_[a-z_]+$/.test(message) ? message : 'live_anomaly_failed';
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const safeStreamError = (error: unknown) => {
  const value =
    error && typeof error === 'object' ? (error as { name?: unknown; code?: unknown }) : {};
  return {
    name: ['AbortError', 'TimeoutError', 'Error', 'TypeError', 'DOMException'].includes(
      String(value.name),
    )
      ? String(value.name)
      : 'UnknownError',
    code:
      typeof value.code === 'number' && Number.isSafeInteger(value.code)
        ? value.code
        : [
              'ABORT_ERR',
              'ECONNRESET',
              'ECONNABORTED',
              'ETIMEDOUT',
              'ERR_STREAM_PREMATURE_CLOSE',
            ].includes(String(value.code))
          ? String(value.code)
          : null,
  };
};

function firstLineMarker(text: string) {
  const marker = text.replace(/\\+_/g, '_').split(/\r?\n/)[0]?.trim();
  return markers.find((known) => known === marker);
}

/** Read only genuine human message text; runtime supplements and other roles are not inputs. */
export function readLiveAnomalyRequestMarker(body: unknown): string {
  const object = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const messages = Array.isArray(object.messages)
    ? object.messages
    : Array.isArray(object.input)
      ? object.input
      : typeof object.input === 'string'
        ? [{ role: 'user', content: object.input }]
        : [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || message.role !== 'user') continue;
    const content: unknown = message.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .map((part: unknown) => {
                if (!part || typeof part !== 'object') return '';
                const candidate = part as { type?: unknown; text?: unknown };
                return ['text', 'input_text'].includes(String(candidate.type)) &&
                  typeof candidate.text === 'string'
                  ? candidate.text
                  : '';
              })
              .join('')
          : '';
    const marker = firstLineMarker(text);
    if (marker) return marker;
  }
  throw Error('live_anomaly_http_input_missing');
}

/** Explicit real-provider artifact; no ordinary application entry or test backend is installed. */
export async function runLiveSessionAnomalies(options: { output: string; checkpoint?: string }) {
  check(process.platform === 'darwin', 'live_anomaly_platform');
  check(isAbsolute(options.output), 'live_anomaly_output_path');
  check(!existsSync(options.output), 'live_anomaly_output_exists');
  check(!options.checkpoint || isAbsolute(options.checkpoint), 'live_anomaly_checkpoint_path');
  const root = `${options.output}.workspace`;
  check(!existsSync(root), 'live_anomaly_workspace_exists');
  const evidence = join(root, 'evidence'),
    home = join(root, 'home'),
    workspace = join(root, 'workspace'),
    effectsDirectory = join(workspace, 'effects'),
    outdir = join(root, 'app'),
    profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'desktop' });
  for (const directory of [dirname(options.output), evidence, home, effectsDirectory])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (options.checkpoint) mkdirSync(options.checkpoint, { recursive: true, mode: 0o700 });
  const writeEvidence = (name: string, value: unknown) =>
    writeFileSync(join(evidence, name), JSON.stringify(value, null, 2), { mode: 0o600 });
  const codeEvidence = liveCodeEvidence(),
    deadline = new AbortController(),
    timeout = setTimeout(() => deadline.abort(Error('live_anomaly_deadline')), 600000),
    calls: Attempt[] = [],
    counts: Record<string, number> = {},
    failures: string[] = [],
    controls = new Map<string, () => void>(),
    cancellations = new Set<Promise<void>>(),
    prompts = Object.fromEntries(
      markers.map((marker) => [
        marker,
        `${marker}\n\nThis is one explicitly authorized isolated file task. Use write_file exactly once with path ${JSON.stringify(`effects/${marker}.txt`)}, content exactly ${JSON.stringify(marker)}, and base null. Do not call any other tool, create a child, ask a question, or touch another path. After its actual successful result, reply briefly DONE ${marker}. Do not retry a failed write.${marker.endsWith('_CONTINUE') ? ' This is a new independent task. Do not resume, repeat, or complete any previous interrupted task.' : ''}`,
      ]),
    );
  let budgetReached = false,
    stage = 'configuration',
    passed = false,
    cleanupSucceeded = true,
    driver: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined,
    proxy: ReturnType<typeof Bun.serve> | undefined,
    warm: Awaited<ReturnType<typeof launchPairedService>> | undefined,
    driverTimer: ReturnType<typeof setTimeout> | undefined;
  let modelMetadata: Record<string, unknown> = {},
    storeId = '';
  const readFacts = () => {
    const db = new Database(profile.databasePath, { readonly: true });
    let core: Record<string, Row[]>;
    try {
      db.run('PRAGMA busy_timeout=1000');
      db.run('PRAGMA query_only=ON');
      const rows = (sql: string) => db.query<Row, []>(sql).all();
      core = {
        commands: rows('SELECT * FROM command ORDER BY session_id,seq'),
        runs: rows('SELECT * FROM run ORDER BY started_at,id'),
        executions: rows('SELECT * FROM execution ORDER BY id'),
        messages: rows('SELECT * FROM message ORDER BY session_id,seq'),
      };
    } finally {
      db.close();
    }
    const journal: Record<string, Row[]> = { caller: [], inputQueue: [], creations: [] },
      privatePath = join(profile.profilePath, 'desktop-private/data.sqlite');
    if (existsSync(privatePath)) {
      const db = new Database(privatePath, { readonly: true });
      try {
        db.run('PRAGMA busy_timeout=1000');
        db.run('PRAGMA query_only=ON');
        for (const [key, table] of [
          ['caller', 'caller_intents'],
          ['inputQueue', 'input_queue_intents'],
          ['creations', 'creations'],
        ] as const)
          if (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))
            journal[key] = db.query<Row, []>(`SELECT * FROM ${table}`).all();
      } finally {
        db.close();
      }
    }
    const effects = Object.fromEntries(
      readdirSync(effectsDirectory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => [
          entry.name,
          entry.isFile()
            ? readFileSync(join(effectsDirectory, entry.name), 'utf8')
            : '[non-regular entry]',
        ]),
    );
    return { ...core, journal, effects, provider: { calls, counts }, failures, budgetReached };
  };
  const currentModel = () => {
    const db = new Database(profile.databasePath, { readonly: true });
    try {
      db.run('PRAGMA busy_timeout=1000');
      db.run('PRAGMA query_only=ON');
      const rows = db
        .query<Row, []>(
          "SELECT e.id execution_id,e.run_id,c.id command_id,c.request_json,c.request_digest FROM execution e JOIN run r ON r.id=e.run_id JOIN command c ON c.id=r.origin_command_id WHERE e.kind='model' AND e.dispatched=1 AND e.state IN('dispatching','running') AND r.is_active=1",
        )
        .all();
      check(rows.length === 1, 'live_anomaly_model_scope_ambiguous');
      const row = rows[0]!,
        content = JSON.parse(String(row.request_json)).content;
      check(typeof content === 'string', 'live_anomaly_original_input_missing');
      const marker = firstLineMarker(content);
      check(marker, 'live_anomaly_marker_missing');
      return { row, marker };
    } finally {
      db.close();
    }
  };
  let cleanupPromise: Promise<void> | undefined;
  const cleanupDriver = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      if (!driver || driver.exitCode !== null || driver.signalCode !== null) return;
      const identities: { pid: number; executable: string; birth: string }[] = [];
      try {
        const rows = String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command=']))
          .split('\n')
          .map((line) => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line))
          .filter((row): row is RegExpExecArray => !!row);
        const mains = rows.filter(
          (row) => Number(row[2]) === driver!.pid && row[3]!.includes(outdir),
        );
        check(mains.length <= 1, 'live_anomaly_cleanup_ambiguous');
        const main = mains[0];
        const selected = main
          ? [
              main,
              ...rows.filter(
                (row) =>
                  Number(row[2]) === Number(main[1]) &&
                  row[3]!.includes(join(root, 'apps/service/dist/service.js')),
              ),
            ]
          : [];
        for (const row of selected) {
          const pid = Number(row[1]);
          identities.push({
            pid,
            executable: String(execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='])).trim(),
            birth: String(execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='])).trim(),
          });
        }
      } catch {
        cleanupSucceeded = false;
      }
      driver.kill('SIGTERM');
      const ended = await Promise.race([
        driver.exited.then(() => true),
        sleep(10000).then(() => false),
      ]);
      if (!ended) {
        cleanupSucceeded = false;
        for (const identity of identities.reverse()) {
          try {
            const executable = String(
                execFileSync('/bin/ps', ['-p', String(identity.pid), '-o', 'comm=']),
              ).trim(),
              birth = String(
                execFileSync('/bin/ps', ['-p', String(identity.pid), '-o', 'lstart=']),
              ).trim();
            if (birth === identity.birth && executable === identity.executable)
              process.kill(identity.pid, 'SIGKILL');
          } catch {
            /* An exited original process needs no further signal. */
          }
        }
        driver.kill('SIGKILL');
        await driver.exited;
      }
    })();
    return cleanupPromise;
  };
  const processVerifications: {
    at: string;
    observations: { pid: number; boot: number; state: string }[];
    cleanupSucceeded: boolean;
  }[] = [];
  const verifyOwnedProcesses = async (complete: boolean) => {
    if (!driver) return;
    type OwnedIdentity = {
      pid: number;
      birth: string;
      executable: string;
      boot: number;
      kind?: string;
      role?: string;
    };
    const observations: { pid: number; boot: number; state: string }[] = [];
    const readProcessField = (pid: number, field: 'lstart=' | 'comm=') => {
      try {
        return String(
          execFileSync('/bin/ps', ['-p', String(pid), '-o', field], {
            env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
          }),
        ).trim();
      } catch (error) {
        const failure = error as { status?: number; stdout?: Uint8Array; stderr?: Uint8Array };
        if (
          failure.status === 1 &&
          !String(failure.stdout ?? '').trim() &&
          !String(failure.stderr ?? '').trim()
        )
          return undefined;
        throw Error('live_anomaly_process_observation_unknown');
      }
    };
    const originalAlive = (identity: OwnedIdentity) => {
      const firstBirth = readProcessField(identity.pid, 'lstart=');
      if (firstBirth === undefined) return false;
      const executable = readProcessField(identity.pid, 'comm='),
        secondBirth = readProcessField(identity.pid, 'lstart=');
      if (executable === undefined || secondBirth === undefined) return false;
      check(
        !!firstBirth && firstBirth === secondBirth && !!executable,
        'live_anomaly_process_observation_unknown',
      );
      return firstBirth === identity.birth && executable === identity.executable;
    };
    try {
      const path = join(evidence, 'owned-processes.json');
      check(existsSync(path), 'live_anomaly_owned_process_evidence_missing');
      const records = JSON.parse(readFileSync(path, 'utf8')).processes as OwnedIdentity[];
      check(
        Array.isArray(records) && records.length > 0,
        'live_anomaly_owned_process_evidence_invalid',
      );
      const boots = new Set<number>();
      for (const record of records) {
        check(
          Number.isSafeInteger(record.pid) &&
            record.pid > 1 &&
            Number.isSafeInteger(record.boot) &&
            record.boot > 0 &&
            typeof record.birth === 'string' &&
            !!record.birth &&
            typeof record.executable === 'string' &&
            isAbsolute(record.executable) &&
            ['main', 'service'].includes(record.kind ?? record.role ?? ''),
          'live_anomaly_owned_process_evidence_invalid',
        );
        boots.add(record.boot);
        if (originalAlive(record)) {
          cleanupSucceeded = false;
          // Signal only the still-confirmed original incarnation. Events alone never authorize it.
          if (originalAlive(record)) process.kill(record.pid, 'SIGKILL');
          const end = performance.now() + 5000;
          while (originalAlive(record) && performance.now() < end) await sleep(50);
          check(!originalAlive(record), 'live_anomaly_owned_process_survived_cleanup');
          observations.push({ pid: record.pid, boot: record.boot, state: 'forced_cleanup' });
        } else observations.push({ pid: record.pid, boot: record.boot, state: 'original_gone' });
      }
      for (const boot of boots)
        for (const kind of ['main', 'service'])
          check(
            records.some((record) => record.boot === boot && (record.kind ?? record.role) === kind),
            'live_anomaly_owned_process_evidence_incomplete',
          );
      if (complete)
        check(
          boots.size === 3 && [1, 2, 3].every((boot) => boots.has(boot)),
          'live_anomaly_three_boots_not_verified',
        );
    } catch (error) {
      cleanupSucceeded = false;
      failures.push(safeCode(error));
    } finally {
      processVerifications.push({
        at: new Date().toISOString(),
        observations,
        cleanupSucceeded,
      });
      writeEvidence('owned-process-verification.json', { verifications: processVerifications });
    }
  };
  try {
    const configuration = createUserConfiguration(),
      settings = configuration.read().value,
      selected = (Array.isArray(settings.models) ? settings.models : []).find(
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
      'live_anomaly_default_missing',
    );
    check(
      typeof selected.model === 'string' && typeof selected.baseURL === 'string',
      'live_anomaly_model_invalid',
    );
    const protocol = selected.protocol ?? 'chat-completions';
    check(
      protocol === 'chat-completions' || protocol === 'responses',
      'live_anomaly_protocol_invalid',
    );
    const configured = parseModelPreset(selected.options),
      preset = {
        ...configured,
        maxOutputTokens: Math.min(configured.maxOutputTokens ?? 4096, 4096),
      },
      vault = createCredentialVault({
        backend: createOsCredentialBackend({
          service: 'kite-agent',
          accountNamespace: 'user-models',
        }),
      }),
      apiKey =
        typeof selected.credentialRef === 'string'
          ? (configuration.resolveCredential(selected.credentialRef) ??
            (await vault.resolve(selected.credentialRef)))
          : undefined,
      upstream = selected.baseURL.replace(/\/$/, ''),
      token = randomUUID();
    check(
      typeof selected.credentialRef !== 'string' ||
        (typeof apiKey === 'string' && apiKey.trim().length > 0),
      'live_anomaly_credential_missing',
    );
    modelMetadata = { model: selected.model, provider: selected.provider, protocol, preset };
    stage = 'proxy';
    proxy = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 0,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url),
          prefix = `/${token}`;
        if (!url.pathname.startsWith(`${prefix}/`)) return new Response(null, { status: 404 });
        const path = url.pathname.slice(prefix.length);
        if (request.method === 'GET' && path === '/scenario')
          return Response.json({ kind: 'live', prompts, responseTimeoutMs: 90000 });
        if (request.method === 'GET' && path === '/facts') {
          try {
            return Response.json(readFacts());
          } catch (error) {
            const code = safeCode(error),
              temporary = /^(?:SQLITE_BUSY|SQLITE_LOCKED)(?:_|$)/.test(code);
            return Response.json(
              { error: temporary ? 'live_anomaly_facts_busy' : 'live_anomaly_facts_failed', code },
              { status: temporary ? 503 : 500 },
            );
          }
        }
        if (request.method === 'GET' && path === '/release') {
          const marker = url.searchParams.get('marker') ?? '',
            release = controls.get(marker);
          release?.();
          return Response.json({ marker, released: !!release });
        }
        if (request.method === 'GET' && path === '/checkpoint') {
          const name = url.searchParams.get('name') ?? '';
          if (!/^[0-9]{2}-[a-zA-Z0-9-]+$/.test(name)) return new Response(null, { status: 400 });
          writeEvidence('checkpoint.json', {
            name,
            at: new Date().toISOString(),
            stage,
            requests: calls.length,
          });
          while (options.checkpoint && !existsSync(join(options.checkpoint, `${name}.continue`))) {
            if (deadline.signal.aborted || request.signal.aborted)
              return new Response(null, { status: 408 });
            await sleep(100);
          }
          return Response.json({ name, continued: true });
        }
        if (request.method !== 'POST' || !['/v1/chat/completions', '/v1/responses'].includes(path))
          return new Response(null, { status: 404 });
        if (calls.length >= 20 || deadline.signal.aborted) {
          budgetReached = true;
          return Response.json(
            { error: { message: 'live_anomaly_budget_exhausted' } },
            { status: 429 },
          );
        }
        let attempt: Attempt | undefined;
        try {
          const body = await request.text(),
            { row, marker } = currentModel();
          const httpBody = JSON.parse(body);
          check(httpBody.model === selected.model, 'live_anomaly_wrong_model');
          check(
            readLiveAnomalyRequestMarker(httpBody) === marker,
            'live_anomaly_http_core_input_mismatch',
          );
          // Body reads can interleave; reserve the actual outbound slot without another await.
          if (calls.length >= 20 || deadline.signal.aborted) {
            budgetReached = true;
            return Response.json(
              { error: { message: 'live_anomaly_budget_exhausted' } },
              { status: 429 },
            );
          }
          const ordinal = (counts[marker] ?? 0) + 1;
          counts[marker] = ordinal;
          attempt = {
            marker,
            ordinal,
            phase: 'forwarding',
            runId: String(row.run_id),
            executionId: String(row.execution_id),
            commandId: String(row.command_id),
            commandRequestJson: String(row.request_json),
            commandRequestDigest: String(row.request_digest),
            upstreamStatus: 0,
            receivedBytes: 0,
            forwardedBytes: 0,
            requestSha256: digest(body),
            responseSha256: null,
            cancelRequested: false,
            cancelCompleted: false,
            cancelFailed: false,
            cancelErrorName: null,
            cancelErrorCode: null,
            readerClosed: false,
            readerClosedErrorName: null,
            readerClosedErrorCode: null,
            transportAborted: false,
            eof: false,
            failed: false,
          };
          calls.push(attempt);
          const signal = AbortSignal.any([
              deadline.signal,
              request.signal,
              AbortSignal.timeout(60000),
            ]),
            response = await fetch(`${upstream}${path.slice(3)}`, {
              method: 'POST',
              body,
              redirect: 'error',
              headers: {
                'content-type': 'application/json',
                ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
              },
              signal,
            });
          attempt.upstreamStatus = response.status;
          if (!response.body) {
            attempt.eof = true;
            attempt.phase = 'done';
            return response;
          }
          const reader = response.body.getReader(),
            selectedAttempt = attempt,
            hash = createHash('sha256');
          // Observe immediately: Bun marks both cancel() and closed as AbortError
          // after the original fetch signal has aborted, even though transport settled.
          const readerClosed = reader.closed.then(
            () => {
              selectedAttempt.readerClosed = true;
              return { resolved: true, name: null, code: null };
            },
            (error: unknown) => {
              selectedAttempt.readerClosed = true;
              const detail = safeStreamError(error);
              selectedAttempt.readerClosedErrorName = detail.name;
              selectedAttempt.readerClosedErrorCode = detail.code;
              return { resolved: false, ...detail };
            },
          );
          let finished = false,
            first: Uint8Array | undefined,
            released = false,
            release!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = () => {
              released = true;
              controls.delete(marker);
              resolve();
            };
          });
          const finish = () => {
            if (finished) return;
            finished = true;
            selectedAttempt.responseSha256 = hash.digest('hex');
            signal.removeEventListener('abort', abort);
            release();
          };
          let cancelPromise: Promise<void> | undefined;
          const cancel = () => {
            if (cancelPromise) return cancelPromise;
            selectedAttempt.cancelRequested = true;
            selectedAttempt.phase = 'cancelled';
            release();
            cancelPromise = reader
              .cancel()
              .then(
                () => {
                  selectedAttempt.cancelCompleted = true;
                },
                async (error: unknown) => {
                  const detail = safeStreamError(error);
                  selectedAttempt.cancelErrorName = detail.name;
                  selectedAttempt.cancelErrorCode = detail.code;
                  const closed = await Promise.race([
                    readerClosed,
                    sleep(1000).then(() => undefined),
                  ]);
                  if (
                    signal.aborted &&
                    detail.name === 'AbortError' &&
                    (detail.code === 20 || detail.code === 'ABORT_ERR') &&
                    closed?.resolved === false &&
                    closed.name === detail.name &&
                    closed.code === detail.code
                  ) {
                    selectedAttempt.transportAborted = true;
                    selectedAttempt.cancelCompleted = true;
                  } else {
                    selectedAttempt.cancelFailed = true;
                    cleanupSucceeded = false;
                  }
                },
              )
              .finally(finish);
            cancellations.add(cancelPromise);
            void cancelPromise.finally(() => cancellations.delete(cancelPromise!));
            return cancelPromise;
          };
          const abort = () => {
            if (!finished) void cancel();
          };
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) await cancel();
          const held =
            ordinal === 1 &&
            ['ANOMALY_DISCONNECT', 'ANOMALY_CRASH'].includes(marker) &&
            response.status === 200;
          if (held && !finished) {
            const item = await reader.read();
            check(!item.done && item.value.byteLength > 0, 'live_anomaly_no_first_body');
            first = item.value;
            selectedAttempt.receivedBytes += first.byteLength;
            hash.update(first);
            selectedAttempt.phase = 'held';
            controls.set(marker, release);
          } else release();
          const stream = new ReadableStream<Uint8Array>(
            {
              async pull(controller) {
                try {
                  if (!released) await gate;
                  if (signal.aborted || selectedAttempt.cancelRequested) {
                    controller.error(Error('live_anomaly_cancelled'));
                    return;
                  }
                  selectedAttempt.phase = 'forwarding';
                  if (first) {
                    const chunk = first;
                    first = undefined;
                    selectedAttempt.forwardedBytes += chunk.byteLength;
                    controller.enqueue(chunk);
                    return;
                  }
                  const item = await reader.read();
                  if (item.done) {
                    selectedAttempt.eof = true;
                    selectedAttempt.phase = 'done';
                    finish();
                    controller.close();
                    return;
                  }
                  selectedAttempt.receivedBytes += item.value.byteLength;
                  selectedAttempt.forwardedBytes += item.value.byteLength;
                  hash.update(item.value);
                  controller.enqueue(item.value);
                } catch {
                  selectedAttempt.failed = true;
                  await cancel();
                  controller.error(Error('live_anomaly_stream_failed'));
                }
              },
              async cancel() {
                await cancel();
              },
            },
            { highWaterMark: 0 },
          );
          return new Response(stream, {
            status: response.status,
            headers: {
              'content-type': response.headers.get('content-type') ?? 'text/event-stream',
            },
          });
        } catch (error) {
          if (attempt) {
            attempt.failed = true;
            attempt.cancelRequested = request.signal.aborted || deadline.signal.aborted;
            if (attempt.cancelRequested) attempt.phase = 'cancelled';
          }
          failures.push(safeCode(error));
          return Response.json(
            { error: { message: 'live_anomaly_transport_failed' } },
            { status: 502 },
          );
        }
      },
    });
    const controlBase = `${proxy.url.origin}/${token}`,
      userConfiguration = ownedUserConfiguration(home);
    writeFileSync(
      userConfiguration.path,
      JSON.stringify({
        modelId: 'live-native',
        models: [
          {
            id: 'live-native',
            provider: 'compatible',
            model: selected.model,
            protocol,
            baseURL: `${controlBase}/v1`,
            enabled: true,
            options: preset,
          },
        ],
        tools: ordinaryHostConfigurationDefaults(true, true).tools.map(({ id }) => ({
          id,
          enabled: id === 'files.write',
          ...(id === 'files.write' ? { definitionVersion: '2' } : {}),
        })),
      }),
      { mode: 0o600 },
    );
    stage = 'build_service';
    const serviceOutdir = join(root, 'apps/service/dist');
    mkdirSync(serviceOutdir, { recursive: true });
    directoryLink(
      resolve(repository, 'apps/service/node_modules'),
      join(root, 'apps/service/node_modules'),
    );
    const serviceEntrypoint = join(serviceOutdir, 'service.js'),
      built = await Bun.build({
        entrypoints: [resolve(repository, 'apps/service/src/main.ts')],
        target: 'bun',
        format: 'esm',
        packages: 'external',
        outdir: serviceOutdir,
        naming: 'service.js',
      });
    check(built.success, 'live_anomaly_service_build');
    const bunExecutable = realpathSync(process.execPath),
      hashFile = (path: string) => digest(readFileSync(path)),
      artifact = {
        entrypoint: serviceEntrypoint,
        executable: bunExecutable,
        entrypointSha256: hashFile(serviceEntrypoint),
        executableSha256: hashFile(bunExecutable),
        buildId: 'live-session-anomalies',
        apiMajor: 1,
      };
    stage = 'setup';
    warm = await launchPairedService({
      ...artifact,
      profile,
      instanceId: randomUUID(),
      spawnChild: userConfiguration.spawnChild,
      requiredCapabilities: ['sessions', 'commands', 'permission_controls'],
    });
    const client = warm.client;
    storeId = warm.bootstrap.storeId!;
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'Real model session anomalies',
      rootUri: pathToFileURL(workspace).href,
    });
    for (const [sessionId, title] of [
      ['disconnect', '断线验证'],
      ['crash', '强杀验证'],
      ['receipt', '回执验证'],
    ] as const) {
      await client.createSession({
        expectedStoreId: storeId,
        commandId: `create_${sessionId}`,
        sessionId,
        workspaceId: 'w',
        title,
      });
      const mode = await client.getPermissionMode(sessionId, { storeId });
      check(
        (
          await client.setPermissionMode(sessionId, {
            expectedStoreId: storeId,
            commandId: `mode_${sessionId}`,
            mode: 'full',
            ifRevision: mode.revision,
            makeDefault: false,
            ifDefaultRevision: mode.defaultRevision,
          })
        ).state === 'applied',
        'live_anomaly_setup_mode',
      );
    }
    const trust = await client.getWorkspaceTrust('w', { storeId });
    check(
      (
        await client.setWorkspaceTrust('w', {
          expectedStoreId: storeId,
          commandId: 'trust_w',
          trusted: true,
          canonicalIdentity: trust.canonicalIdentity,
          externalReadScopeDigest: trust.externalReadScopeDigest,
          ifRevision: trust.revision,
        })
      ).state === 'applied',
      'live_anomaly_setup_trust',
    );
    await warm.close();
    warm = undefined;
    check(calls.length === 0, 'live_anomaly_setup_called_model');
    stage = 'build_native';
    await buildNativeDesktop(
      {
        serviceEntrypoint,
        bunExecutable,
        serviceSha256: artifact.entrypointSha256,
        bunSha256: artifact.executableSha256,
        buildId: artifact.buildId,
        apiMajor: 1,
        requiredCapabilities: ['sessions', 'history', 'commands', 'permission_controls'],
        profile: { dataRoot: profile.dataRoot, profile: profile.profile },
      },
      outdir,
      { testDiagnostics: false },
    );
    writeEvidence('metadata.json', {
      sourceCommit: codeEvidence.head,
      codeEvidence,
      sourceFiles: Object.fromEntries(
        [
          'apps/desktop/src/native.tsx',
          'apps/desktop/src/native-tool-messages.tsx',
          'packages/ui/src/desktop/Conversation.tsx',
          'packages/ui/src/desktop/ToolActivity.tsx',
          'packages/agent/src/runtime.ts',
          'tests/e2e/live/model/session-anomalies-native-window.live.ts',
          'apps/desktop/test/native-session-anomalies-electron.fixture.ts',
          'apps/desktop/test/native-session-anomaly-network.fixture.ts',
        ].map((path) => [path, hashFile(join(repository, path))]),
      ),
      root,
      home,
      workspace,
      profile,
      storeId,
      outdir,
      artifact,
      model: modelMetadata,
      budget: { requestLimit: 20, timeoutMs: 600000, perRequestTimeoutMs: 60000 },
    });
    const driverBuild = await Bun.build({
      entrypoints: [
        resolve(repository, 'apps/desktop/test/native-session-anomalies-electron.fixture.ts'),
      ],
      target: 'node',
      format: 'esm',
      packages: 'external',
      outdir: root,
      naming: 'driver.js',
    });
    check(driverBuild.success, 'live_anomaly_driver_build');
    directoryLink(join(repository, 'node_modules'), join(root, 'node_modules'));
    stage = 'driver';
    deadline.signal.throwIfAborted();
    driver = Bun.spawn(
      [
        realpathSync(Bun.which('node')!),
        join(root, 'driver.js'),
        outdir,
        home,
        require('electron') as string,
        controlBase,
        evidence,
        profile.databasePath,
        bunExecutable,
        resolve(repository, 'apps/desktop/package.json'),
        'live',
      ],
      {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      },
    );
    const drained = Promise.all([
      new Response(driver.stdout).text(),
      new Response(driver.stderr).text(),
    ]);
    driverTimer = setTimeout(() => {
      void cleanupDriver();
    }, 540000);
    const abort = () => {
      void cleanupDriver();
    };
    deadline.signal.addEventListener('abort', abort, { once: true });
    const exit = await driver.exited;
    deadline.signal.removeEventListener('abort', abort);
    await drained; // Never persist arbitrary real-provider exceptions, argv or stderr.
    writeEvidence('driver-exit.json', { exitCode: exit, signal: driver.signalCode });
    await verifyOwnedProcesses(exit === 0 && driver.signalCode === null);
    check(exit === 0 && driver.signalCode === null, 'live_anomaly_driver_failed');
    check(existsSync(join(evidence, 'qualification.json')), 'live_anomaly_qualification_missing');
    check(
      JSON.parse(readFileSync(join(evidence, 'qualification.json'), 'utf8')).status === 'passed',
      'live_anomaly_not_qualified',
    );
    check(
      !budgetReached && !deadline.signal.aborted && failures.length === 0,
      'live_anomaly_budget_or_transport_failure',
    );
    passed = true;
  } catch (error) {
    failures.push(safeCode(error));
  } finally {
    clearTimeout(driverTimer);
    deadline.abort(Error('live_anomaly_cleanup'));
    try {
      await cleanupDriver();
    } catch {
      cleanupSucceeded = false;
    }
    await verifyOwnedProcesses(false);
    try {
      await warm?.close();
    } catch {
      cleanupSucceeded = false;
    }
    for (const release of controls.values()) release();
    if (cancellations.size)
      await Promise.race([Promise.allSettled([...cancellations]), sleep(10000)]);
    if (cancellations.size) cleanupSucceeded = false;
    proxy?.stop(true);
    clearTimeout(timeout);
    let facts: unknown;
    try {
      facts = readFacts();
      writeEvidence('final-facts.json', facts);
    } catch (error) {
      failures.push(safeCode(error));
      cleanupSucceeded = false;
    }
    passed = passed && cleanupSucceeded && !budgetReached && calls.length > 0;
    writeFileSync(
      options.output,
      JSON.stringify(
        {
          status: passed ? 'passed' : 'failed',
          stage,
          sourceCommit: codeEvidence.head,
          codeEvidence,
          model: modelMetadata,
          evidence,
          profile: profile.profilePath,
          budget: {
            requestLimit: 20,
            timeoutMs: 600000,
            actualRequests: calls.length,
            budgetReached,
          },
          cleanupSucceeded,
          provider: { calls, counts },
          failures,
          usage: {
            note: 'Provider stream is forwarded unchanged; use canonical Model Execution usage, missing attempts remain unknown.',
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  return passed;
}

if (import.meta.main) {
  const output = process.argv
      .slice(2)
      .find((arg) => arg.startsWith('--output='))
      ?.slice(9),
    checkpoint = process.argv
      .slice(2)
      .find((arg) => arg.startsWith('--checkpoint='))
      ?.slice(13);
  check(output, 'live_anomaly_output_required');
  if (!(await runLiveSessionAnomalies({ output, ...(checkpoint ? { checkpoint } : {}) })))
    process.exitCode = 1;
}
