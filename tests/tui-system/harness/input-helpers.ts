import stringWidth from 'string-width';
import { tuiSystemDelay } from './cancellation';
import type { MockModelServer } from './fixtures';
import type { PtyProcess } from './pty-process';
import { stripAnsi, waitForOutputQuiescence } from './terminal-screen';
import { tuiPollInterval, tuiWaitTimeout } from './timing';

export async function sleep(ms: number): Promise<void> {
  await tuiSystemDelay(ms);
}

const INPUT_SETTLE_MS = 100;
const INPUT_ECHO_TIMEOUT_MS = 2_000;
const INPUT_DELIVERY_ATTEMPTS = 3;
const INPUT_RETRY_LIMIT = 256;
const INPUT_RETRY_BACKSPACE_DELAY_MS = 50;
const INPUT_RETRY_EMPTY_BASELINE_MARGIN = 8;
const INPUT_SUBMIT_ATTEMPTS = 3;
const INPUT_SUBMIT_RECEIPT_TIMEOUT_MS = 1_500;
const SELECTOR_COMMAND_PREFIX = /^\/(?:model|effort|theme)\s$/;

interface InputDeliveryTestTiming {
  /** Harness-unit-test override. PTY scenarios must use production-like defaults. */
  echoTimeoutMs?: number;
  settleMs?: number;
  retryBackspaceDelayMs?: number;
  restoreTimeoutMs?: number;
}

interface TypeTextOptions {
  append?: boolean;
  delayMs?: number;
  testTiming?: InputDeliveryTestTiming;
}

function normalizeInputEcho(text: string): string {
  const clean = stripAnsi(text);
  const leadingWhitespace = clean.match(/^[ \t]+/)?.[0] ?? '';
  // Canonicalize line breaks and repeated whitespace without erasing logical
  // word boundaries. Removing all internal whitespace can falsely acknowledge
  // a PTY delivery that dropped a real space (for example `one hundred`).
  return leadingWhitespace + clean.slice(leadingWhitespace.length).replace(/\s+/g, ' ');
}

export type ActiveInput = {
  kind:
    | 'main'
    | 'session-search'
    | 'slash-query'
    | 'slash-argument-query'
    | 'file-query'
    | 'block-cursor';
  value: string;
};

function currentPromptInput(lines: readonly string[]): string | undefined {
  const promptLines: number[] = [];
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!/^\s*❯(?:\s|$)/.test(lines[index]!)) continue;
    promptLines.push(index);
  }
  // Choice overlays also use `❯` for their selected row. Prefer a prompt whose
  // logical input rows lead directly into InputLine's bottom separator. Keep a
  // last-prompt fallback for lightweight harness fixtures without full chrome.
  const promptLine =
    promptLines.find((index) => {
      const promptPrefix = /^\s*❯\s?/.exec(lines[index]!)?.[0] ?? '❯ ';
      const continuationIndent = ' '.repeat(stringWidth(promptPrefix));
      for (let lineIndex = index + 1; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex]!;
        if (/^[─━═]/u.test(line.trim())) return true;
        if (!line.startsWith(continuationIndent) || line.trim().length === 0) return false;
      }
      return false;
    }) ??
    promptLines[0] ??
    -1;
  if (promptLine < 0) return undefined;

  const promptPrefix = /^\s*❯\s?/.exec(lines[promptLine]!)?.[0] ?? '❯ ';
  const promptWidth = stringWidth(promptPrefix);
  const inputLines = [lines[promptLine]!.slice(promptPrefix.length)];
  let separatorWidth: number | undefined;
  for (let index = promptLine + 1; index < lines.length; index++) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (/^[─━═╭╰┌└]/.test(trimmed) || /^(?:mock-model|\S+\s+·)/.test(trimmed)) {
      if (/^[─━═]+$/.test(trimmed)) separatorWidth = stringWidth(trimmed);
      break;
    }
    const continuationIndent = ' '.repeat(promptWidth);
    inputLines.push(line.startsWith(continuationIndent) ? line.slice(promptWidth) : line);
  }

  const effectiveMaxWidth =
    separatorWidth === undefined ? undefined : Math.max(1, separatorWidth - promptWidth - 1);
  let projection = inputLines[0]!;
  for (let index = 1; index < inputLines.length; index++) {
    const previous = inputLines[index - 1]!;
    const current = inputLines[index]!;
    const firstCurrentChar = Array.from(current)[0];
    const isForcedVisualWrap =
      effectiveMaxWidth !== undefined &&
      firstCurrentChar !== undefined &&
      stringWidth(previous) + stringWidth(firstCurrentChar) > effectiveMaxWidth;
    projection += `${isForcedVisualWrap ? '' : ' '}${current}`;
  }
  return normalizeInputEcho(projection);
}

