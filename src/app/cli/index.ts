import { resolve } from 'node:path';
import { defaultCheckpointPath, loadAgentConfig } from '@/core/config/index';
import { skillDirs } from '@/core/config/paths';
import { runAgent } from '@/core/runner';
import { createSandboxExecutor, detectSandboxBackend } from '@/core/sandbox/index';
import { getSkillContent, scanSkills } from '@/core/skills/loader';
import type { AuthorizationOverride } from '@/core/types';
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

  const config = loadAgentConfig();
  const interactionMode = args.interactionMode ?? config.interactionMode ?? 'ask';
  if (interactionMode === 'full' && (!args.sandbox || detectSandboxBackend() === 'none')) {
    throw new Error('full mode requires an available workspace sandbox.');
  }
  const shellExecutor = createSandboxExecutor({
    enabled: args.sandbox,
    workspace: args.workspace,
  });

  const authorizationOverride: AuthorizationOverride | undefined =
    args.authorizationMode !== undefined ? { current: args.authorizationMode } : undefined;

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

  const provider = createCliProvider(args);

  const generator = runAgent(provider, {
    task,
    userId: args.userId,
    threadId: args.threadId,
    workspace: args.workspace,
    checkpointPath: args.checkpointPath,
    config,
    mode: args.mode,
    shellExecutor,
    authorizationOverride,
    interactionMode,
    skills: manifests,
    skillOptions,
    frontend: 'cli',
    resume:
      args.command === 'resume'
        ? args.answer === undefined
          ? {
              approved: args.approve,
              grant: args.approvalGrant,
              approvalHash: args.approvalHash,
              replacementCommand: args.replacementCommand,
            }
          : { answer: args.answer }
        : undefined,
  });

  for await (const _ of generator) {
    // Events handled by provider.onEvent
  }
}

function createCliProvider(_args: ParsedArgs): UserInputProvider {
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
        console.error(
          'Type a/auto to approve and continue with automatic low-risk confirmations, m/manual to approve with confirmations, t/tell to give feedback, r/reject to reject:',
        );
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
        if (lower === 'a' || lower === 'auto') return { type: 'approve_plan_auto' };
        if (lower === 'm' || lower === 'manual') return { type: 'approve_plan_manual' };
        if (lower === 't' || lower === 'tell') {
          console.error('Enter your feedback:');
          const feedback = await readStdin();
          return { type: 'supplement_plan', feedback };
        }
        return { type: 'reject_plan' };
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
        ? 'ask'
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
