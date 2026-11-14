import { lstat } from 'node:fs/promises';
import { win32 } from 'node:path';
import { verifyLaunchIdentitiesAsync } from '../jobs/launch-identity';
import { runWindowsPowerShellInspection, type WindowsPowerShell } from '../jobs/windows-powershell';
import { AgentError } from '../storage/types';
import { readOnlyRipgrepPaths } from './shell-search';
import { windowsGitQuery } from './windows-git-read';

// ParseInput is the 5.1 parser from the selected system executable. The helper
// projects syntax only. It never resolves a model-supplied name by importing a module.
const inspectAst = `
function Get-Literal($node, $allowNumber = $false) {
    if ($node -is [System.Management.Automation.Language.StringConstantExpressionAst]) { return $node.Value }
    if ($allowNumber -and $node -is [System.Management.Automation.Language.ConstantExpressionAst] -and
        ($node.Value -is [int] -or $node.Value -is [long]) -and $node.Extent.Text -match '^(?:0|-?[1-9][0-9]*)$') { return $node.Extent.Text }
    return $null
}
$tokens = $null
$errors = $null
$root = [System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$tokens, [ref]$errors)
$nodes = $root.FindAll({ param($node) $true }, $true)
if ($nodes.Count -gt 4096) { throw 'AST node limit' }
$entryScript = $null
if ($errors.Count -eq 0 -and $null -eq $root.ScriptRequirements -and
    $null -eq $root.ParamBlock -and $null -eq $root.BeginBlock -and $null -eq $root.ProcessBlock -and
    $root.UsingStatements.Count -eq 0 -and $root.EndBlock.Unnamed -and
    $root.EndBlock.Statements.Count -eq 1 -and $root.EndBlock.Traps.Count -eq 0) {
    $statement = $root.EndBlock.Statements[0]
    if ($statement -is [System.Management.Automation.Language.PipelineAst] -and $statement.PipelineElements.Count -eq 1) {
        $invocation = $statement.PipelineElements[0]
        if ($invocation -is [System.Management.Automation.Language.CommandAst] -and $invocation.Redirections.Count -eq 0 -and
            $invocation.InvocationOperator.ToString() -in 'Unknown','Ampersand') {
            $name = $invocation.GetCommandName()
            if ($name -match '[.]ps1$' -and ($name.Contains('\\') -or $name.Contains('/'))) {
                $entryScript = $name
            }
        }
    }
}
$commands = [System.Collections.Generic.List[object]]::new()
$redirects = [System.Collections.Generic.List[object]]::new()
$simple = $errors.Count -eq 0 -and $null -eq $root.ScriptRequirements
foreach ($node in $nodes) {
    switch ($node.GetType().Name) {
        'CommandAst' {
            $arguments = @(
                for ($index = 1; $index -lt $node.CommandElements.Count; $index++) {
                    $element = $node.CommandElements[$index]
                    if ($element -is [System.Management.Automation.Language.CommandParameterAst]) {
                        @{ parameter = $element.ParameterName; value = (Get-Literal $element.Argument $true); attached = $null -ne $element.Argument }
                    } else {
                        @{ value = (Get-Literal $element $true) }
                    }
                }
            )
            $commands.Add(@{ name = $node.GetCommandName(); arguments = $arguments;
                bareStatement = $node.Parent -is [System.Management.Automation.Language.PipelineAst] -and
                    $node.Parent.PipelineElements.Count -eq 1 -and $node.Redirections.Count -eq 0;
                piped = $node.Parent -is [System.Management.Automation.Language.PipelineAst] -and $node.Parent.PipelineElements[0] -ne $node })
            if ($node.InvocationOperator.ToString() -ne 'Unknown') { $simple = $false }
        }
        'FileRedirectionAst' { $redirects.Add(@{ value = (Get-Literal $node.Location) }) }
        'ConstantExpressionAst' {
            if (($node.Parent -isnot [System.Management.Automation.Language.CommandAst] -and
                 $node.Parent -isnot [System.Management.Automation.Language.CommandParameterAst]) -or
                 $null -eq (Get-Literal $node $true)) { $simple = $false }
        }
        { $_ -in 'ScriptBlockAst','NamedBlockAst','PipelineAst','StringConstantExpressionAst','CommandParameterAst','MergingRedirectionAst' } { }
        default { $simple = $false }
    }
}
if ($tokens.Text -contains '--%') { $simple = $false }
[Console]::WriteLine((ConvertTo-Json -Depth 6 -Compress -InputObject @{
    valid = $errors.Count -eq 0; simple = $simple; commands = $commands.ToArray(); redirects = $redirects.ToArray(); entryScript = $entryScript
}))`;

