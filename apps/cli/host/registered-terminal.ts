import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { parseCLIArguments } from '../src/arguments';
import {
  assertManagedCLIPrefix,
  type CLIRegistration,
  readCLIRegistration,
  readManagedCLIActive,
  sameCLIRegistration,
} from './cli-registration';
import type { CLIServiceArtifact } from './index';
import { selectNativeTerminalArtifact } from './native-artifact';
import { verifyTerminalBundle } from './terminal-artifact';
import { parseTUIArguments } from './tui-arguments';

interface TerminalSelection {
  artifact: Readonly<CLIServiceArtifact>;
  registration?: Readonly<CLIRegistration>;
  close(): void;
}

export function acquireNativeTerminalSelection(candidateRoot: string): TerminalSelection {
  const root = realpathSync(candidateRoot);
  const leases: ReturnType<typeof acquireArtifactAccess>[] = [];
  try {
    for (const selected of [root, join(root, 'terminal')])
      leases.push(acquireArtifactAccess({ root: selected, mode: 'shared' }));
    const selected = selectNativeTerminalArtifact(root);
    return {
      artifact: selected.artifact,
      close: () => {
        for (const lease of leases.splice(0).reverse()) lease.release();
      },
    };
  } catch (error) {
    for (const lease of leases.reverse()) lease.release();
    throw error;
  }
}
/** The installed frontdoor is separate from the explicit candidate/source entry. */
export function acquireRegisteredTerminalSelection(candidateRoot: string): TerminalSelection {
  const root = realpathSync(candidateRoot);
  const prefix = dirname(dirname(root));
  if (basename(dirname(root)) !== 'releases' || !/^[a-f0-9]{64}$/.test(basename(root)))
    throw Error('cli_registration_candidate_invalid');
  assertManagedCLIPrefix(prefix);
  const original = acquireArtifactAccess({ root, mode: 'shared' });
  let native: ReturnType<typeof acquireNativeTerminalSelection> | undefined;
  try {
    const terminal = verifyTerminalBundle(root);
    const registration = readCLIRegistration(prefix);
    if (!registration) return { artifact: terminal.artifact, close: () => original.release() };
    assertManagedCLIPrefix(registration.nativePrefix, true);
    if (!sameCLIRegistration(registration, readCLIRegistration(registration.nativePrefix, true)))
      throw Error('cli_registration_owner_mismatch');
    if (readManagedCLIActive(registration.nativePrefix) !== registration.candidateId)
      throw Error('cli_registration_changed');
    native = acquireNativeTerminalSelection(
      join(registration.nativePrefix, 'releases', registration.candidateId),
    );
    if (
      !sameCLIRegistration(registration, readCLIRegistration(prefix)) ||
      !sameCLIRegistration(registration, readCLIRegistration(registration.nativePrefix, true)) ||
      readManagedCLIActive(registration.nativePrefix) !== registration.candidateId
    )
      throw Error('cli_registration_changed');
    const selected = native;
    return {
      artifact: selected.artifact,
      registration,
      close: () => {
        selected.close();
        original.release();
      },
    };
  } catch (error) {
    native?.close();
    original.release();
    throw error;
  }
}
async function runSelected(
  argv: readonly string[],
  root: string,
  tui: boolean,
  native: boolean,
): Promise<number> {
  const pure = tui
    ? parseTUIArguments(argv).kind !== 'tui' || !process.stdin.isTTY || !process.stdout.isTTY
    : ['help', 'version', 'trace'].includes(parseCLIArguments(argv).kind);
  const selection = pure
    ? undefined
    : native
      ? acquireNativeTerminalSelection(root)
      : acquireRegisteredTerminalSelection(root);
  try {
    if (!native && selection && 'registration' in selection && selection.registration) {
      const registration = selection.registration;
      if (
        !sameCLIRegistration(registration, readCLIRegistration(registration.terminalPrefix)) ||
        !sameCLIRegistration(registration, readCLIRegistration(registration.nativePrefix, true)) ||
        readManagedCLIActive(registration.nativePrefix) !== registration.candidateId
      )
        throw Error('cli_registration_changed');
      const fresh = selectNativeTerminalArtifact(
        join(registration.nativePrefix, 'releases', registration.candidateId),
      );
      if (fresh.artifact.buildId !== selection.artifact.buildId)
        throw Error('cli_registration_changed');
      const env = { ...process.env };
      for (const key of ['NODE_PATH', 'NODE_OPTIONS', 'BUN_OPTIONS', 'ELECTRON_RUN_AS_NODE'])
        delete env[key];
      // No business client runs in this frontdoor: CLI, SDK and Bun come from the selected Native closure.
      const ignoreInterrupt = () => {};
      let child: ReturnType<typeof Bun.spawn> | undefined;
      let terminating = false;
      const terminate = () => {
        terminating = true;
        if (child && child.exitCode === null) child.kill('SIGTERM');
      };
      // Foreground SIGINT already reaches the child group; forwarding would cancel twice.
      process.on('SIGINT', ignoreInterrupt);
      process.on('SIGTERM', terminate);
      try {
        child = Bun.spawn(
          [
            fresh.artifact.executable,
            join(fresh.bundle.terminal.root, `entrypoints/native-${tui ? 'tui' : 'cli'}.js`),
            ...argv,
          ],
          { cwd: process.cwd(), env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
        );
        if (terminating) child.kill('SIGTERM');
        return await child.exited;
      } finally {
        process.removeListener('SIGINT', ignoreInterrupt);
        process.removeListener('SIGTERM', terminate);
      }
    }
    const input = {
      argv,
      ...(selection
        ? { artifact: selection.artifact, resolveArtifact: () => selection.artifact }
        : {}),
      dataRoot: join(homedir(), '.kite-code', 'unified-agent'),
      profile: 'default',
    };
    return tui
      ? await (await import('./tui-main')).runTUIProcess(input)
      : await (await import('./main')).runCLIProcess(input);
  } finally {
    selection?.close();
  }
}
export const runRegisteredTerminalCLI = (argv: readonly string[], root: string) =>
  runSelected(argv, root, false, false);
export const runRegisteredTerminalTUI = (argv: readonly string[], root: string) =>
  runSelected(argv, root, true, false);
export const runNativeTerminalCLI = (argv: readonly string[], root: string) =>
  runSelected(argv, root, false, true);
export const runNativeTerminalTUI = (argv: readonly string[], root: string) =>
  runSelected(argv, root, true, true);