export function activeInput(viewport: string): ActiveInput | undefined {
  const lines = stripAnsi(viewport).split(/\r?\n/);

  for (const [marker, command] of [
    ['推理深度匹配 "', '/effort '],
    ['主题匹配 "', '/theme '],
  ] as const) {
    const queryLine = lines.find((line) => line.includes(marker));
    if (queryLine) {
      const remainder = queryLine.slice(queryLine.indexOf(marker) + marker.length);
      const partial = remainder.slice(0, Math.max(0, remainder.indexOf('"')));
      return {
        kind: 'slash-argument-query',
        value: normalizeInputEcho(`${command}${partial}`),
      };
    }
  }

  for (const [title, command] of [
    ['推理深度', '/effort '],
    ['主题选项', '/theme '],
  ] as const) {
    if (!lines.some((line) => line.includes(title))) continue;
    const promptInput = currentPromptInput(lines);
    if (promptInput?.startsWith(command)) {
      return { kind: 'slash-argument-query', value: promptInput };
    }
  }

  if (lines.some((line) => line.includes('命令匹配'))) {
    const promptInput = currentPromptInput(lines);
    if (promptInput !== undefined) {
      return { kind: 'slash-query', value: promptInput };
    }
  }

  for (const [marker, kind] of [['文件匹配 ', 'file-query']] as const) {
    const queryLine = lines.find((line) => line.includes(marker));
    if (queryLine) {
      const value = queryLine
        .slice(queryLine.indexOf(marker) + marker.length)
        .replace(/\s+─+\s+\d+\s*\/\s*\d+\s*─+.*$/, '')
        .replace(/\s*│?\s*$/, '')
        .trim();
      return { kind, value: normalizeInputEcho(value) };
    }
  }

  if (lines.some((line) => line.includes('会话列表'))) {
    const searchLine = lines.find((line) => line.includes('搜索:'));
    if (searchLine) {
      const value = searchLine
        .slice(searchLine.indexOf('搜索:') + '搜索:'.length)
        .replace(/\|?\s*│?\s*$/, '')
        .replace(/_$/, '')
        .trim();
      if (value === '—' && !searchLine.slice(0, searchLine.indexOf('搜索:')).includes('❯')) {
        return undefined;
      }
      return { kind: 'session-search', value: normalizeInputEcho(value) };
    }
  }

  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    const cursorIndex = line.indexOf('█');
    if (cursorIndex >= 0) {
      return {
        kind: 'block-cursor',
        value: normalizeInputEcho(line.slice(0, cursorIndex).trim()),
      };
    }
  }

  const promptInput = currentPromptInput(lines);
  return promptInput === undefined ? undefined : { kind: 'main', value: promptInput };
}

export async function activateSessionSearch(tui: PtyProcess, timeoutMs = 5_000): Promise<void> {
  await tui.settleScreen();
  if (activeInput(tui.inputViewport())?.kind === 'session-search') return;
  if (!stripAnsi(tui.viewport()).includes('会话列表')) {
    throw new Error('Cannot activate session search because the session selector is not visible.');
  }

  tui.write('\x1b[A');
  const effectiveTimeout = tuiWaitTimeout(timeoutMs);
  const start = Date.now();
  while (Date.now() - start < effectiveTimeout) {
    await tui.settleScreen();
    const input = activeInput(tui.inputViewport());
    if (input?.kind === 'session-search' && input.value === '') return;
    await sleep(tuiPollInterval(25));
  }
  throw new Error(
    `Timeout (${effectiveTimeout}ms) activating session search. Input viewport:\n${tui.inputViewport().slice(-1_000)}`,
  );
}

