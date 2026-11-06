import assert from 'node:assert/strict';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CommandRecord,
  ExecutionRecord,
  ExtensionRecord,
  Store,
} from '@kite-ai/agent/storage';
import { createShellCommandPolicy } from '../../../../packages/agent/src/permissions/shell-command-policy';
import { digest } from '../../../../packages/agent/src/tools/git-worktree/protocol';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Evaluate acceptance only after evidence collection and the original shutdown have settled. */
export function finalizeWorktreeLiveAcceptance(options: {
  checks: Record<string, boolean>;
  failures: readonly string[];
  reviewRequirements: readonly unknown[];
  signal?: AbortSignal;
}): 'assertions_passed' | 'needs_review' {
  options.checks.operatorNotCancelled = options.signal?.aborted !== true;
  return options.failures.length === 0 &&
    options.reviewRequirements.length === 0 &&
    Object.values(options.checks).every(Boolean)
    ? 'assertions_passed'
    : 'needs_review';
}

export function newLiveOutputRoot(output: string): string {
  const allowed = fileURLToPath(new URL('../../../../dist/acceptance', import.meta.url)),
    root = resolve(output),
    local = relative(allowed, root);
  assert(
    isAbsolute(output) &&
      local !== '' &&
      !isAbsolute(local) &&
      local !== '..' &&
      !local.startsWith(`..${sep}`) &&
      !entryExists(root),
    'live-worktree-new-absolute-acceptance-directory-required',
  );
  let ancestor = dirname(root);
  while (!entryExists(ancestor)) ancestor = dirname(ancestor);
  assert(
    lstatSync(ancestor).isDirectory() && realpathSync(ancestor) === ancestor,
    'live-worktree-output-ancestor-must-be-physical-directory',
  );
  return root;
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Check Bun's cached startup HOME before constructing a Provider or running Git. */
export function assertWorktreeLiveStartupHome(
  root: string,
  providerConfigurationPath: string | undefined,
): string {
  const home = `${root}.home`;
  assert(
    providerConfigurationPath &&
      isAbsolute(providerConfigurationPath) &&
      homedir() === home &&
      process.env.HOME === home &&
      process.env.USERPROFILE === home,
    'worktree-startup-home-and-original-provider-path-required',
  );
  return home;
}

let verificationParser: Promise<typeof import('web-tree-sitter')> | undefined;
/** Acceptance oracle only: never a production Shell policy or an authorization grant. */
export async function classifyWorktreeLiveVerification(command: string, cwd: string) {
  const policy = await createShellCommandPolicy({ cwd, shellExecutable: '/bin/sh' });
  let normalizedCommand = command;
  let classified = await policy.classify(command);
  if (!classified.plainCommands) {
    const grammar = policy.assets.find((asset) => asset.path.endsWith('tree-sitter-bash.wasm'));
    assert(grammar, 'verification-original-bash-grammar-required');
    verificationParser ??= (async () => {
      // Resolve through the workspace that already owns the parser dependency.
      const treeSitter = createRequire(
        new URL('../../../../packages/agent/package.json', import.meta.url),
      )('web-tree-sitter') as typeof import('web-tree-sitter');
      const runtime = policy.assets.find((asset) => asset.path.endsWith('/tree-sitter.wasm'));
      assert(runtime, 'verification-original-parser-runtime-required');
      await treeSitter.Parser.init({ wasmBinary: readFileSync(runtime.path) });
      return treeSitter;
    })();
    const { Language, Parser } = await verificationParser;
    const parser = new Parser();
    parser.setLanguage(await Language.load(readFileSync(grammar.path)));
    const tree = parser.parse(command);
    assert(tree, 'verification-shell-parse-required');
    try {
      const stack = [tree.rootNode];
      const discardedStderr: { start: number; end: number }[] = [];
      while (stack.length) {
        const node = stack.pop()!;
        // Discarding diagnostics is allowed only for this exact AST redirect.
        // Opaque substitutions, other redirects and scripts still fail the
        // original literal-argv classification below.
        if (node.type === 'file_redirect' && /^2\s*>\s*\/dev\/null$/u.test(node.text)) {
          assert.equal(command.slice(node.startIndex, node.endIndex), node.text);
          discardedStderr.push({ start: node.startIndex, end: node.endIndex });
        }
        stack.push(...node.namedChildren.filter((child) => child !== null));
      }
      for (const redirect of discardedStderr.sort((a, b) => b.start - a.start))
        normalizedCommand = `${normalizedCommand.slice(0, redirect.start)} ${normalizedCommand.slice(redirect.end)}`;
    } finally {
      tree.delete();
      parser.delete();
    }
    classified = await policy.classify(normalizedCommand);
  }
  const allowed =
    classified.hardDenied === null &&
    classified.plainCommands !== null &&
    classified.plainCommands.length > 0 &&
    classified.plainCommands.every((argv) => {
      const [program, ...args] = argv;
      if (program === 'cd') return args.length === 1 || (args.length === 2 && args[0] === '--');
      if (['test', 'echo', 'head'].includes(program ?? '')) return true;
      if (program === 'wc') return args.length === 1 && args[0] === '-l';
      if (program === 'grep') return args.length === 2 && args[0] === '-c';
      if (program !== 'git' && program !== '/usr/bin/git') return false;
      let index = 0;
      for (;;) {
        if (args[index] === '-C' && args[index + 1]) index += 2;
        else if (['--no-optional-locks', '--no-pager'].includes(args[index] ?? '')) index += 1;
        else break;
      }
      const verb = args[index++];
      const rest = args.slice(index);
      if (verb === undefined) return true; // Git help/error with only literal -C.
      if (verb === 'status' || verb === 'rev-parse') return true;
      if (verb === 'for-each-ref')
        return rest.every((value) => value.startsWith('--format=') || value.startsWith('refs/'));
      if (verb === 'stash') return rest.length === 1 && rest[0] === 'list';
      if (verb === 'tag')
        return (
          rest.includes('--list') &&
          rest.every((value) => !value.startsWith('-') || value === '--list')
        );
      if (verb === 'worktree')
        return (
          rest[0] === 'list' &&
          rest.slice(1).every((value) => ['--porcelain', '-z', '--verbose', '-v'].includes(value))
        );
      if (verb === 'branch')
        return (
          (rest.length === 0 || rest.includes('--list') || rest.includes('--show-current')) &&
          rest.every((value) =>
            value.startsWith('-')
              ? ['--list', '--show-current', '--all', '-a', '--verbose', '-v'].includes(value)
              : rest.includes('--list'),
          )
        );
      return false;
    });
  return {
    command,
    normalizedCommand,
    plainCommands: classified.plainCommands,
    allowed,
    classification: allowed
      ? ('read_only_literals' as const)
      : ('requires_semantic_review' as const),
  };
}
export function worktreeLiveShellReferenceEvidence(
  job: ExecutionRecord,
  parent: ExecutionRecord | undefined,
  records: readonly ExtensionRecord[],
  command: CommandRecord | null,
) {
  const expected = {
    commandId: job.originCommandId,
    executionId: job.id,
    extensionId: 'builtin.shell',
    key: object(object(parent?.result).details).shell_id,
    originStoreId: job.originStoreId,
    sessionId: job.sessionId,
  };
  const equalRef = (value: unknown) => {
    const ref = object(value);
    return (
      Object.keys(ref).sort().join() === Object.keys(expected).sort().join() &&
      Object.entries(expected).every(([key, value]) => ref[key] === value)
    );
  };
  const matching = records.filter(
    (record) => object(object(record.value).ref).executionId === job.id,
  );
  const record = matching[0];
  const request = object(command?.request);
  return {
    expected,
    recordKeys: matching.map((record) => record.key),
    exactOriginalCommand:
      command?.id === expected.commandId &&
      command.kind === 'operation.job' &&
      command.status === 'applied' &&
      command.originStoreId === job.originStoreId &&
      command.sessionId === job.sessionId &&
      command.rootWorkCommandId === job.rootWorkCommandId &&
      command.rootWorkSeq === job.rootWorkSeq &&
      request.kind === 'operation.job' &&
      request.extensionId === 'builtin.shell' &&
      request.operationKey === expected.key &&
      request.parentExecutionId === parent?.id &&
      request.definitionId === job.definitionId &&
      request.definitionVersion === job.definitionVersion &&
      request.cancellation === 'attached' &&
      digest(request.input) === digest(job.input) &&
      object(command.receipt).commandId === command.id &&
      object(command.receipt).executionId === job.id,
    uniqueOriginalRecordAndReceipt:
      matching.length === 1 &&
      typeof expected.key === 'string' &&
      record?.extensionId === 'builtin.shell' &&
      record.sessionId === job.sessionId &&
      record.key === `shell/${expected.key}` &&
      record.contentType === 'application/vnd.kite.shell-reference+json' &&
      record.contentVersion === 1 &&
      Object.keys(object(record.value)).join() === 'ref' &&
      equalRef(object(record.value).ref) &&
      equalRef(object(object(parent?.result).details).ref),
  };
}
export async function completeJobOutput(
  store: Pick<Store, 'listExecutionOutput'>,
  executionId: string,
  mode: 'worktree' | 'shell' | 'agent' = 'worktree',
) {
  const pages = [];
  let afterSeq = '0',
    highWaterSeq: string | undefined,
    stdout = '',
    stderr = '';
  const progress: { seq: string; content: string }[] = [];
  for (;;) {
    const page = await store.listExecutionOutput({
      executionId,
      afterSeq,
      ...(highWaterSeq === undefined ? {} : { upperSeq: highWaterSeq }),
      limit: 200,
    });
    pages.push(page);
    assert(/^(0|[1-9][0-9]{0,18})$/u.test(page.highWaterSeq), 'original-output-high-water');
    assert(page.items.length <= 200, 'original-output-page-limit');
    if (highWaterSeq === undefined) highWaterSeq = page.highWaterSeq;
    assert.equal(page.highWaterSeq, highWaterSeq, 'terminal-output-high-water-changed');
    for (const item of page.items) {
      assert.equal(item.executionId, executionId, 'original-output-execution-changed');
      assert(
        /^(0|[1-9][0-9]{0,18})$/u.test(item.seq) && /^(0|[1-9][0-9]{0,18})$/u.test(item.throughSeq),
        'original-output-cursor',
      );
      assert.equal(item.droppedBytes, '0', 'original-output-gap');
      assert(
        BigInt(item.seq) > BigInt(afterSeq) &&
          BigInt(item.throughSeq) >= BigInt(item.seq) &&
          BigInt(item.throughSeq) <= BigInt(highWaterSeq),
        'original-output-sequence',
      );
      assert.equal(BigInt(item.seq), BigInt(afterSeq) + 1n, 'original-output-missing-chunk');
      assert.equal(item.throughSeq, item.seq, 'original-output-zero-drop-range');
      assert.equal(
        Buffer.from(item.content).toString('utf8'),
        item.content,
        'original-output-utf8',
      );
      if (item.stream === 'stdout') stdout += item.content;
      else if (item.stream === 'stderr') stderr += item.content;
      else if (item.stream === 'progress' && mode === 'agent')
        progress.push({ seq: item.seq, content: item.content });
      else assert.fail('original-output-unexpected-stream');
      afterSeq = item.throughSeq;
    }
    if (afterSeq === highWaterSeq) break;
    assert(page.items.length > 0, 'original-output-page-no-progress');
  }
  if (mode !== 'worktree')
    return {
      executionId,
      highWaterSeq,
      complete: true,
      pages,
      stdout,
      stderr,
      progress,
      frame: null,
    };
  const lines = stdout.split('\n');
  assert.equal(lines.pop(), '', 'worker-output-final-newline');
  assert.equal(lines.length, 1, 'worker-output-one-complete-frame');
  const frame = JSON.parse(lines[0]!);
  return { executionId, highWaterSeq, complete: true, pages, stdout, stderr, frame };
}
