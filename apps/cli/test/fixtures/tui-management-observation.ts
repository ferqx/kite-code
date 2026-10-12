import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { readProcessStartIdentity } = (await import(
  pathToFileURL(resolve(import.meta.dir, '../../../service/src/daemon/process-identity.ts')).href
)) as { readProcessStartIdentity(pid: number): string | undefined };

// Passive preload: the actual development front door and every spawn argument stay intact.
const original = Bun.spawn;
const serviceEntry = process.env.KITE_MANAGEMENT_SERVICE_ENTRY;
const observationPath = process.env.KITE_MANAGEMENT_OBSERVATION;
Bun.spawn = ((...args: unknown[]) => {
  const child = Reflect.apply(original, Bun, args) as Bun.Subprocess;
  const first = args[0] as string[] | { cmd?: string[] };
  const cmd = Array.isArray(first) ? first : first?.cmd;
  if (observationPath && serviceEntry && cmd?.includes(serviceEntry)) {
    const observation = { pid: child.pid, start: readProcessStartIdentity(child.pid), cmd };
    writeFileSync(observationPath, JSON.stringify(observation));
    void child.exited.then((code) => {
      writeFileSync(`${observationPath}.exit`, JSON.stringify({ ...observation, code }));
    });
  }
  return child;
}) as typeof Bun.spawn;