async function waitForInputEcho(
  tui: PtyProcess,
  expectedValue: string,
  expectedKind: ActiveInput['kind'] | undefined,
  allowFocusTransfer: boolean,
  timeoutMs: number,
): Promise<void> {
  const effectiveTimeout = tuiWaitTimeout(timeoutMs);
  const start = Date.now();
  let lastInput: ActiveInput | undefined;
  while (Date.now() - start < effectiveTimeout) {
    await tui.settleScreen();
    const current = activeInput(tui.inputViewport());
    lastInput = current;
    if (
      current?.value === expectedValue &&
      (current.kind === expectedKind || (allowFocusTransfer && expectedValue.length > 0))
    ) {
      return;
    }
    await sleep(tuiPollInterval(25));
  }
  throw new Error(
    `Timeout (${effectiveTimeout}ms) waiting for active input value ${JSON.stringify(expectedValue)}; ` +
      `last active input was ${JSON.stringify(lastInput)}. Input viewport:\n${tui.inputViewport().slice(-1_000)}`,
  );
}

async function clearActiveInputTo(
  tui: PtyProcess,
  targetValue: string,
  expectedKind: ActiveInput['kind'] | undefined,
  timing: InputDeliveryTestTiming = {},
): Promise<ActiveInput> {
  const effectiveTimeout = tuiWaitTimeout(timing.restoreTimeoutMs ?? 5_000);
  const start = Date.now();
  let backspaces = 0;
  let lastInput: ActiveInput | undefined;
  let previousValue: string | undefined;
  while (Date.now() - start < effectiveTimeout && backspaces <= INPUT_RETRY_LIMIT) {
    await tui.settleScreen();
    const current = activeInput(tui.inputViewport());
    if (!current) {
      await sleep(tuiPollInterval(25));
      continue;
    }
    lastInput = current;
    if (
      current.kind === 'block-cursor' &&
      targetValue.length === 0 &&
      previousValue !== undefined &&
      current.value.length > previousValue.length
    ) {
      return { ...current, value: '' };
    }
    if (current.value === targetValue) return current;
    if (expectedKind !== undefined && current.kind !== expectedKind && targetValue.length > 0) {
      throw new Error(
        `Input focus changed from ${expectedKind} to ${current.kind} during append retry`,
      );
    }
    if (!current.value.startsWith(targetValue)) {
      throw new Error(
        `Cannot restore active input ${JSON.stringify(current.value)} to baseline ${JSON.stringify(targetValue)}`,
      );
    }
    previousValue = current.value;
    tui.write(current.kind === 'block-cursor' ? '\x08' : '\x7f');
    backspaces++;
    await sleep(timing.retryBackspaceDelayMs ?? INPUT_RETRY_BACKSPACE_DELAY_MS);
  }
  throw new Error(
    `Timeout restoring active input to ${JSON.stringify(targetValue)}; last active input was ${JSON.stringify(lastInput)}. ` +
      `Last terminal output:\n${stripAnsi(tui.transcript()).slice(-1_000)}`,
  );
}

