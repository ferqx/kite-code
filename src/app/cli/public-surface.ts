/**
 * The public CLI declaration is consumed by argument parsing, help rendering,
 * and the diagnostic source inventory. It is deliberately free of config or
 * runtime imports so no caller can obtain project configuration by reading it.
 */
export const CLI_COMMAND_IDS_V1 = ['run', 'resume', 'trace', 'help'] as const;
export type CliCommandIdV1 = (typeof CLI_COMMAND_IDS_V1)[number];

export type CliPublicSupportStateV1 = 'supported' | 'unsupported';
export type CliPublicExposureV1 = 'default_on' | 'unsupported';

interface CliCommandSpecV1 {
  command: CliCommandIdV1;
  usage: string;
  supportState: CliPublicSupportStateV1;
  declaredExposure: CliPublicExposureV1;
  notApplicableRationale?: 'legacy_resume_rejected';
  rejectionMessage?: string;
}

/** @qualification-entry-rejection-v1 {"entrypointId":"cli","denialFamily":"legacy_resume_rejected","sourceKind":"public_surface","symbol":"CLI_COMMAND_SPECS_V1"} */
/**
 * `resume` remains recognized so the established Runtime-Kernel incompatibility
 * error is stable. It is intentionally not a supported CLI operation.
 */
export const CLI_COMMAND_SPECS_V1 = [
  {
    command: 'run',
    usage: 'bun run agent run --task "Create hello.txt"',
    supportState: 'supported',
    declaredExposure: 'default_on',
  },
  {
    command: 'resume',
    usage: 'bun run agent resume --thread default-thread --approve (legacy; rejected)',
    supportState: 'unsupported',
    declaredExposure: 'unsupported',
    notApplicableRationale: 'legacy_resume_rejected',
    rejectionMessage:
      'Legacy checkpoint sessions are not compatible with the Runtime Kernel. Start a new task.',
  },
  {
    command: 'trace',
    usage: 'bun run agent trace <events.jsonl>',
    supportState: 'supported',
    declaredExposure: 'default_on',
  },
  {
    command: 'help',
    usage: 'bun run agent help',
    supportState: 'supported',
    declaredExposure: 'default_on',
  },
] as const satisfies readonly CliCommandSpecV1[];

export const CLI_FIRST_TOKEN_ALIASES_V1 = [
  { token: '--help', command: 'help' },
] as const satisfies readonly { token: string; command: CliCommandIdV1 }[];

interface CliOptionSpecV1 {
  id: string;
  flag: `--${string}`;
  value?: string;
  help: string;
  takesValue: boolean;
  commands: readonly CliCommandIdV1[];
  bootstrapOnly?: boolean;
  supportState: CliPublicSupportStateV1;
  declaredExposure: CliPublicExposureV1;
  notApplicableRationale?: 'legacy_resume_rejected';
}

/**
 * `commands` describes the parser-recognized command scope. A command may be
 * recognized but unsupported (currently legacy `resume`); that distinction is
 * retained instead of silently treating its historical option grammar as live.
 */
