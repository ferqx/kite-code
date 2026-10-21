import { execFileSync } from 'node:child_process';

/** Only exact private candidate executables and their observed descendants are test-owned. */
export async function cleanupOwnedNativeCandidate(root: string): Promise<void> {
  const rows = () =>
    String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm=']))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        return {
          pid: Number(parts[0]),
          parent: Number(parts[1]),
          command: parts.slice(2).join(' '),
        };
      });
  const initial = rows(),
    identities = new Map(initial.map((row) => [row.pid, row.command]));
  const targets = new Set(
    initial.filter((row) => row.command.startsWith(`${root}/`)).map((row) => row.pid),
  );
  for (let count = 0; count < initial.length; count++)
    for (const row of initial) if (targets.has(row.parent)) targets.add(row.pid);
  for (const pid of targets)
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  const remaining = () =>
    rows().filter(
      (row) =>
        row.command.startsWith(`${root}/`) ||
        (targets.has(row.pid) && identities.get(row.pid) === row.command),
    );
  const deadline = Date.now() + 2000;
  while (remaining().length && Date.now() < deadline) await Bun.sleep(20);
  const forced: number[] = [];
  for (const row of remaining())
    try {
      process.kill(row.pid, 'SIGKILL');
      forced.push(row.pid);
    } catch {}
  const disappearance = Date.now() + 5000;
  while (remaining().length && Date.now() < disappearance) await Bun.sleep(20);
  const rest = remaining();
  console.log(
    JSON.stringify({
      stage: 'collaboration_owned_cleanup',
      observed: [...targets],
      forced,
      remaining: rest.map((row) => row.pid),
    }),
  );
  if (rest.length) throw Error(`native_owned_cleanup_unconfirmed:${root}`);
}