export async function typeText(
  tui: PtyProcess,
  text: string,
  delayOrOptions: number | TypeTextOptions = 40,
): Promise<void> {
  if (text.length === 0) return;
  const options: TypeTextOptions =
    typeof delayOrOptions === 'number' ? { delayMs: delayOrOptions } : delayOrOptions;
  const delayMs = options.delayMs ?? 40;
  await tui.settleScreen();
  let initial = activeInput(tui.inputViewport());
  if (!initial) {
    throw new Error('Cannot type text because no active input field is visible');
  }
  if (!options.append && initial.kind === 'block-cursor') {
    // First-run forms render their configured default as a placeholder even
    // after the logical field has been cleared, so the visible default is not
    // an append baseline. Their scenarios clear the field explicitly first.
    initial = { ...initial, value: '' };
  } else if (!options.append && initial.value.length > 0) {
    initial = await clearActiveInputTo(tui, '', initial.kind, options.testTiming);
  }
  const baselineValue = options.append ? initial.value : '';
  const expectedValue = `${baselineValue}${normalizeInputEcho(text)}`;
  const characters = Array.from(text);
  const attempts = characters.length <= INPUT_RETRY_LIMIT ? INPUT_DELIVERY_ATTEMPTS : 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      let delivered = baselineValue;
      for (const [index, ch] of characters.entries()) {
        tui.write(ch);
        delivered += ch;
        if (delayMs > 0) await sleep(delayMs);
        if (SELECTOR_COMMAND_PREFIX.test(delivered) && index < characters.length - 1) {
          // Ink first commits the command match and only then installs the
          // argument selector's key handlers. On slower CI hosts, sending the
          // first argument character in that gap can make the selector consume
          // the separating space. Treat the focus transfer as part of the
          // retryable PTY delivery transaction.
          await waitForInputEcho(
            tui,
            normalizeInputEcho(delivered),
            'slash-argument-query',
            false,
            options.testTiming?.echoTimeoutMs ?? INPUT_ECHO_TIMEOUT_MS,
          );
        }
      }
      const settleMs = options.testTiming?.settleMs ?? INPUT_SETTLE_MS;
      if (settleMs > 0) await sleep(settleMs);

      // Confirm that Ink rendered the final input value before a following
      // control key is sent. The current VT viewport is authoritative here:
      // raw output retains erased Ink frames and can falsely acknowledge text
      // that is no longer present in the active input line.
      await waitForInputEcho(
        tui,
        expectedValue,
        initial.kind,
        !options.append && baselineValue.length === 0,
        options.testTiming?.echoTimeoutMs ?? INPUT_ECHO_TIMEOUT_MS,
      );
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      if (!options.append && baselineValue.length === 0) {
        // The VT projection trims a whitespace-only input line. Rolling back
        // only until activeInput() looks empty can therefore leave invisible
        // spaces behind, changing the next user message or `/command`. A
        // replacement transaction owns an empty baseline, so it is safe to
        // delete every attempted character plus a bounded stale-whitespace
        // margin even when some bytes were never delivered.
        await clearInput(tui, characters.length + INPUT_RETRY_EMPTY_BASELINE_MARGIN, {
          requireReceipt: false,
          delayMs: options.testTiming?.retryBackspaceDelayMs,
        });
        await tui.settleScreen();
        initial = activeInput(tui.inputViewport()) ?? initial;
        if (initial.value.length > 0) {
          initial = await clearActiveInputTo(tui, '', initial.kind, options.testTiming);
        }
      } else {
        // Append transactions must preserve their legitimate non-empty
        // baseline, so only remove the visible attempted suffix.
        initial = await clearActiveInputTo(tui, baselineValue, initial.kind, options.testTiming);
      }
      const retrySettleMs = options.testTiming?.settleMs ?? INPUT_SETTLE_MS;
      if (retrySettleMs > 0) await sleep(retrySettleMs);
    }
  }

  const tail = stripAnsi(tui.transcript()).slice(-1_000);
  throw new Error(
    `PTY input delivery failed after ${attempts} attempt(s) for ${JSON.stringify(text)}. Last output:\n${tail}`,
    { cause: lastError },
  );
}

/**
 * Deliver one bracketed-paste transaction and require an exact active-input
 * receipt. A PTY may occasionally drop the whole transaction before Ink sees
 * it; retry only while the input is still provably empty. Partial or altered
 * delivery fails closed because replaying could duplicate user content.
 */
export async function pasteText(
  tui: PtyProcess,
  text: string,
  testTiming: Pick<InputDeliveryTestTiming, 'echoTimeoutMs' | 'settleMs'> = {},
): Promise<void> {
  if (text.length === 0) throw new Error('pasteText requires non-empty text');
  await tui.settleScreen();
  const initial = activeInput(tui.inputViewport());
  if (!initial || initial.value.length > 0) {
    throw new Error('pasteText requires a visible empty input field');
  }

  const expectedValue = normalizeInputEcho(text);
  let lastError: unknown;
  for (let attempt = 1; attempt <= INPUT_DELIVERY_ATTEMPTS; attempt++) {
    tui.write(`\x1b[200~${text}\x1b[201~`);
    await sleep(testTiming.settleMs ?? INPUT_SETTLE_MS);
    try {
      await waitForInputEcho(
        tui,
        expectedValue,
        initial.kind,
        false,
        testTiming.echoTimeoutMs ?? INPUT_ECHO_TIMEOUT_MS,
      );
      return;
    } catch (error) {
      lastError = error;
      await tui.settleScreen();
      const current = activeInput(tui.inputViewport());
      if (!current || current.kind !== initial.kind || current.value.length > 0) {
        throw new Error('Bracketed paste produced a partial or altered input; refusing replay', {
          cause: error,
        });
      }
    }
  }

  throw new Error(
    `PTY bracketed-paste delivery failed after ${INPUT_DELIVERY_ATTEMPTS} empty-input attempt(s)`,
    { cause: lastError },
  );
}