type Argument = { value: string | null; parameter?: string; attached?: boolean };
type Invocation = {
  name: string | null;
  arguments: Argument[];
  piped: boolean;
  bareStatement: boolean;
};
type Syntax = {
  valid: boolean;
  simple: boolean;
  commands: Invocation[];
  redirects: Argument[];
  entryScript: string | null;
};
type PathUse = 'read' | 'write' | 'remove';
type PathInput = { value: string; use: PathUse };
type Parameter = PathUse | 'text' | 'switch';
type Command = {
  module: 'core' | 'management' | 'utility';
  positional?: readonly Parameter[];
  parameters?: Record<string, Parameter>;
  network?: boolean;
};

const path = { path: 'read', literalpath: 'read' } as const;
const destination = { path: 'write', literalpath: 'write' } as const;
const removal = { path: 'remove', literalpath: 'remove' } as const;
const commands: Readonly<Record<string, Command>> = {
  'get-location': { module: 'management' },
  'get-childitem': {
    module: 'management',
    positional: ['read'],
    parameters: {
      ...path,
      name: 'switch',
      file: 'switch',
      directory: 'switch',
      force: 'switch',
      filter: 'text',
      recurse: 'switch',
      depth: 'text',
    },
  },
  'get-item': {
    module: 'management',
    positional: ['read'],
    parameters: { ...path, force: 'switch' },
  },
  'test-path': {
    module: 'management',
    positional: ['read'],
    parameters: { ...path, pathtype: 'text' },
  },
  'get-content': {
    module: 'management',
    positional: ['read'],
    parameters: { ...path, raw: 'switch', encoding: 'text', totalcount: 'text', tail: 'text' },
  },
  'select-string': {
    module: 'utility',
    positional: ['text', 'read'],
    parameters: {
      ...path,
      pattern: 'text',
      simplematch: 'switch',
      casesensitive: 'switch',
      list: 'switch',
      quiet: 'switch',
      encoding: 'text',
    },
  },
  'select-object': {
    module: 'utility',
    parameters: {
      first: 'text',
      last: 'text',
      skip: 'text',
      unique: 'switch',
      property: 'text',
    },
  },
  'measure-object': {
    module: 'utility',
    parameters: { line: 'switch', word: 'switch', character: 'switch' },
  },
  'out-string': {
    module: 'utility',
    parameters: { stream: 'switch', width: 'text' },
  },
  'write-output': {
    module: 'utility',
    positional: ['text'],
    parameters: { inputobject: 'text', noenumerate: 'switch' },
  },
  'set-content': {
    module: 'management',
    positional: ['write', 'text'],
    parameters: {
      ...destination,
      value: 'text',
      encoding: 'text',
      nonewline: 'switch',
      force: 'switch',
    },
  },
  'add-content': {
    module: 'management',
    positional: ['write', 'text'],
    parameters: {
      ...destination,
      value: 'text',
      encoding: 'text',
      nonewline: 'switch',
      force: 'switch',
    },
  },
  'out-file': {
    module: 'utility',
    positional: ['write'],
    parameters: {
      filepath: 'write',
      literalpath: 'write',
      encoding: 'text',
      append: 'switch',
      noclobber: 'switch',
      nonewline: 'switch',
    },
  },
  'copy-item': {
    module: 'management',
    positional: ['read', 'write'],
    parameters: { ...path, destination: 'write', force: 'switch' },
  },
  'move-item': {
    module: 'management',
    positional: ['remove', 'write'],
    parameters: { ...removal, destination: 'write', force: 'switch' },
  },
  'remove-item': {
    module: 'management',
    positional: ['remove'],
    parameters: { ...removal, force: 'switch' },
  },
  'invoke-webrequest': {
    module: 'utility',
    positional: ['text'],
    network: true,
    parameters: {
      uri: 'text',
      usebasicparsing: 'switch',
      outfile: 'write',
      infile: 'read',
      method: 'text',
    },
  },
  'invoke-restmethod': {
    module: 'utility',
    positional: ['text'],
    network: true,
    parameters: {
      uri: 'text',
      usebasicparsing: 'switch',
      outfile: 'write',
      infile: 'read',
      method: 'text',
    },
  },
};
const aliases: Readonly<Record<string, string>> = {
  pwd: 'get-location',
  gl: 'get-location',
  dir: 'get-childitem',
  ls: 'get-childitem',
  gci: 'get-childitem',
  gi: 'get-item',
  cat: 'get-content',
  type: 'get-content',
  gc: 'get-content',
  sls: 'select-string',
  select: 'select-object',
  measure: 'measure-object',
  echo: 'write-output',
  write: 'write-output',
  sc: 'set-content',
  ac: 'add-content',
  cp: 'copy-item',
  copy: 'copy-item',
  cpi: 'copy-item',
  mv: 'move-item',
  move: 'move-item',
  mi: 'move-item',
  rm: 'remove-item',
  rmdir: 'remove-item',
  del: 'remove-item',
  erase: 'remove-item',
  rd: 'remove-item',
  ri: 'remove-item',
  iwr: 'invoke-webrequest',
  curl: 'invoke-webrequest',
  wget: 'invoke-webrequest',
  irm: 'invoke-restmethod',
  icm: 'invoke-command',
  saps: 'start-process',
  start: 'start-process',
  ii: 'invoke-item',
};
const networkCommands = new Set([
  'curl.exe',
  'wget.exe',
  'ssh',
  'ssh.exe',
  'scp',
  'scp.exe',
  'sftp',
  'sftp.exe',
  'ftp.exe',
  'ping',
  'ping.exe',
  'tracert',
  'tracert.exe',
  'nslookup',
  'nslookup.exe',
  'test-connection',
  'test-netconnection',
  'resolve-dnsname',
  'invoke-command',
  'enter-pssession',
  'new-pssession',
]);
const delegatedCommands = new Set([
  'invoke-command',
  'enter-pssession',
  'new-pssession',
  'invoke-wmimethod',
  'invoke-cimmethod',
  'register-scheduledtask',
  'start-scheduledtask',
  'schtasks.exe',
  'register-scheduledjob',
  'start-bitstransfer',
  'bitsadmin.exe',
  'start-service',
  'stop-service',
  'set-service',
  'restart-service',
  'new-service',
  'sc.exe',
  'invoke-item',
  'wmic.exe',
]);
const destructiveCommands = new Set([
  'format-volume',
  'clear-disk',
  'remove-partition',
  'format',
  'format.com',
]);