export const CLI_OPTION_SPECS_V1 = [
  {
    id: 'task',
    flag: '--task',
    value: '<text>',
    help: 'Task for run',
    takesValue: true,
    commands: ['run'],
    supportState: 'supported',
    declaredExposure: 'default_on',
  },
  {
    id: 'thread',
    flag: '--thread',
    value: '<id>',
    help: 'LangGraph thread id',
    takesValue: true,
    commands: ['run', 'resume'],
    supportState: 'supported',
    declaredExposure: 'default_on',
  },
  {
    id: 'user',
    flag: '--user',
    value: '<id>',
    help: 'User id',
    takesValue: true,
    commands: ['run', 'resume'],
    supportState: 'supported',
    declaredExposure: 'default_on',
  },
  {
    id: 'workspace',
    flag: '--workspace',
    value: '<path>',
    help: 'Tool workspace',
    takesValue: true,
    commands: ['run'],
    supportState: 'supported',
    declaredExposure: 'default_on',
  },
  {
    id: 'checkpoints',
    flag: '--checkpoints',
    value: '<path>',
    help: 'SQLite checkpoint path',
    takesValue: true,
    commands: ['run', 'resume'],
    supportState: 'supported',
    declaredExposure: 'default_on',
  },
  {
    id: 'mode',
    flag: '--mode',
    value: '<mode>',
    help: 'auto, write, or builder',
    takesValue: true,
    commands: ['run'],
    supportState: 'supported',
    declaredExposure: 'default_on',
  },
  {
    id: 'skill',
    flag: '--skill',
    value: '<name>',
    help: 'Activate a skill (repeatable)',
    takesValue: true,
    commands: ['run'],
    supportState: 'supported',
    declaredExposure: 'default_on',
  },
  {
    id: 'feature',
    flag: '--feature',
    value: '<name[=bool]>',
    help: 'Temporarily override a registered feature flag (repeatable)',
    takesValue: true,
    commands: ['run'],
    supportState: 'supported',
    declaredExposure: 'default_on',
  },
  {
    id: 'executionStatus',
    flag: '--execution-status',
    help: 'Print the effective production execution boundary and exit',
    takesValue: false,
    commands: ['run'],
    supportState: 'supported',
    declaredExposure: 'default_on',
  },
  {
    id: 'releaseStatus',
    flag: '--release-status',
    help: 'Print the effective release profile and Gate status and exit',
    takesValue: false,
    commands: ['run'],
    supportState: 'supported',
    declaredExposure: 'default_on',
  },
  {
    id: 'telemetryStatus',
    flag: '--telemetry-status',
    help: 'Print redacted telemetry consent/export status and exit',
    takesValue: false,
    commands: ['run'],
    supportState: 'supported',
    declaredExposure: 'default_on',
  },
  {
    id: 'turn',
    flag: '--turn',
    value: '<n>',
    help: 'Limit trace output to a turn',
    takesValue: true,
    commands: ['trace'],
    supportState: 'supported',
    declaredExposure: 'default_on',
  },
  {
    id: 'format',
    flag: '--format',
    value: 'json',
    help: 'Emit a trace as JSON',
    takesValue: true,
    commands: ['trace'],
    supportState: 'supported',
    declaredExposure: 'default_on',
  },
  {
    id: 'approve',
    flag: '--approve',
    help: 'Legacy resume approval (rejected with resume)',
    takesValue: false,
    commands: ['resume'],
    supportState: 'unsupported',
    declaredExposure: 'unsupported',
    notApplicableRationale: 'legacy_resume_rejected',
  },
  {
    id: 'approveSameCommand',
    flag: '--approve-same-command',
    help: 'Legacy resume approval (rejected with resume)',
    takesValue: false,
    commands: ['resume'],
    supportState: 'unsupported',
    declaredExposure: 'unsupported',
    notApplicableRationale: 'legacy_resume_rejected',
  },
  {
    id: 'fullAccess',
    flag: '--full-access',
    help: 'Start run with full authorization (requires sandbox; source=config)',
    takesValue: false,
    commands: ['run', 'resume'],
    supportState: 'supported',
    declaredExposure: 'default_on',
  },
  {
    id: 'trustWorkspace',
    flag: '--trust-workspace',
    help: 'Record trust for --workspace and continue (source=config)',
    takesValue: false,
    commands: ['run'],
    supportState: 'supported',
    declaredExposure: 'default_on',
  },
  {
    id: 'approvalHash',
    flag: '--approval-hash',
    value: '<hash>',
    help: 'Legacy resume approval hash (rejected with resume)',
    takesValue: true,
    commands: ['resume'],
    supportState: 'unsupported',
    declaredExposure: 'unsupported',
    notApplicableRationale: 'legacy_resume_rejected',
  },
  {
    id: 'replaceCommand',
    flag: '--replace-command',
    value: '<cmd>',
    help: 'Legacy resume replacement (rejected with resume)',
    takesValue: true,
    commands: ['resume'],
    supportState: 'unsupported',
    declaredExposure: 'unsupported',
    notApplicableRationale: 'legacy_resume_rejected',
  },
  {
    id: 'answer',
    flag: '--answer',
    value: '<text>',
    help: 'Legacy resume answer (rejected with resume)',
    takesValue: true,
    commands: ['resume'],
    supportState: 'unsupported',
    declaredExposure: 'unsupported',
    notApplicableRationale: 'legacy_resume_rejected',
  },
  {
    id: 'authorizationMode',
    flag: '--authorization-mode',
    value: '<mode>',
    help: 'default or full-access',
    takesValue: true,
    commands: ['run'],
    supportState: 'supported',
    declaredExposure: 'default_on',
  },
  {
    id: 'ask',
    flag: '--ask',
    help: 'Ask before every tool (default)',
    takesValue: false,
    commands: ['run'],
    supportState: 'supported',
    declaredExposure: 'default_on',
  },
  {
    id: 'auto',
    flag: '--auto',
    help: 'Auto-review tools, ask when uncertain',
    takesValue: false,
    commands: ['run'],
    supportState: 'supported',
    declaredExposure: 'default_on',
  },
  {
    id: 'full',
    flag: '--full',
    help: 'Run with full permissions, never ask',
    takesValue: false,
    commands: ['run'],
    supportState: 'supported',
    declaredExposure: 'default_on',
  },
  {
    id: 'noSandbox',
    flag: '--no-sandbox',
    help: 'Disable sandbox',
    takesValue: false,
    commands: ['run', 'resume'],
    supportState: 'supported',
    declaredExposure: 'default_on',
  },
  {
    id: 'version',
    flag: '--version',
    help: 'Print version and exit',
    takesValue: false,
    commands: [],
    bootstrapOnly: true,
    supportState: 'supported',
    declaredExposure: 'default_on',
  },
] as const satisfies readonly CliOptionSpecV1[];

