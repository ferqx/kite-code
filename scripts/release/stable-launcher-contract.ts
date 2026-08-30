interface ManagedRunTarget {
  readonly command: 'service';
  readonly readinessEnvironmentVariable: 'KITE_SERVICE_READINESS_FD';
}

const MANAGED_RUN_TARGETS: Readonly<Record<string, ManagedRunTarget>> = Object.freeze({
  'kite-service': {
    command: 'service',
    readinessEnvironmentVariable: 'KITE_SERVICE_READINESS_FD',
  },
});

export interface StableLauncherReadinessForwarding {
  readonly environmentVariable: ManagedRunTarget['readinessEnvironmentVariable'];
  readonly fd: 3;
}

/**
 * Validate the only managed process invocation accepted by the stable Service launcher.
 * CLI/TUI launchers intentionally remain argument-transparent.
 * Readiness must be the manager-owned fd 3 marker so a direct or ambiguous invocation cannot
 * accidentally dispatch to a managed Service child.
 */
export function resolveReadinessForwarding(
  executableName: string,
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): StableLauncherReadinessForwarding | undefined {
  const target = MANAGED_RUN_TARGETS[stripExecutableSuffix(executableName)];
  if (target === undefined) return undefined;
  const expected = [target.command, 'run-single'] as const;
  if (args.length !== expected.length || args.some((value, index) => value !== expected[index])) {
    throw new Error(
      `Stable ${target.command} launcher requires the exact \`${target.command} run-single\` arguments.`,
    );
  }
  if (environment[target.readinessEnvironmentVariable] !== '3') {
    throw new Error(
      `Stable ${target.command} launcher requires manager-owned fd 3 readiness forwarding.`,
    );
  }
  return Object.freeze({
    environmentVariable: target.readinessEnvironmentVariable,
    fd: 3,
  });
}

export function stripExecutableSuffix(name: string): string {
  return name.endsWith('.exe') ? name.slice(0, -'.exe'.length) : name;
}