function commandName(value: string) {
  const name = value.toLowerCase();
  const bare = !/[\\/:]/u.test(name);
  const leaf = win32.basename(name);
  return {
    name: bare && Object.hasOwn(aliases, leaf) ? aliases[leaf]! : leaf,
    bare,
    module: /^microsoft\.powershell\.(core|management|utility)\\[^\\/:]+$/u.exec(name)?.[1],
  };
}

function pathText(value: string) {
  return value.replace(/^(?:Microsoft\.PowerShell\.Core\\)?FileSystem::/iu, '');
}

function argumentPaths(invocation: Invocation, command: Command, paths: PathInput[]) {
  let known = true;
  let positional = 0;
  let namedValue = false;
  const pathStart = paths.length;
  const arguments_ = invocation.arguments;
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]!;
    const parameter = argument.parameter?.toLowerCase();
    const role = parameter ? command.parameters?.[parameter] : command.positional?.[positional++];
    if (role === 'switch') {
      if (argument.attached) known = false;
      continue;
    }
    if (!role) {
      known = false;
      continue;
    }
    if (parameter) namedValue = true;
    const value =
      parameter && !argument.attached && arguments_[index + 1]?.parameter === undefined
        ? arguments_[++index]?.value
        : argument.value;
    if (typeof value !== 'string') known = false;
    else if (role !== 'text') paths.push({ value, use: role });
  }
  const explicitPaths = paths.slice(pathStart);
  // Mixed binding and pipeline-supplied path arguments can target a different object.
  if (namedValue && positional > 0) return false;
  const expected = command.positional ?? [];
  for (const role of ['write', 'remove'] as const)
    if (expected.includes(role) && !explicitPaths.some((path) => path.use === role)) return false;
  if (
    invocation.piped &&
    expected.includes('read') &&
    !explicitPaths.some((path) => path.use === 'read')
  )
    return false;
  return known;
}