/** Type into a masked field whose real value cannot be confirmed from PTY output. */
export async function typeMaskedText(tui: PtyProcess, text: string, delayMs = 40): Promise<void> {
  for (const character of Array.from(text)) {
    tui.write(character);
    await sleep(delayMs);
  }
}

export async function clearInput(
  tui: PtyProcess,
  length: number,
  options: { backspace?: 'delete' | 'ascii'; requireReceipt?: boolean; delayMs?: number } = {},
): Promise<void> {
  if (length <= 0) return;
  const outputMark = tui.markOutput();
  const backspace = options.backspace === 'ascii' ? '\x08' : '\x7f';
  for (let i = 0; i < length; i++) {
    tui.write(backspace);
    const delayMs = options.delayMs ?? 50;
    if (delayMs > 0) await sleep(delayMs);
  }
  await waitForOutputQuiescence(
    () => tui.outputSince(outputMark),
    undefined,
    undefined,
    options.requireReceipt ?? true,
  );
}

export async function waitForRequestMessage(
  server: MockModelServer,
  text: string,
  timeout = 10000,
  options: {
    since: number;
    tui?: PtyProcess;
  },
): Promise<void> {
  const effectiveTimeout = tuiWaitTimeout(timeout);
  const interval = tuiPollInterval(100);
  const since = options.since;
  const start = Date.now();
  while (Date.now() - start < effectiveTimeout) {
    if (server.hasRequestMessage(text, since)) return;
    await sleep(interval);
  }
  const requestCount = server.getRequestCount();
  const requestTail = server
    .getRequests()
    .slice(since)
    .slice(-3)
    .map((request) =>
      request.messages
        .map(
          (message) =>
            `${message.role ?? 'unknown'}:${JSON.stringify(message.content).slice(0, 300)}`,
        )
        .join(' | '),
    )
    .join('\n');
  const terminalTail = options.tui
    ? stripAnsi(options.tui.transcript()).slice(-1_000)
    : 'unavailable';
  throw new Error(
    `Timeout (${effectiveTimeout}ms) waiting for model request containing "${text}". ` +
      `Saw ${requestCount - since} new request(s).\nRecent requests:\n${
        requestTail || 'none'
      }\nLast terminal output:\n${terminalTail}`,
  );
}

export async function submitUserMessage(
  tui: PtyProcess,
  server: MockModelServer,
  text: string,
  options?: {
    delayMs?: number;
    requestText?: string;
    timeout?: number;
    testTiming?: { submitReceiptTimeoutMs?: number; semanticReceiptTimeoutMs?: number };
  },
): Promise<void> {
  const since = server.getRequestCount();
  await typeText(tui, text, options?.delayMs);
  await submitCurrentInput(tui, {
    ...options?.testTiming,
    acceptWhen: () => server.getRequestCount() > since,
    requireAcceptWhen: true,
    semanticReceiptTimeoutMs:
      options?.testTiming?.semanticReceiptTimeoutMs ?? options?.timeout ?? 10_000,
  });
  await waitForRequestMessage(server, options?.requestText ?? text, options?.timeout, {
    since,
    tui,
  });
}

/**
 * Submit the currently active input and confirm that the input field has
 * advanced. Use this after composing an input through multiple actions (for
 * example Shift+Enter) or when production is expected to intercept the input
 * before a model request is issued.
 */
