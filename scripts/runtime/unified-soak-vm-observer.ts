/** Pure reader of the private Darwin import observer protocol; never a resource qualification. */
export const VM_OBSERVER_SCOPE = 'after-constructor POSIX VM imports, not live blocks or whole VM';
const U64 = (1n << 64n) - 1n;
const keys = [
  'kind',
  'pid',
  'thread',
  'threadError',
  'startedTicks',
  'completedTicks',
  'protection',
  'flags',
  'offset',
  'address',
  'length',
  'arg',
  'result',
  'errno',
  'frames',
  'sequence',
  'frameLimit',
];
export interface VmFrame {
  pc: string;
  base: string;
  symbolAddress: string;
  image: string | null;
  symbol: string | null;
}
export interface VmEvent {
  kind: 'mmap' | 'munmap' | 'madvise' | 'mark';
  pid: number;
  thread: string;
  threadError: number;
  startedTicks: string;
  completedTicks: string;
  protection: number;
  flags: number;
  offset: string;
  requestedAddress?: string;
  address: string;
  length: string;
  arg: number;
  result: number;
  errno: number;
  frames: VmFrame[];
  sequence: string;
  frameLimit: number;
}
export interface VmBegin {
  kind: 'begin';
  version: 1 | 2;
  pid: number;
  birthSeconds: string;
  birthMicroseconds: string;
  birthBytes: 136;
  birthExpected: 136;
  timeNumer: number;
  timeDenom: number;
  timeError: 0;
  scope: typeof VM_OBSERVER_SCOPE;
}
export interface VmFinish {
  kind: 'finish';
  pid: number;
  events: string;
  writeErrors: string;
  nestedCalls: string;
}
export interface VmTrace {
  begin: VmBegin;
  events: VmEvent[];
  finish: VmFinish;
}
export interface VmTraceLimits {
  maxBytes?: number;
  maxEvents?: number;
  maxRecordBytes?: number;
}
function fail(): never {
  throw Error('vm_observer_trace_invalid');
}
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== fields.length || fields.some((key) => !Object.hasOwn(row, key)))
    fail();
  return row;
}
function integer(value: unknown, min = -2147483648, max = 2147483647): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    fail();
  return value;
}
function decimal(value: unknown, signed = false): bigint {
  if (
    typeof value !== 'string' ||
    !(signed ? /^(0|-?[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(value) ||
    value.length > 20
  )
    fail();
  const parsed = BigInt(value);
  if (signed ? parsed < -(1n << 63n) || parsed > (1n << 63n) - 1n : parsed > U64) fail();
  return parsed;
}
function hex(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(0|[1-9a-f][0-9a-f]*)$/.test(value) || value.length > 18)
    fail();
  return BigInt(value);
}
function text(value: unknown, nullable = false): void {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !value || value.length > 4096) fail();
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail();
    } else if (n >= 0xdc00 && n <= 0xdfff) fail();
  }
}
/** JSON.parse alone accepts duplicate fields. Check its bounded grammar before decoding. */
function parseRecord(source: string): unknown {
  let offset = 0;
  const space = () => {
    while (/\s/.test(source[offset] ?? '') && offset < source.length) offset++;
  };
  const string = (): string => {
    const start = offset++;
    let escaped = false;
    for (; offset < source.length; offset++) {
      const char = source[offset];
      if (!escaped && char === '"') {
        offset++;
        const value = JSON.parse(source.slice(start, offset));
        text(value);
        return value;
      }
      if (!escaped && char === '\\') escaped = true;
      else escaped = false;
    }
    return fail();
  };
  const value = (depth: number): void => {
    if (depth > 8) fail();
    space();
    const c = source[offset];
    if (c === '"') {
      string();
      return;
    }
    if (c === '{' || c === '[') {
      offset++;
      space();
      const end = c === '{' ? '}' : ']';
      const seen = new Set<string>();
      if (source[offset] === end) {
        offset++;
        return;
      }
      for (;;) {
        if (c === '{') {
          if (source[offset] !== '"') fail();
          const key = string();
          if (seen.has(key)) fail();
          seen.add(key);
          space();
          if (source[offset++] !== ':') fail();
        }
        value(depth + 1);
        space();
        const next = source[offset++];
        if (next === end) return;
        if (next !== ',') fail();
        space();
      }
    }
    const token = source.slice(offset).match(/^(?:null|true|false|-?(?:0|[1-9][0-9]*))/)?.[0];
    if (!token) fail();
    offset += token.length;
  };
  value(0);
  space();
  if (offset !== source.length) fail();
  try {
    return JSON.parse(source);
  } catch {
    return fail();
  }
}
function bound(value: number | undefined, fallback: number, max: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max)
    throw Error('vm_observer_limit_invalid');
  return limit;
}
export function decodeVmObserverTrace(input: Uint8Array, limits: VmTraceLimits = {}): VmTrace {
  const maxBytes = bound(limits.maxBytes, 256 * 1024 * 1024, 1024 * 1024 * 1024),
    maxEvents = bound(limits.maxEvents, 100000, 1000000),
    maxRecord = bound(limits.maxRecordBytes, 16384, 16384);
  if (
    !(input instanceof Uint8Array) ||
    input.byteLength > maxBytes ||
    input.length === 0 ||
    input[input.length - 1] !== 10
  )
    fail();
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
  } catch {
    return fail();
  }
  const lines = source.split('\n');
  lines.pop();
  if (lines.length < 2 || lines.length > maxEvents + 2) fail();
  const decoded = lines.map((line) => {
    if (!line || new TextEncoder().encode(line).length >= maxRecord) fail();
    return parseRecord(line);
  });
  const begin = object(decoded[0], [
    'kind',
    'version',
    'pid',
    'birthSeconds',
    'birthMicroseconds',
    'birthBytes',
    'birthExpected',
    'timeNumer',
    'timeDenom',
    'timeError',
    'scope',
  ]);
  integer(begin.pid, 1);
  if (
    begin.kind !== 'begin' ||
    (begin.version !== 1 && begin.version !== 2) ||
    decimal(begin.birthSeconds) === 0n ||
    decimal(begin.birthMicroseconds) >= 1000000n ||
    begin.birthBytes !== 136 ||
    begin.birthExpected !== 136 ||
    begin.timeError !== 0 ||
    begin.scope !== VM_OBSERVER_SCOPE
  )
    fail();
  integer(begin.timeNumer, 1, 4294967295);
  integer(begin.timeDenom, 1, 4294967295);
  const finish = object(decoded.at(-1), ['kind', 'pid', 'events', 'writeErrors', 'nestedCalls']);
  if (
    finish.kind !== 'finish' ||
    finish.pid !== begin.pid ||
    decimal(finish.events) !== BigInt(decoded.length - 2) ||
    decimal(finish.writeErrors) !== 0n
  )
    fail();
  decimal(finish.nestedCalls);
  const threadEnds = new Map<string, bigint>();
  const events = decoded.slice(1, -1).map((value, index) => {
    const row = object(value, begin.version === 1 ? keys : [...keys, 'requestedAddress']);
    if (begin.version === 2) {
      const requested = hex(row.requestedAddress);
      if (row.kind !== 'mmap' && requested !== 0n) fail();
    }
    if (
      !['mmap', 'munmap', 'madvise', 'mark'].includes(String(row.kind)) ||
      row.pid !== begin.pid ||
      decimal(row.sequence) !== BigInt(index) ||
      row.threadError !== 0 ||
      decimal(row.thread) === 0n ||
      row.frameLimit !== 24
    )
      fail();
    const started = decimal(row.startedTicks),
      completed = decimal(row.completedTicks);
    if (started > completed || (threadEnds.get(row.thread as string) ?? 0n) > started) fail();
    threadEnds.set(row.thread as string, completed);
    integer(row.protection);
    integer(row.flags);
    integer(row.arg);
    integer(row.result, -1, 0);
    integer(row.errno, 0);
    const address = hex(row.address),
      length = decimal(row.length);
    decimal(row.offset, true);
    if (row.result === 0 ? row.errno !== 0 : row.errno === 0) fail();
    if (row.kind === 'mark') {
      if (
        address !== 0n ||
        length !== 0n ||
        row.result !== 0 ||
        row.protection !== 0 ||
        row.flags !== 0 ||
        row.offset !== '0'
      )
        fail();
    } else {
      if (row.kind === 'mmap' && row.result === -1 && address !== U64) fail();
      if (row.result === 0 && (length === 0n || address + length > 1n << 64n)) fail();
      if (
        row.kind !== 'mmap' &&
        (row.protection !== 0 ||
          row.flags !== 0 ||
          row.offset !== '0' ||
          (row.kind === 'munmap' && row.arg !== 0))
      )
        fail();
    }
    if (!Array.isArray(row.frames) || row.frames.length > 24) fail();
    for (const item of row.frames) {
      const frame = object(item, ['pc', 'base', 'symbolAddress', 'image', 'symbol']);
      const pc = hex(frame.pc),
        base = hex(frame.base),
        symbol = hex(frame.symbolAddress);
      text(frame.image, true);
      text(frame.symbol, true);
      if (
        pc === 0n ||
        base > pc ||
        (symbol !== 0n && (symbol < base || symbol > pc)) ||
        (frame.image === null ? base !== 0n : base === 0n) ||
        (frame.symbol === null ? symbol !== 0n : symbol === 0n)
      )
        fail();
    }
    return row as unknown as VmEvent;
  });
  return { begin: begin as unknown as VmBegin, events, finish: finish as unknown as VmFinish };
}
const range = (event: VmEvent) => ({
  start: BigInt(event.address),
  end: BigInt(event.address) + BigInt(event.length),
});
/** Coverage means observed syscall intersections, never current mappings or live/freed blocks. */
export function analyzeVmObserverTrace(trace: VmTrace, comparisonLimit = 2000000) {
  bound(comparisonLimit, 2000000, 100000000);
  let comparisons = 0;
  // Charge actual index construction, sorting, visits and emitted-interval work.
  // Dense overlap remains bounded; disjoint addresses need no Cartesian scan.
  const work = () => {
    if (++comparisons > comparisonLimit) throw Error('vm_observer_analysis_limit');
  };
  type Change = ReturnType<typeof range> & {
    event: VmEvent;
    index: number;
    started: bigint;
    completed: bigint;
  };
  type Node = {
    change: Change;
    left?: Node;
    right?: Node;
    minStart: bigint;
    maxEnd: bigint;
    maxCompleted: bigint;
  };
  const mappings: Change[] = [];
  const unmaps: Change[] = [];
  const count = { mmap: 0, munmap: 0, madvise: 0, mark: 0 };
  const callsites = new Map<
    string,
    {
      kind: string;
      thread: string;
      image: string | null;
      pcRelative: string | null;
      calls: number;
      requestedBytes: string;
    }
  >();
  for (const event of trace.events) {
    work();
    if (event.result === 0 && (event.kind === 'mmap' || event.kind === 'munmap')) {
      const change: Change = {
        ...range(event),
        event,
        index: mappings.length + unmaps.length,
        started: BigInt(event.startedTicks),
        completed: BigInt(event.completedTicks),
      };
      if (event.kind === 'mmap') mappings.push(change);
      else unmaps.push(change);
    }
    count[event.kind]++;
    const frame = event.frames[2] ?? null;
    const relative =
      frame && frame.image !== null
        ? `0x${(BigInt(frame.pc) - BigInt(frame.base)).toString(16)}`
        : null;
    const key = JSON.stringify([event.kind, event.thread, frame?.image ?? null, relative]);
    const group = callsites.get(key) ?? {
      kind: event.kind,
      thread: event.thread,
      image: frame?.image ?? null,
      pcRelative: relative,
      calls: 0,
      requestedBytes: '0',
    };
    group.calls++;
    group.requestedBytes = String(BigInt(group.requestedBytes) + BigInt(event.length));
    callsites.set(key, group);
  }
  const index = (changes: Change[]): Node | undefined => {
    changes.sort((a, b) => {
      work();
      return a.start < b.start ? -1 : a.start > b.start ? 1 : a.index - b.index;
    });
    const build = (start: number, end: number): Node | undefined => {
      if (start === end) return;
      work();
      const middle = start + Math.floor((end - start) / 2);
      const change = changes[middle]!;
      const left = build(start, middle);
      const right = build(middle + 1, end);
      let maxEnd = change.end;
      let maxCompleted = change.completed;
      for (const child of [left, right]) {
        if (child && child.maxEnd > maxEnd) maxEnd = child.maxEnd;
        if (child && child.maxCompleted > maxCompleted) maxCompleted = child.maxCompleted;
      }
      return { change, left, right, minStart: changes[start]!.start, maxEnd, maxCompleted };
    };
    return build(0, changes.length);
  };
  // Remaps only set a boolean. Keep them separate so the first exact match
  // terminates that query; every qualifying unmap row still has to be emitted.
  const mappingIndex = index([...mappings]);
  const unmapIndex = index(unmaps);
  const mappingIntersections = mappings.map((original) => {
    work();
    const map = original.event;
    const intersections: {
      sequence: string;
      address: string;
      length: string;
      start: string;
      end: string;
      startedTicks: string;
      completedTicks: string;
      ordering: 'after' | 'ambiguous';
    }[] = [];
    const matches: Change[] = [];
    const visit = (node: Node | undefined, firstOnly: boolean): boolean => {
      if (!node) return false;
      work();
      if (
        node.minStart >= original.end ||
        node.maxEnd <= original.start ||
        node.maxCompleted <= original.started
      )
        return false;
      const change = node.change;
      if (
        change.event !== map &&
        change.start < original.end &&
        original.start < change.end &&
        change.completed > original.started
      ) {
        work();
        if (firstOnly) return true;
        matches.push(change);
      }
      return visit(node.left, firstOnly) || visit(node.right, firstOnly);
    };
    let ambiguous = visit(mappingIndex, true);
    visit(unmapIndex, false);
    // Address traversal must not reorder the original trace's intersection rows.
    matches.sort((a, b) => {
      work();
      return a.index - b.index;
    });
    for (const candidate of matches) {
      work();
      const change = candidate.event;
      const start = original.start > candidate.start ? original.start : candidate.start;
      const end = original.end < candidate.end ? original.end : candidate.end;
      const after = original.completed <= candidate.started;
      if (!after) ambiguous = true;
      intersections.push({
        sequence: change.sequence,
        address: change.address,
        length: change.length,
        start: `0x${start.toString(16)}`,
        end: `0x${end.toString(16)}`,
        startedTicks: change.startedTicks,
        completedTicks: change.completedTicks,
        ordering: after ? 'after' : 'ambiguous',
      });
    }
    const intervals = intersections
      .filter((item) => item.ordering === 'after')
      .map((item) => {
        work();
        return { start: BigInt(item.start), end: BigInt(item.end) };
      })
      .sort((a, b) => {
        work();
        return a.start < b.start ? -1 : a.start > b.start ? 1 : 0;
      });
    const covered: typeof intervals = [];
    for (const interval of intervals) {
      work();
      const last = covered.at(-1);
      if (last && interval.start <= last.end) {
        if (interval.end > last.end) last.end = interval.end;
      } else covered.push({ ...interval });
    }
    const coveredBytes = covered.reduce((sum, interval) => sum + interval.end - interval.start, 0n);
    return {
      sequence: map.sequence,
      address: map.address,
      requestedAddress: map.requestedAddress ?? null,
      length: map.length,
      startedTicks: map.startedTicks,
      completedTicks: map.completedTicks,
      tagCategory: map.arg >>> 24 === 240 ? 'tag_240' : 'other_or_unassigned',
      intersections,
      coveredIntervals: covered.map((item) => ({
        start: `0x${item.start.toString(16)}`,
        end: `0x${item.end.toString(16)}`,
      })),
      coveredBytes: String(coveredBytes),
      coverage: ambiguous
        ? 'unknown'
        : coveredBytes === 0n
          ? 'none'
          : coveredBytes === BigInt(map.length)
            ? 'full_observed_intersection'
            : 'partial_observed_intersection',
    };
  });
  return {
    scope: VM_OBSERVER_SCOPE,
    mmapArgumentCoverage: trace.begin.version === 1 ? 'returned_ranges_only' : 'request_and_return',
    identity: {
      pid: trace.begin.pid,
      birthSeconds: trace.begin.birthSeconds,
      birthMicroseconds: trace.begin.birthMicroseconds,
    },
    timeScale: { numer: trace.begin.timeNumer, denom: trace.begin.timeDenom },
    count,
    events: trace.events.map((event) => ({
      ...event,
      requestedAddress: event.requestedAddress ?? null,
    })),
    callsites: [...callsites.values()],
    mappingIntersections,
    nestedCalls: trace.finish.nestedCalls,
    completeProcess: false,
    completeResources: false,
    formalQualified: false,
    liveAllocations: null,
    businessOwner: null,
  };
}