function nativeArguments(invocation: Invocation) {
  const args: string[] = [];
  for (const argument of invocation.arguments) {
    if (argument.attached) return;
    const value = argument.parameter ? `-${argument.parameter}` : argument.value;
    if (
      value === null ||
      value.includes('"') ||
      value === '--%' ||
      (value.endsWith('\\') && /\s/u.test(value)) ||
      Array.from(value).some((character) => character.charCodeAt(0) < 32)
    )
      return;
    args.push(value);
  }
  return args;
}

function within(root: string, path: string) {
  const relative = win32.relative(root, path);
  return relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative);
}

function networkPath(value: string) {
  return /^[\\/]{2}(?:[^?.]|\?[\\/]unc[\\/])/iu.test(value);
}

async function ordinaryWorkspacePath(root: string, path: string, signal?: AbortSignal) {
  let current = root;
  for (const segment of win32.relative(root, path).split('\\').filter(Boolean)) {
    signal?.throwIfAborted();
    current = win32.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }
  return true;
}

export interface PowerShellAssessment {
  readonly readOnly: boolean;
  readonly uncertain: boolean;
  readonly network: boolean;
  readonly outsideWrite: boolean;
  readonly denial: string | null;
}

export interface PowerShellClassification extends PowerShellAssessment {
  readonly entryScript?: string;
  readonly pinRipgrep?: true;
  readonly gitQuery?: readonly string[];
}

