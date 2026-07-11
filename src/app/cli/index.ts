import { resolve } from 'node:path';
import { defaultCheckpointPath, loadAgentConfig } from '@/core/config/index';
import { skillDirs } from '@/core/config/paths';
import type { RuntimeUserAction } from '@/core/runtime/actions';
import { runRuntimeAgent } from '@/core/runtime/agent';
import type { RuntimeActionProvider } from '@/core/runtime/runner';
import { runtimeStorePathFor } from '@/core/runtime/store';
import { createSandboxExecutor, resolveSandboxRuntime } from '@/core/sandbox/index';
import { getSkillContent, scanSkills } from '@/core/skills/loader';
import type { InterruptPayload, UserAction } from '@/protocol/actions';
import type { AgentEvent, ShellApprovalGrant, WorkspaceAccessRequest } from '@/protocol/events';
import type { UserInputProvider } from '@/protocol/provider';

export interface ParsedArgs {
  command: 'run' | 'resume' | 'help';
  task?: string;
  threadId: string;
  userId: string;
  workspace: string;
  checkpointPath: string;
  mode: WorkspaceAccessRequest;
  authorizationMode?: 'default' | 'full_access';
  approve: boolean;
  approvalGrant?: ShellApprovalGrant;
  approvalHash?: string;
  replacementCommand?: string;
  answer?: string;
  sandbox: boolean;
  interactionMode?: import('@/protocol/events').InteractionMode;
  skills: string[];
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') {
    printHelp();
    return;
  }
  if (args.command === 'resume') {
    throw new Error(
      'Legacy checkpoint sessions are not compatible with the Runtime Kernel. Start a new task.',
    );
  }

  const config = loadAgentConfig();
  const interactionMode = args.interactionMode ?? config.interactionMode ?? 'accept_edits';
  const sandboxRuntime = resolveSandboxRuntime({
    enabled: args.sandbox && config.sandbox.enabled,
  });
  if (interactionMode === 'full' && !sandboxRuntime.available) {
    throw new Error('full mode requires an available workspace sandbox.');
  }
  const shellExecutor = createSandboxExecutor({
    enabled: sandboxRuntime.enabled,
    workspace: args.workspace,
  });

  // Load skill contents and prepend to task
  let task = args.task ?? '';
  let manifests: import('@/core/skills/types').SkillManifest[] = [];
  let skillOptions: import('@/core/skills/types').SkillScanOptions | undefined;
  if (args.skills.length > 0) {
    skillOptions = skillDirs(args.workspace);
    manifests = scanSkills(skillOptions);
    const skillContents: string[] = [];
    for (const name of args.skills) {
      const result = getSkillContent(manifests, name, skillOptions);
      if (result) {
        skillContents.push(`[SKILL: ${result.name}]\n\n${result.content}\n\n---\n\n`);
      }
    }
    task = skillContents.join('') + task;
  }

  const provider = createCliRuntimeProvider();
  const generator = runRuntimeAgent(
    {
      task,
      userId: args.userId,
      threadId: args.threadId,
      workspace: args.workspace,
      runtimeStorePath: runtimeStorePathFor(args.checkpointPath),
      config,
      shellExecutor,
      interactionMode,
      sandboxBackend: sandboxRuntime.backend,
      frontend: 'cli',
      skills: manifests,
      skillOptions,
    },
    provider,
  );

  for await (const event of generator) {
    console.log(JSON.stringify(event));
  }
}