export async function submitCurrentInput(
  tui: PtyProcess,
  options?: {
    submitReceiptTimeoutMs?: number;
    semanticReceiptTimeoutMs?: number;
    acceptWhen?: (viewport: string) => boolean;
    requireAcceptWhen?: boolean;
  },
): Promise<void> {
  if (options?.requireAcceptWhen && !options.acceptWhen) {
    throw new Error('submitCurrentInput requires acceptWhen when requireAcceptWhen is true');
  }
  await tui.settleScreen();
  const submitted = activeInput(tui.inputViewport());
  if (!submitted || submitted.value.length === 0) {
    throw new Error('Cannot submit because no non-empty active input field is visible');
  }

  for (let attempt = 1; attempt <= INPUT_SUBMIT_ATTEMPTS; attempt++) {
    tui.write('\r');
    const timeoutMs = options?.submitReceiptTimeoutMs ?? INPUT_SUBMIT_RECEIPT_TIMEOUT_MS;
    const receipt = await waitForInputSubmissionReceipt(
      tui,
      submitted,
      timeoutMs,
      options?.acceptWhen,
    );
    if (receipt === 'accepted') return;
    if (receipt === 'advanced') {
      if (!options?.requireAcceptWhen) return;
      if (
        await waitForSemanticSubmissionReceipt(
          tui,
          options.semanticReceiptTimeoutMs ?? timeoutMs,
          options.acceptWhen!,
        )
      ) {
        return;
      }
      throw new Error(
        `PTY input left ${JSON.stringify(submitted.value)} but its required semantic receipt did not arrive`,
      );
    }
  }
  throw new Error(
    `PTY input submission failed after ${INPUT_SUBMIT_ATTEMPTS} Enter attempt(s): ${JSON.stringify(submitted.value)}`,
  );
}

export async function submitCommand(
  tui: PtyProcess,
  command: string,
  delayMs?: number,
  testTiming?: {
    submitReceiptTimeoutMs?: number;
    semanticReceiptTimeoutMs?: number;
    acceptWhen?: (viewport: string) => boolean;
    requireAcceptWhen?: boolean;
  },
): Promise<void> {
  await typeText(tui, command, delayMs);
  const expectedKind: ActiveInput['kind'] | undefined = /^\/(?:model|effort|theme)\s+\S/.test(
    command,
  )
    ? 'slash-argument-query'
    : /^\/\S+$/.test(command)
      ? undefined
      : 'main';
  // A plain input echo can precede the React commit that updates the slash
  // suggestion refs consumed by Enter. Argument selectors require their exact
  // semantic suggestion frame; free-form arguments require the settled main
  // input. Exact no-argument commands are safe in either kind because the
  // same render computes slashMatched=true and no longer suppresses submit.
  await waitForInputEcho(
    tui,
    normalizeInputEcho(command),
    expectedKind,
    expectedKind === undefined,
    INPUT_ECHO_TIMEOUT_MS,
  );
  await submitCurrentInput(tui, testTiming);
}

async function waitForInputSubmissionReceipt(
  tui: PtyProcess,
  submitted: ActiveInput,
  timeoutMs: number,
  acceptWhen?: (viewport: string) => boolean,
): Promise<'accepted' | 'advanced' | 'unchanged'> {
  const effectiveTimeout = tuiWaitTimeout(timeoutMs);
  const start = Date.now();
  while (Date.now() - start < effectiveTimeout) {
    await tui.settleScreen();
    if (tui.exited) return 'accepted';
    const viewport = tui.viewport();
    if (acceptWhen?.(viewport)) return 'accepted';
    const current = activeInput(tui.inputViewport());
    if (current?.kind !== submitted.kind || current.value !== submitted.value) return 'advanced';
    await sleep(tuiPollInterval(25));
  }
  return 'unchanged';
}

async function waitForSemanticSubmissionReceipt(
  tui: PtyProcess,
  timeoutMs: number,
  acceptWhen: (viewport: string) => boolean,
): Promise<boolean> {
  const effectiveTimeout = tuiWaitTimeout(timeoutMs);
  const start = Date.now();
  while (Date.now() - start < effectiveTimeout) {
    await tui.settleScreen();
    if (tui.exited || acceptWhen(tui.viewport())) return true;
    await sleep(tuiPollInterval(25));
  }
  await tui.settleScreen();
  return tui.exited || acceptWhen(tui.viewport());
}
