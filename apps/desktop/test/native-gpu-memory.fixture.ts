import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { CDPSession } from 'playwright';

type Row = Record<string, unknown>;
type Completion = { stream?: string; dataLossOccurred?: boolean; traceFormat?: string };
const record = (value: unknown): Row | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : undefined;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Chromium scalar values in memory dumps are hexadecimal strings, not decimal byte strings. */
function scalarBytes(value: unknown): number | null {
  const attr = record(value);
  if (attr?.units !== 'bytes' || attr.type !== 'scalar') return null;
  const raw = attr.value;
  if (typeof raw !== 'string' || !/^(?:0x)?[\da-f]+$/i.test(raw)) return null;
  const bytes = Number(BigInt(raw.startsWith('0x') ? raw : `0x${raw}`));
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

function sameGuid(value: unknown, expected: string): boolean {
  if (typeof value !== 'string') return false;
  return (
    value.replace(/^0x/, '').replace(/^0+/, '').toLowerCase() ===
    expected.replace(/^0x/, '').replace(/^0+/, '').toLowerCase()
  );
}

function associateDump(events: Row[], guid: string) {
  const data = events.filter((event) => record(record(event.args)?.dumps));
  const controls = events.filter((event) =>
    ['GlobalMemoryDump', 'ProcessMemoryDump'].includes(String(event.name)),
  );
  const globalRequests = controls.filter(
    (event) => event.name === 'GlobalMemoryDump' && event.ph === 'b',
  );
  if (
    globalRequests.length > 1 ||
    globalRequests.some((event) => !sameGuid(record(event.args)?.dump_guid, guid))
  )
    throw Error('dump_association_unverified:conflicting_global_requests');
  const direct = data.filter((event) => sameGuid(event.id, guid));
  if (direct.length && direct.length === data.length)
    return {
      method: 'direct-event-id',
      reason: 'Every data event matches the requested GUID.',
      requestedGuid: guid,
      controls,
      selected: direct,
      excluded: [] as Row[],
    };
  const fail = (reason: string): never => {
    throw Error(`dump_association_unverified:${reason}`);
  };
  const globalBegin = controls.filter(
    (event) => event.name === 'GlobalMemoryDump' && event.ph === 'b',
  );
  if (globalBegin.length !== 1) fail('not_exactly_one_global_begin');
  const begin = globalBegin[0]!;
  const args = record(begin.args);
  const local = record(begin.id2)?.local;
  if (
    !sameGuid(args?.dump_guid, guid) ||
    !sameGuid(local, guid) ||
    args?.dump_type !== 'explicitly_triggered' ||
    args.level_of_detail !== 'detailed' ||
    args.success !== true
  )
    fail('global_begin_does_not_prove_requested_dump');
  const globalEnd = controls.filter(
    (event) => event.name === 'GlobalMemoryDump' && event.ph === 'e',
  );
  if (
    globalEnd.length !== 1 ||
    globalEnd[0]!.pid !== begin.pid ||
    !sameGuid(record(globalEnd[0]!.id2)?.local, guid)
  )
    fail('global_end_unmatched');
  const start = begin.ts,
    end = globalEnd[0]!.ts;
  if (typeof start !== 'number' || typeof end !== 'number' || end < start)
    fail('global_interval_invalid');
  const processBegin = controls.filter(
    (event) => event.name === 'ProcessMemoryDump' && event.ph === 'b',
  );
  const processEnd = controls.filter(
    (event) => event.name === 'ProcessMemoryDump' && event.ph === 'e',
  );
  if (!processBegin.length || processBegin.length !== processEnd.length)
    fail('process_scopes_incomplete');
  const pids = new Set<unknown>();
  for (const process of processBegin) {
    if (!sameGuid(record(process.args)?.dump_guid, guid) || pids.has(process.pid))
      fail('ambiguous_process_begin');
    const id = record(process.id2)?.local;
    if (typeof id !== 'string') fail('process_async_id_missing');
    const matches = processEnd.filter(
      (event) => event.pid === process.pid && sameGuid(record(event.id2)?.local, id as string),
    );
    if (
      matches.length !== 1 ||
      typeof process.ts !== 'number' ||
      typeof matches[0]!.ts !== 'number' ||
      process.ts < (start as number) ||
      matches[0]!.ts < process.ts ||
      matches[0]!.ts > (end as number)
    )
      fail('process_scope_unmatched');
    pids.add(process.pid);
  }
  // This Chromium trace exports one zero-ID serialization batch inside the verified global scope.
  // Never associate another timestamp, nonzero ID, background trigger, or unverified process.
  if (
    !data.length ||
    new Set(data.map((event) => event.ts)).size !== 1 ||
    data.some(
      (event) =>
        event.ph !== 'v' ||
        event.name !== 'periodic_interval' ||
        !sameGuid(event.id, '0x0') ||
        typeof event.ts !== 'number' ||
        event.ts < (start as number) ||
        event.ts > (end as number) ||
        record(record(event.args)?.dumps)?.level_of_detail !== 'detailed',
    )
  )
    fail('serialization_batch_ambiguous');
  return {
    method: 'single-explicit-global-scope-and-process-guid',
    reason:
      'One successful explicit detailed global scope matches CDP GUID; one zero-ID serialization timestamp lies inside it. Only PIDs with paired ProcessMemoryDump scopes bearing that GUID are accepted.',
    requestedGuid: guid,
    controls,
    selected: data.filter((event) => pids.has(event.pid)),
    excluded: data
      .filter((event) => !pids.has(event.pid))
      .map((event) => ({
        pid: event.pid,
        id: event.id,
        ts: event.ts,
        reason: 'no_process_scope_for_requested_guid',
      })),
  };
}

/** Test-only, global Chromium dump. No category sizes are added or called physical footprint. */
export async function collectNativeGpuMemory(input: {
  cdp: CDPSession;
  gpuPid: number;
  evidenceDir: string;
  stage: string;
}) {
  const { cdp, gpuPid, evidenceDir, stage } = input;
  if (!/^[\w-]+$/.test(stage) || !Number.isSafeInteger(gpuPid) || gpuPid <= 0)
    throw Error('invalid_gpu_memory_evidence_identity');
  mkdirSync(evidenceDir, { recursive: true });
  const rawPath = join(evidenceDir, `${stage}-gpu-trace.json`);
  const reportPath = join(evidenceDir, `${stage}-gpu-memory.json`);
  const startedAt = Date.now();
  const errors: string[] = [];
  const unknown: string[] = [];
  let categories: string[] = [];
  let started = false;
  let startAttempted = false;
  let endSent = false;
  let completion: Completion | undefined;
  let stream: string | undefined;
  let dump: { success: boolean; dumpGuid: string } | undefined;
  let rawBytes = 0;
  let file: number | undefined;
  let streamReadAttempted = false;
  let completeResolve: ((value: Completion) => void) | undefined;
  const completed = new Promise<Completion>((resolve) => {
    completeResolve = resolve;
  });
  const onComplete = (value: Completion) => {
    completion = value;
    stream = value.stream;
    completeResolve?.(value);
  };
  const timed = async <T>(promise: Promise<T>, label: string, milliseconds = 5000): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error(`${label}_timeout`)), milliseconds);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const saveStream = async () => {
    if (!stream || streamReadAttempted) return;
    streamReadAttempted = true;
    file = openSync(rawPath, 'w');
    const readDeadline = Date.now() + 5000;
    for (;;) {
      if (Date.now() > readDeadline) throw Error('trace_stream_total_timeout');
      const chunk = await timed(
        cdp.send('IO.read', { handle: stream, size: 65536 }),
        'trace_read',
        1500,
      );
      const bytes = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
      rawBytes += bytes.length;
      if (rawBytes > 32 * 1024 * 1024) throw Error('trace_stream_byte_limit');
      writeSync(file, bytes);
      if (chunk.eof) break;
    }
  };
  cdp.on('Tracing.tracingComplete', onComplete);
  try {
    categories = (await timed(cdp.send('Tracing.getCategories'), 'trace_categories')).categories;
    if (!categories.includes('disabled-by-default-memory-infra'))
      throw Error('memory_infra_category_unavailable');
    startAttempted = true;
    // Keep this outside navigation/footprint timing. No periodic dumps or CPU samples.
    await timed(
      cdp
        .send('Tracing.start', {
          transferMode: 'ReturnAsStream',
          streamFormat: 'json',
          streamCompression: 'none',
          traceConfig: {
            recordMode: 'recordUntilFull',
            traceBufferSizeInKb: 8192,
            includedCategories: ['disabled-by-default-memory-infra'],
            excludedCategories: ['*'],
            enableSampling: false,
            enableSystrace: false,
          },
        })
        .then((value) => {
          started = true;
          return value;
        }),
      'trace_start',
    );
    dump = await timed(
      cdp.send('Tracing.requestMemoryDump', {
        deterministic: false,
        levelOfDetail: 'detailed',
      }),
      'global_memory_dump',
    );
    if (!dump.success) errors.push('global_memory_dump_failed');
    endSent = true;
    await timed(cdp.send('Tracing.end'), 'trace_end');
    completion = await timed(completed, 'trace_flush');
    if (completion.dataLossOccurred) errors.push('trace_data_loss');
    if (!stream) throw Error('trace_stream_unavailable');
    await saveStream();
  } catch (error) {
    errors.push(errorText(error));
  } finally {
    // A timed-out start can still complete. An explicit start rejection never owns a trace.
    if ((started || (startAttempted && errors.includes('trace_start_timeout'))) && !endSent) {
      try {
        endSent = true;
        await timed(cdp.send('Tracing.end'), 'cleanup_trace_end', 1500);
      } catch (error) {
        errors.push(errorText(error));
      }
    }
    if (endSent && !completion) {
      try {
        completion = await timed(completed, 'cleanup_trace_flush', 1500);
      } catch (error) {
        errors.push(errorText(error));
      }
    }
    if (stream && !streamReadAttempted) {
      try {
        await saveStream();
      } catch (error) {
        errors.push(errorText(error));
      }
    }
    if (file !== undefined) closeSync(file);
    if (stream) {
      try {
        await timed(cdp.send('IO.close', { handle: stream }), 'trace_io_close', 1500);
      } catch (error) {
        errors.push(errorText(error));
      }
    }
    cdp.removeListener('Tracing.tracingComplete', onComplete);
  }

  const metadata: unknown[] = [];
  const processDumps: unknown[] = [];
  const allocators: unknown[] = [];
  const ownership: unknown[] = [];
  let gpuName: string | null = null;
  let association: ReturnType<typeof associateDump> | undefined;
  if (rawBytes) {
    try {
      const parsed = JSON.parse(readFileSync(rawPath, 'utf8')) as { traceEvents?: unknown[] };
      if (!Array.isArray(parsed.traceEvents)) throw Error('trace_events_unavailable');
      const events = parsed.traceEvents.map(record).filter((event): event is Row => !!event);
      if (!dump?.success) throw Error('successful_requested_dump_missing');
      association = associateDump(events, dump.dumpGuid);
      for (const raw of events) {
        const event = record(raw);
        if (!event) continue;
        const args = record(event.args);
        if (event.ph === 'M' && event.name === 'process_name') {
          metadata.push({ pid: event.pid, args: event.args });
          if (event.pid === gpuPid && typeof args?.name === 'string') gpuName = args.name;
        }
        if (!association.selected.includes(event)) continue;
        const dumps = record(args?.dumps);
        if (!dumps) continue;
        processDumps.push({
          pid: event.pid,
          dumpGuid: event.id,
          process_totals: dumps.process_totals ?? null,
          level_of_detail: dumps.level_of_detail ?? null,
        });
        const nodes = record(dumps.allocators);
        if (nodes)
          for (const [path, value] of Object.entries(nodes)) {
            const category = /(^|\/)(gpu_memory_buffer|gpumemorybuffer|gpu_buffers?)(\/|$)/i.test(
              path,
            )
              ? 'gpu-buffer'
              : /shared[_-]?images?/i.test(path)
                ? 'shared-image'
                : /(^|\/)skia(\/|$)/i.test(path)
                  ? 'skia'
                  : /(^|\/)cc(\/|$)/i.test(path)
                    ? 'compositor'
                    : /(^|\/)gpu(\/|$)/i.test(path)
                      ? 'gpu'
                      : undefined;
            if (!category) continue;
            const node = record(value);
            const attrs = record(node?.attrs);
            allocators.push({
              pid: event.pid,
              dumpGuid: event.id,
              category,
              path,
              guid: node?.guid ?? null,
              sizeBytes: scalarBytes(attrs?.size),
              effectiveSizeBytes: scalarBytes(attrs?.effective_size),
              raw: value,
            });
          }
        if (Array.isArray(dumps.allocators_graph))
          ownership.push({ pid: event.pid, dumpGuid: event.id, edges: dumps.allocators_graph });
      }
      if (!gpuName || !/gpu/i.test(gpuName)) errors.push('gpu_pid_metadata_unverified');
      if (!processDumps.some((value) => record(value)?.pid === gpuPid))
        errors.push('gpu_pid_dump_missing');
    } catch (error) {
      errors.push(errorText(error));
    }
  } else unknown.push('raw_trace_unavailable');
  for (const category of ['gpu', 'skia', 'compositor', 'shared-image', 'gpu-buffer']) {
    if (!allocators.some((value) => record(value)?.category === category))
      unknown.push(`${category}_allocator_category_unavailable`);
  }
  if (!allocators.some((value) => record(value)?.effectiveSizeBytes !== null))
    unknown.push('effective_size_not_exported_requires_ownership_graph_analysis');
  if (!ownership.length) unknown.push('ownership_graph_unavailable');
  const gpuRoot = allocators.find((value) => {
    const row = record(value);
    return row?.pid === gpuPid && row.path === 'gpu';
  });
  if (!gpuRoot || record(gpuRoot)?.sizeBytes === null) unknown.push('gpu_root_size_unavailable');
  const report = {
    allocationOverviewStatus:
      errors.length || !gpuRoot || record(gpuRoot)?.sizeBytes === null
        ? 'unknown'
        : unknown.length
          ? 'partial'
          : 'ok',
    association: association
      ? {
          ...association,
          selected: association.selected.map((event) => ({
            pid: event.pid,
            id: event.id,
            ts: event.ts,
          })),
        }
      : null,
    status: errors.length ? 'unknown' : 'ok',
    stage,
    startedAt,
    finishedAt: Date.now(),
    elapsedMs: Date.now() - startedAt,
    gpuPid,
    gpuName,
    categories,
    dump: dump ?? null,
    completion: completion ?? null,
    rawPath,
    rawBytes,
    errors,
    unknown,
    interpretation:
      'Allocator sizes overlap across paths/processes and are not OS footprint. GPU-process gpu root size is the tracked GPU allocation overview. No sums or computed effective sizes. Missing values are unknown, never zero. Native footprint is collected separately before tracing.',
    gpuRoot: gpuRoot ?? null,
    metadata,
    processDumps,
    allocators,
    ownership,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return { ...report, reportPath };
}