export function createPowerShellCommandPolicy(
  shell: WindowsPowerShell,
  workspace: string,
  rg: string,
  gitAvailable = false,
) {
  const identities = [shell.executable, shell.engine];
  const cache = new Map<string, Syntax>();
  const systemRoot = win32.dirname(shell.systemDirectory);
  const bundledRg = rg.toLowerCase().replaceAll('/', '\\');
  return {
    assets: identities.map((identity) => ({ path: identity.canonical, digest: identity.digest! })),
    async assess(
      source: string,
      cwd = workspace,
      signal?: AbortSignal,
    ): Promise<PowerShellClassification> {
      if (source.includes('\0') || Buffer.from(source).toString('utf8') !== source)
        throw new AgentError('invalid_shell_arguments');
      let syntax = cache.get(source);
      if (!syntax) {
        try {
          syntax = JSON.parse(
            await runWindowsPowerShellInspection(shell, inspectAst, source, signal),
          ) as Syntax;
          if (!Array.isArray(syntax.commands) || !Array.isArray(syntax.redirects)) throw Error();
          if (source.length <= 8192) {
            if (cache.size >= 32) cache.delete(cache.keys().next().value!);
            cache.set(source, syntax);
          }
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof Error && error.message === 'confined_launch_asset_changed')
            throw new AgentError('shell_parser_asset_changed');
          throw new AgentError('shell_parser_failed');
        }
      } else {
        await verifyLaunchIdentitiesAsync(identities, signal);
      }
      signal?.throwIfAborted();
      let uncertain = !syntax.simple || !within(workspace, cwd);
      let network = networkPath(cwd);
      let outsideWrite = false;
      let denial = syntax.valid ? null : 'shell_command_syntax_invalid';
      const paths: PathInput[] = [];
      let pinRipgrep = false;
      let gitQuery: readonly string[] | undefined;
      for (const invocation of syntax.commands) {
        if (!invocation.name) {
          uncertain = true;
          continue;
        }
        const { name, bare, module } = commandName(invocation.name);
        const specification = Object.hasOwn(commands, name) ? commands[name] : undefined;
        if (specification?.network || networkCommands.has(name)) network = true;
        const parameters = invocation.arguments.filter((argument) => argument.parameter);
        if (parameters.some((argument) => argument.parameter!.toLowerCase() === 'computername'))
          network = true;
        if (destructiveCommands.has(name)) denial = 'shell_command_hard_denied';
        if (
          delegatedCommands.has(name) ||
          (name === 'start-process' &&
            (!parameters.some(
              (argument) =>
                argument.parameter!.toLowerCase() === 'nonewwindow' && !argument.attached,
            ) ||
              parameters.some((argument) => argument.parameter!.toLowerCase() === 'verb')))
        )
          denial = 'shell_powershell_delegation_unsupported';
        if (
          invocation.name.toLowerCase().replaceAll('/', '\\') === bundledRg ||
          (bare && ['rg', 'rg.exe'].includes(name))
        ) {
          const args = nativeArguments(invocation);
          const operands = args && readOnlyRipgrepPaths(args);
          if (!operands) uncertain = true;
          else {
            for (const value of operands) if (value !== '-') paths.push({ value, use: 'read' });
            pinRipgrep ||= bare;
          }
        } else if (gitAvailable && bare && ['git', 'git.exe'].includes(name)) {
          const args = nativeArguments(invocation);
          const query = args && windowsGitQuery(args);
          if (
            !query ||
            syntax.commands.length !== 1 ||
            !invocation.bareStatement ||
            args?.some(networkPath)
          )
            uncertain = true;
          else {
            gitQuery = query;
          }
        } else if (specification) {
          if (!bare && module !== specification.module) uncertain = true;
          if (!argumentPaths(invocation, specification, paths)) uncertain = true;
          if (name === 'remove-item') {
            // Scan literal candidates even when an unknown option prevents exact binding.
            for (const argument of invocation.arguments)
              if (argument.value !== null && !argument.parameter)
                paths.push({ value: argument.value, use: 'remove' });
          }
        } else uncertain = true;
        if (uncertain)
          for (const argument of invocation.arguments)
            if (argument.value && networkPath(pathText(argument.value))) network = true;
      }
      for (const redirect of syntax.redirects) {
        if (redirect.value === null) uncertain = true;
        else paths.push({ value: redirect.value, use: 'write' });
      }
      let writes = false;
      for (const input of paths) {
        const value = pathText(input.value);
        const writing = input.use !== 'read';
        writes ||= writing;
        if (networkPath(value)) {
          network = true;
          outsideWrite ||= writing;
          continue;
        }
        if (
          !value ||
          /^[\\/]{2}/u.test(value) ||
          /^[a-z]:(?![\\/])/iu.test(value) ||
          /:/u.test(value.replace(/^[a-z]:/iu, ''))
        ) {
          uncertain = true;
          outsideWrite ||= writing && !!value;
          continue;
        }
        const resolved = win32.resolve(cwd, value);
        const wildcard = resolved.search(/[*?[\]]/u);
        const base = wildcard < 0 ? resolved : resolved.slice(0, wildcard);
        if (
          input.use === 'remove' &&
          (base === win32.parse(resolved).root ||
            within(systemRoot, base) ||
            (wildcard >= 0 && systemRoot.toLowerCase().startsWith(base.toLowerCase())))
        )
          denial = 'shell_command_hard_denied';
        if (wildcard >= 0) uncertain = true;
        if (!within(workspace, resolved)) {
          outsideWrite ||= writing;
          if (!writing) uncertain = true;
        } else if (!(await ordinaryWorkspacePath(workspace, resolved, signal))) uncertain = true;
      }
      const readOnly = !denial && !uncertain && !network && !writes;
      return {
        uncertain,
        network,
        outsideWrite,
        denial,
        readOnly,
        ...(syntax.entryScript ? { entryScript: syntax.entryScript } : {}),
        ...(readOnly && pinRipgrep ? { pinRipgrep: true } : {}),
        ...(readOnly && gitQuery ? { gitQuery } : {}),
      };
    },
  };
}

export function powerShellScopeDenial(
  assessment: PowerShellAssessment,
  scope: { filesystem: string; network: string },
) {
  if (assessment.denial) return assessment.denial;
  if (assessment.network && scope.network !== 'internet')
    return 'shell_network_permission_required';
  if (assessment.outsideWrite && scope.filesystem !== 'full_access')
    return 'shell_filesystem_permission_required';
  return null;
}
