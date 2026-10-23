import { isDeepStrictEqual } from 'node:util';
import type { ToolResult } from '../../extensions';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
const integer = (value: unknown, minimum = 0): value is number =>
  Number.isSafeInteger(value) && Number(value) >= minimum;
const nullableInteger = (value: unknown, minimum = 1) => value === null || integer(value, minimum);
const nullableString = (value: unknown) => value === null || typeof value === 'string';
const keys = (value: ObjectValue, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const quote = (value: unknown) => JSON.stringify(value);
function json(content: string): ObjectValue | undefined {
  try {
    return object(JSON.parse(content));
  } catch {
    return;
  }
}
function supportedResult(result: ToolResult) {
  const value = object(result);
  return (
    !!value &&
    keys(value, ['outcome', 'content', 'artifactRefs', 'modelContent']) &&
    result.outcome === 'succeeded' &&
    (result.artifactRefs === undefined ||
      (!!result.modelContent &&
        Array.isArray(result.artifactRefs) &&
        result.artifactRefs.length === 1 &&
        isDeepStrictEqual(result.artifactRefs[0], result.modelContent.reference)))
  );
}
function baseline(value: unknown): value is ObjectValue {
  const item = object(value);
  return (
    !!item &&
    keys(item, ['hash', 'size', 'device', 'inode']) &&
    typeof item.hash === 'string' &&
    /^[a-f0-9]{64}$/.test(item.hash) &&
    integer(item.size) &&
    typeof item.device === 'string' &&
    !!item.device &&
    typeof item.inode === 'string' &&
    !!item.inode
  );
}
function knownObservation(value: unknown, kind: 'inspection' | 'lookup'): boolean {
  if (value === undefined) return true;
  const observation = object(value);
  if (
    !observation ||
    observation.kind !== kind ||
    !keys(
      observation,
      kind === 'inspection'
        ? ['kind', 'scope', 'sources', 'complete', 'coverage', 'windowComplete', 'excerpt']
        : [
            'kind',
            'scope',
            'query',
            'sources',
            'matchCount',
            'matchUnit',
            'complete',
            'coverage',
            'next',
          ],
    ) ||
    typeof observation.scope !== 'string' ||
    typeof observation.complete !== 'boolean' ||
    !['file', 'window', 'page'].includes(String(observation.coverage)) ||
    !Array.isArray(observation.sources)
  )
    return false;
  if (
    !observation.sources.every((value) => {
      const source = object(value);
      return (
        source &&
        keys(source, ['path', 'version', 'fromLine', 'toLine']) &&
        typeof source.path === 'string' &&
        typeof source.version === 'string' &&
        (source.fromLine === undefined || integer(source.fromLine, 1)) &&
        (source.toLine === undefined || integer(source.toLine, 1))
      );
    })
  )
    return false;
  if (kind === 'lookup')
    return (
      typeof observation.query === 'string' &&
      integer(observation.matchCount) &&
      (observation.matchUnit === undefined ||
        ['files', 'lines'].includes(String(observation.matchUnit))) &&
      nullableString(observation.next)
    );
  const excerpt = observation.excerpt === undefined ? undefined : object(observation.excerpt);
  return (
    typeof observation.windowComplete === 'boolean' &&
    (observation.excerpt === undefined ||
      (!!excerpt &&
        keys(excerpt, ['text', 'truncated']) &&
        typeof excerpt.text === 'string' &&
        typeof excerpt.truncated === 'boolean'))
  );
}
function countLines(content: string) {
  if (!content) return 0;
  let lines = 1;
  for (let at = content.indexOf('\n'); at >= 0; at = content.indexOf('\n', at + 1)) lines++;
  return lines - Number(content.endsWith('\n'));
}
function artifact(result: ToolResult, value: ObjectValue, format: string, body?: string) {
  const descriptor = object(value.body);
  return (
    result.modelContent?.kind === 'artifact' &&
    result.modelContent.encoding === 'utf-8' &&
    typeof body === 'string' &&
    value.inlineBody === false &&
    descriptor?.complete === true &&
    descriptor.encoding === 'utf-8' &&
    descriptor.format === format
  );
}

/** Display only: original receipts, source observations and complete Artifact bodies stay owned by Core. */
export function formatFileReadResult({
  result,
  body,
}: {
  readonly result: ToolResult;
  readonly body?: string;
}): string | undefined {
  if (!supportedResult(result)) return;
  const value = json(result.content);
  if (
    !value ||
    !keys(value, [
      'path',
      'content',
      'baseline',
      'selection',
      'executionId',
      'runId',
      'observation',
      'body',
      'inlineBody',
    ]) ||
    typeof value.path !== 'string' ||
    !baseline(value.baseline) ||
    !knownObservation(value.observation, 'inspection')
  )
    return;
  const content = result.modelContent
    ? artifact(result, value, 'file_text', body)
      ? body
      : undefined
    : body === undefined &&
        value.body === undefined &&
        value.inlineBody === undefined &&
        typeof value.content === 'string'
      ? value.content
      : undefined;
  if (content === undefined) return;
  const selected = object(value.selection);
  if (
    !selected ||
    !keys(selected, ['fromLine', 'toLine', 'totalLines', 'nextOffset']) ||
    !integer(selected.fromLine, 1) ||
    !integer(selected.totalLines) ||
    !nullableInteger(selected.toLine) ||
    !nullableInteger(selected.nextOffset) ||
    (typeof selected.toLine === 'number' &&
      (selected.toLine < selected.fromLine || selected.toLine > selected.totalLines))
  )
    return;
  const returnedLines = countLines(content);
  if (
    selected.toLine === null
      ? content !== '' || selected.fromLine <= selected.totalLines
      : selected.toLine - selected.fromLine + 1 !== returnedLines
  )
    return;
  if (
    selected.nextOffset !== null &&
    (selected.toLine === null ||
      selected.nextOffset !== selected.toLine + 1 ||
      selected.nextOffset > selected.totalLines)
  )
    return;
  const whole =
    selected.fromLine === 1 &&
    selected.nextOffset === null &&
    (selected.toLine === selected.totalLines || selected.totalLines === 0);
  return (
    `Read ${quote(value.path)}; from_line=${selected.fromLine}; lines=${selected.toLine === null ? 'none' : `${selected.fromLine}-${selected.toLine}`}/${selected.totalLines}; next_line=${selected.nextOffset}; ${whole ? 'complete file' : 'selected window only'}.\n` +
    `baseline=${quote(value.baseline)}\nContent (${Buffer.byteLength(content)} UTF-8 bytes; starts on next line):\n${content}`
  );
}

type SearchLine = { line: number; content: string; truncated?: true; originalLength?: number };
function line(value: unknown): boolean {
  const item = object(value);
  return (
    !!item &&
    integer(item.line, 1) &&
    typeof item.content === 'string' &&
    !item.content.includes('\n') &&
    (item.truncated === undefined || item.truncated === true) &&
    (item.truncated === true
      ? integer(item.originalLength, item.content.length + 1)
      : item.originalLength === undefined)
  );
}
function showLine(item: SearchLine, kind: string) {
  return `${item.line} [${kind}${item.truncated ? `; truncated ${item.content.length}/${item.originalLength} UTF-16 chars` : ''}] ${item.content}`;
}

export function formatFileSearchResult({
  result,
  body,
}: {
  readonly result: ToolResult;
  readonly body?: string;
}): string | undefined {
  if (!supportedResult(result)) return;
  const summary = json(result.content);
  const value = result.modelContent
    ? summary &&
      keys(summary, ['kind', 'observation', 'body', 'inlineBody']) &&
      summary.kind === 'search' &&
      artifact(result, summary, 'json', body)
      ? json(body!)
      : undefined
    : body === undefined
      ? summary
      : undefined;
  if (
    !value ||
    !keys(value, [
      'query',
      'stats',
      'files',
      'feedback',
      'matches',
      'next',
      'scope',
      'observation',
    ]) ||
    !knownObservation(value.observation, 'lookup')
  )
    return;
  const query = object(value.query);
  const stats = object(value.stats);
  if (
    !query ||
    !keys(query, [
      'mode',
      'path',
      'text',
      'glob',
      'respectIgnore',
      'after',
      'limit',
      'contextLines',
      'maxLineChars',
    ]) ||
    (query.mode !== undefined && query.mode !== 'files' && query.mode !== 'content') ||
    typeof query.path !== 'string' ||
    typeof query.text !== 'string' ||
    !nullableString(query.glob) ||
    !nullableString(query.after) ||
    typeof query.respectIgnore !== 'boolean' ||
    !nullableInteger(query.limit) ||
    !integer(query.contextLines) ||
    !nullableInteger(query.maxLineChars) ||
    !stats ||
    !keys(stats, [
      'checkedTextFiles',
      'matchedFiles',
      'matches',
      'returnedMatches',
      'returnedFiles',
    ]) ||
    ![
      'checkedTextFiles',
      'matchedFiles',
      ...(query.mode === 'files' ? ['returnedFiles'] : ['matches', 'returnedMatches']),
    ].every((key) => integer(stats[key])) ||
    !Array.isArray(value.matches) ||
    !Array.isArray(value.files) ||
    !nullableString(value.next) ||
    (query.mode === 'files'
      ? stats.returnedFiles !== (Array.isArray(value.files) ? value.files.length : -1) ||
        value.matches.length !== 0 ||
        stats.matches !== undefined ||
        stats.returnedMatches !== undefined
      : stats.returnedMatches !== value.matches.length || stats.returnedFiles !== undefined) ||
    (value.feedback !== undefined && typeof value.feedback !== 'string')
  )
    return;
  const observed = object(value.observation);
  if (
    observed &&
    observed.matchUnit !== undefined &&
    (observed.matchUnit !== (query.mode === 'files' ? 'files' : 'lines') ||
      observed.matchCount !== (query.mode === 'files' ? value.files.length : value.matches.length))
  )
    return;
  const queryText = query.text;
  const files = new Map<string, ObjectValue>();
  for (const item of value.files) {
    const file = object(item);
    if (
      !file ||
      !keys(file, ['path', 'baseline', ...(query.mode === 'files' ? ['firstMatchLine'] : [])]) ||
      typeof file.path !== 'string' ||
      !baseline(file.baseline) ||
      (query.mode === 'files' && !integer(file.firstMatchLine, 1)) ||
      files.has(file.path)
    )
      return;
    files.set(file.path, file.baseline);
  }
  const groups = new Map<string, string[]>();
  for (const item of value.matches) {
    const match = object(item);
    if (
      !match ||
      !keys(match, ['path', 'line', 'content', 'truncated', 'originalLength', 'before', 'after']) ||
      typeof match.path !== 'string' ||
      !files.has(match.path) ||
      !line(match)
    )
      return;
    const lines = groups.get(match.path) ?? [];
    for (const side of ['before', 'after'] as const) {
      if (
        match[side] !== undefined &&
        (!Array.isArray(match[side]) ||
          !match[side].every(
            (value) =>
              line(value) &&
              keys(object(value)!, ['line', 'content', 'truncated', 'originalLength']),
          ))
      )
        return;
    }
    lines.push(
      ...((match.before as SearchLine[] | undefined) ?? []).map((item) =>
        showLine(item, 'context'),
      ),
      showLine(match as unknown as SearchLine, 'match'),
      ...((match.after as SearchLine[] | undefined) ?? []).map((item) => showLine(item, 'context')),
    );
    groups.set(match.path, lines);
  }
  if (query.mode === 'files') {
    for (const item of value.files) {
      const file = object(item)!;
      groups.set(String(file.path), [`first_match_line=${file.firstMatchLine}; body not returned`]);
    }
  }
  if (groups.size !== files.size) return;
  const scope = value.scope === undefined ? undefined : object(value.scope);
  const skipped = scope && object(scope.skipped);
  if (
    value.scope !== undefined &&
    (!scope ||
      !keys(scope, ['kind', 'complete', 'skipped', 'samples', 'filters']) ||
      scope.kind !== 'current_page' ||
      typeof scope.complete !== 'boolean' ||
      !skipped ||
      !keys(skipped, ['binary', 'encoding', 'ignored', 'links']) ||
      !['binary', 'encoding', 'ignored', 'links'].every((key) => integer(skipped[key])) ||
      !Array.isArray(scope.samples) ||
      !scope.samples.every((item) => {
        const sample = object(item);
        return (
          !!sample &&
          keys(sample, ['path', 'reason']) &&
          typeof sample.path === 'string' &&
          typeof sample.reason === 'string'
        );
      }) ||
      !object(scope.filters) ||
      !keys(object(scope.filters)!, ['glob', 'respectIgnore']) ||
      object(scope.filters)?.glob !== query.glob ||
      object(scope.filters)?.respectIgnore !== query.respectIgnore)
  )
    return;
  const reasons = [
    query.after !== null && 'continuation page',
    value.next !== null && 'later matches remain',
    skipped &&
      Object.values(skipped).some((count) => Number(count) > 0) &&
      'some entries not inspected',
  ];
  if (scope?.complete === false && !reasons.some(Boolean)) return;
  const knownFeedback = [
    'This is literal text matching in the selected scope and filters. Even a complete scan does not prove call reachability, absence of other implementations, or absence of differently worded references.',
    ...(['|', '.*', '\\b'].some((marker) => queryText.includes(marker))
      ? [
          'The query contains pattern-like text (|, .* or \\b), but these characters are matched literally, not as OR, wildcards or word boundaries. Use separate literal queries when testing alternatives.',
        ]
      : []),
    ...((query.mode === 'files' ? files.size : value.matches.length) === 0
      ? [
          'No literal match was found in the checked scope; this does not establish which implementation is active. Check the entry point/configuration or change the query or scope.',
        ]
      : []),
    ...(value.next !== null
      ? [
          'More matches remain. Continue with next using the same query and filters; this page is not the complete search.',
        ]
      : []),
    ...(skipped && Object.values(skipped).some((count) => Number(count) > 0)
      ? ['Some scope was not inspected; consult scope.skipped and samples before claiming absence.']
      : []),
  ].join(' ');
  if (value.feedback !== undefined && value.feedback !== knownFeedback) return;
  const output = [
    `Search literal ${quote(query.text)}; mode=${query.mode ?? 'content'} in ${quote(query.path || '.')}; glob=${quote(query.glob)}; ignore=${query.respectIgnore ? 'on' : 'off'}; limit=${query.limit}; context_lines=${query.contextLines}; max_line_chars=${query.maxLineChars}.`,
    `Returned ${query.mode === 'files' ? `${files.size} files` : `${value.matches.length} matches`}; checked ${stats.checkedTextFiles} text files. ${reasons.some(Boolean) ? `Incomplete search: ${reasons.filter(Boolean).join('; ')}.` : 'Complete search within selected scope and filters.'}`,
    `next_cursor=${quote(value.next)}`,
  ];
  if (skipped && Object.values(skipped).some((count) => Number(count) > 0)) {
    output.push(`Skipped entries (directories count once): ${quote(skipped)}`);
    if ((scope!.samples as unknown[]).length)
      output.push(`Skipped samples: ${quote(scope!.samples)}`);
  }
  if (['|', '.*', '\\b'].some((marker) => queryText.includes(marker)))
    output.push('Pattern-like characters are literal; use separate queries for alternatives.');
  if (!(query.mode === 'files' ? files.size : value.matches.length))
    output.push(
      'No literal matches in checked files; this does not determine the active implementation.',
    );
  for (const [path, lines] of groups)
    output.push(`File ${quote(path)}; baseline=${quote(files.get(path))}`, ...lines);
  return output.join('\n');
}