function createCliRuntimeProvider(): RuntimeActionProvider {
  return {
    async requestAction(effect, state): Promise<RuntimeUserAction> {
      if (state.interactions.kind === 'awaiting_tool_approval') {
        const approval = state.interactions.approval;
        console.error(`\n[APPROVAL REQUIRED] ${approval.tool}: ${approval.command}`);
        console.error(`Risk: ${approval.risk} | ${approval.summary}`);
        console.error('Type y/yes to approve, n to reject, f/full_access for full access:');
        const value = (await readStdin()).toLowerCase();
        if (value === 'f' || value === 'full_access')
          return { type: 'approve', interactionId: effect.interactionId, grant: 'full_access' };
        if (value === 'y' || value === 'yes')
          return { type: 'approve', interactionId: effect.interactionId, grant: 'approve_once' };
        return { type: 'reject', interactionId: effect.interactionId };
      }
      if (state.interactions.kind === 'awaiting_review') {
        const plan = state.interactions.plan;
        console.error(`\n[PLAN REVIEW] ${plan.name}\n${plan.description}`);
        console.error('Type a/auto, e/accept-edits, f/feedback, or c/cancel:');
        const value = (await readStdin()).toLowerCase();
        const review = {
          type: 'plan_review_decision' as const,
          interactionId: effect.interactionId,
          planId: state.interactions.planId,
          version: state.interactions.version,
          structuralDigest: state.interactions.structuralDigest,
        };
        if (value === 'a' || value === 'auto')
          return {
            ...review,
            decision: { kind: 'approve', nextMode: 'auto', clearPlanningContext: false },
          };
        if (value === 'e' || value === 'accept-edits')
          return {
            ...review,
            decision: { kind: 'approve', nextMode: 'accept_edits', clearPlanningContext: false },
          };
        if (value === 'f' || value === 'feedback') {
          console.error('Enter your feedback:');
          return { ...review, decision: { kind: 'revise', feedback: await readStdin() } };
        }
        return { ...review, decision: { kind: 'cancel' } };
      }
      if (state.interactions.kind !== 'awaiting_user_input') {
        throw new Error('Runtime requested input without an input interaction.');
      }
      const request = state.interactions.request;
      console.error(`\n[QUESTION] ${request.question}`);
      request.options.forEach((option, index) => {
        console.error(`  ${index + 1}. ${option.label}`);
      });
      return { type: 'input', interactionId: effect.interactionId, text: await readStdin() };
    },
  };
}

export function createCliProvider(_args: ParsedArgs): UserInputProvider {
  return {
    onEvent(event: AgentEvent) {
      console.log(JSON.stringify(event));
    },
    async requestAction(payload: InterruptPayload): Promise<UserAction> {
      if (payload.kind === 'approval') {
        const a = payload.approval;
        console.error(`\n[APPROVAL REQUIRED] ${a.tool}: ${a.command}`);
        console.error(`Risk: ${a.risk} | ${a.summary}`);
        console.error('Type y/yes to approve, n to reject, f/full_access for full access:');
      } else if (payload.kind === 'input') {
        const q = payload.question;
        console.error(`\n[QUESTION] ${q.question}`);
        if (q.options.length > 0) {
          q.options.forEach((o, i) => {
            console.error(`  ${i + 1}. ${o.label}`);
          });
        }
        console.error('Enter your answer:');
      } else {
        // plan_review
        const p = payload.plan;
        console.error(`\n[PLAN REVIEW] ${p.name}`);
        console.error(p.description);
        if (p.steps.length > 0) {
          p.steps.forEach((s, i) => {
            console.error(`  ${i + 1}. ${s.step} [${s.status}]`);
          });
        }
        console.error('Type a/auto, e/accept-edits, f/feedback, or c/cancel:');
      }

      const data = await readStdin();
      if (payload.kind === 'approval') {
        const lower = data.toLowerCase();
        if (lower === 'f' || lower === 'full_access')
          return { type: 'approve', grant: 'full_access' };
        if (lower === 'y' || lower === 'yes') return { type: 'approve', grant: 'approve_once' };
        return { type: 'reject' };
      }
      if (payload.kind === 'plan_review') {
        const lower = data.toLowerCase();
        if (lower === 'a' || lower === 'auto')
          return {
            type: 'plan_review_decision',
            decision: { kind: 'approve', nextMode: 'auto', clearPlanningContext: false },
          };
        if (lower === 'e' || lower === 'accept-edits')
          return {
            type: 'plan_review_decision',
            decision: { kind: 'approve', nextMode: 'accept_edits', clearPlanningContext: false },
          };
        if (lower === 'f' || lower === 'feedback') {
          console.error('Enter your feedback:');
          const feedback = await readStdin();
          return { type: 'plan_review_decision', decision: { kind: 'revise', feedback } };
        }
        return { type: 'plan_review_decision', decision: { kind: 'cancel' } };
      }
      return { type: 'input', text: data };
    },
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const { stdin } = process;
    const onData = (chunk: Buffer) => {
      stdin.removeListener('data', onData);
      resolve(chunk.toString().trim());
    };
    stdin.on('data', onData);
    stdin.resume();
  });
}