export type CliOptionIdV1 = (typeof CLI_OPTION_SPECS_V1)[number]['id'];

export function cliCommandSpecV1(command: CliCommandIdV1): CliCommandSpecV1 {
  const spec = CLI_COMMAND_SPECS_V1.find((entry) => entry.command === command);
  if (!spec) throw new Error(`Unknown CLI command declaration: ${command}`);
  return spec;
}

export function cliOptionSpecV1(id: CliOptionIdV1): CliOptionSpecV1 {
  const spec = CLI_OPTION_SPECS_V1.find((entry) => entry.id === id);
  if (!spec) throw new Error(`Unknown CLI option declaration: ${id}`);
  return spec;
}

export function cliOptionFlagV1(id: CliOptionIdV1): string {
  return cliOptionSpecV1(id).flag;
}

/**
 * Reject a declared flag outside the command grammar before any value is
 * interpreted. Unknown flags retain the established parser behavior; only a
 * public option cannot silently cross into another command's surface.
 */
export function assertCliOptionApplicabilityV1(
  argv: readonly string[],
  command: CliCommandIdV1,
): void {
  for (const option of CLI_OPTION_SPECS_V1) {
    if (('bootstrapOnly' in option && option.bootstrapOnly) || !argv.includes(option.flag)) {
      continue;
    }
    if (!option.commands.some((candidate) => candidate === command)) {
      throw new Error(`Option ${option.flag} is not available for command ${command}.`);
    }
  }
}

export function isCliCommandV1(value: string | undefined): value is CliCommandIdV1 {
  return CLI_COMMAND_SPECS_V1.some((entry) => entry.command === value);
}

/** Resolves first-token help aliases without treating `run --help` as help. */
export function resolveCliCommandV1(value: string | undefined): CliCommandIdV1 {
  if (isCliCommandV1(value)) return value;
  return CLI_FIRST_TOKEN_ALIASES_V1.find((entry) => entry.token === value)?.command ?? 'help';
}

export function formatCliHelpV1(): string {
  const optionLines = CLI_OPTION_SPECS_V1.filter(
    (entry) => !('bootstrapOnly' in entry && entry.bootstrapOnly),
  ).map((entry) => {
    const label = 'value' in entry ? `${entry.flag} ${entry.value}` : entry.flag;
    return `  ${label.padEnd(31)} ${entry.help}`;
  });
  return [
    'Usage:',
    ...CLI_COMMAND_SPECS_V1.map((entry) => `  ${entry.usage}`),
    '',
    'Options:',
    ...optionLines,
  ].join('\n');
}
