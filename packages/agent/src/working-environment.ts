export interface WorkingEnvironment {
  readonly platform: string;
  readonly ripgrepVersion?: string;
  readonly shell?:
    | { readonly kind: 'posix'; readonly executable: string }
    | {
        readonly kind: 'powershell';
        readonly version: string;
        readonly edition: 'Desktop' | 'Core';
        readonly locale?: string;
      }
    | { readonly kind: 'git-bash'; readonly version?: string; readonly locale?: string };
}

const platformNames: Readonly<Record<string, string>> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};

export function renderWorkingEnvironment(
  workspaceRoot: string,
  environment?: WorkingEnvironment,
): string {
  const lines = ['# Working environment', `Workspace root: ${workspaceRoot}`];
  if (!environment) return lines.join('\n');
  const { platform, shell, ripgrepVersion } = environment;
  lines.push(`Operating system: ${platformNames[platform] ?? platform}`);
  if (!shell) return lines.join('\n');

  switch (shell.kind) {
    case 'posix':
      lines.push(
        `Shell: ${shell.executable} (POSIX)`,
        'When unsure about a required program, check its resolution and supported version in the same Job.',
      );
      break;
    case 'powershell':
      lines.push(
        `Shell: ${shell.edition === 'Desktop' ? 'Windows ' : ''}PowerShell ${shell.version}`,
        "Use PowerShell cmdlets and Windows paths. PowerShell on Windows passes wildcard paths such as packages/*/package.json literally to rg. Pass directories to rg and filter files with -g, as in `rg -n -g 'package.json' 'name' packages apps`.",
        'For each required native step in a script, check $LASTEXITCODE immediately and exit with that code on failure. Pass structured input through stdin or a file when supported.',
        'Probe an uncertain executable with a standalone Get-Command NAME. Keep its diagnostics and verify the candidate by its absolute path with the supported version probe before considering installation.',
      );
      if (shell.edition === 'Desktop') lines.push('Supply -UseBasicParsing for Invoke-WebRequest.');
      break;
    case 'git-bash':
      lines.push(
        `Shell: Git Bash${shell.version ? ` ${shell.version}` : ''} on Windows`,
        'Check required steps before continuing. Use pipefail when every stage of a pipeline must succeed.',
        'Probe an uncertain executable with a standalone type NAME. Keep its diagnostics and verify the candidate by its absolute path with the supported version probe before considering installation.',
      );
      break;
  }
  if (shell.kind !== 'posix') {
    if (shell.locale) lines.push(`Windows user locale: ${shell.locale}`);
    lines.push(
      'Kite decodes stdout and stderr as UTF-8. Messages, regional formats, and encoding can vary by program. Prefer exit codes and structured output. Use the program’s locale option when the task calls for one.',
    );
  }
  if (ripgrepVersion) lines.push(`Bundled ripgrep (rg) version: ${ripgrepVersion}`);
  lines.push(
    'Each Shell call starts a fresh process in the session execution root or the requested workdir. Directory and environment changes are local to the call. Save intermediate files needed by later Jobs in the workspace.',
  );
  return lines.join('\n');
}