// ── Argument parsing (unchanged from original cli.ts) ──

export function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] === 'resume' ? 'resume' : argv[0] === 'run' ? 'run' : 'help';
  const cwd = process.cwd();
  const value = (name: string, fallback: string) => {
    const index = argv.indexOf(name);
    const next = index >= 0 ? argv[index + 1] : undefined;
    return next || fallback;
  };
  const optionalValue = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? (argv[index + 1] ?? '') : undefined;
  };
  const noSandbox = argv.includes('--no-sandbox');
  const interactionMode = argv.includes('--full')
    ? 'full'
    : argv.includes('--auto')
      ? 'auto'
      : argv.includes('--ask')
        ? 'accept_edits'
        : undefined;
  const explicitThread = value('--thread', '');
  const mode = parseMode(value('--mode', 'auto'));
  const authorizationMode = parseAuthorizationMode(optionalValue('--authorization-mode') ?? '');
  const answer = optionalValue('--answer');
  const approvalHash = optionalValue('--approval-hash');
  const replacementCommand = optionalValue('--replace-command');
  const approvalGrant = parseApprovalGrant(argv);

  const multi = (flag: string): string[] => {
    const values: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === flag && i + 1 < argv.length) {
        const val = argv[i + 1];
        if (val !== undefined) values.push(val);
        i++;
      }
    }
    return values;
  };

  return {
    command,
    task: command === 'run' ? value('--task', positionalTask(argv)) : '',
    threadId: explicitThread || (command === 'run' ? freshThreadId() : 'default-thread'),
    userId: value('--user', 'default-user'),
    workspace: resolve(value('--workspace', cwd)),
    checkpointPath: resolve(value('--checkpoints', defaultCheckpointPath())),
    mode,
    authorizationMode,
    approve: approvalGrant !== undefined,
    approvalGrant,
    approvalHash,
    replacementCommand,
    answer,
    sandbox: !noSandbox,
    interactionMode,
    skills: multi('--skill'),
  };
}

function parseApprovalGrant(argv: string[]): ShellApprovalGrant | undefined {
  if (argv.includes('--full-access')) return 'full_access';
  if (argv.includes('--approve-same-command')) return 'same_command';
  if (argv.includes('--approve')) return 'approve_once';
  return undefined;
}

function positionalTask(argv: string[]): string {
  if (argv[0] !== 'run') return '';
  const optionNamesWithValues = new Set([
    '--task',
    '--thread',
    '--user',
    '--workspace',
    '--checkpoints',
    '--mode',
    '--answer',
    '--approval-hash',
    '--replace-command',
    '--skill',
  ]);
  const parts: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const item = argv[index];
    if (item === undefined) continue;
    if (optionNamesWithValues.has(item)) {
      index++;
      continue;
    }
    if (item.startsWith('--')) continue;
    parts.push(item);
  }
  return parts.join(' ').trim();
}

function parseMode(value: string): WorkspaceAccessRequest {
  if (value === 'write' || value === 'builder') return value;
  return 'auto';
}

function parseAuthorizationMode(value: string): 'default' | 'full_access' | undefined {
  if (value === 'full_access' || value === 'full-access') return 'full_access';
  if (value === 'default') return 'default';
  return undefined;
}

function freshThreadId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function printHelp(): void {
  console.log(`Usage:
  bun run agent run --task "Create hello.txt"
  bun run agent resume --thread default-thread --approve

Options:
  --task <text>          Task for run
  --thread <id>          LangGraph thread id
  --user <id>            User id
  --workspace <path>     Tool workspace
  --checkpoints <path>   SQLite checkpoint path
  --mode <mode>          auto, write, or builder
  --skill <name>         Activate a skill (repeatable)
  --approve              Approve tool call on resume
  --approve-same-command Approve same future commands
  --full-access          Allow all future shell_execute
  --approval-hash <hash> Approval hash
  --replace-command <cmd> Replace pending command
  --answer <text>        Answer user input interrupt
  --authorization-mode <mode>  default or full-access
  --ask                  Ask before every tool (default)
  --auto                 Auto-review tools, ask when uncertain
  --full           Run with full permissions, never ask
  --no-sandbox           Disable sandbox`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
