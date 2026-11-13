import { writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readProcessStartIdentity } from '../../../service/src/daemon/process-identity';

// Passive preload: the actual development front door and every spawn argument stay intact.
const childProcess = createRequire(import.meta.url)(
  'node:child_process',
) as typeof import('node:child_process');
const original = childProcess.spawn;
const serviceEntry = process.env.KITE_MANAGEMENT_SERVICE_ENTRY;
const observationPath = process.env.KITE_MANAGEMENT_OBSERVATION;
childProcess.spawn = ((...args: unknown[]) => {
  const child = Reflect.apply(original, childProcess, args) as ReturnType<typeof original>;
  const cmd = [args[0], ...(Array.isArray(args[1]) ? args[1] : [])];
  if (child.pid && observationPath && serviceEntry && cmd.includes(serviceEntry)) {
    const observation = { pid: child.pid, start: readProcessStartIdentity(child.pid), cmd };
    writeFileSync(observationPath, JSON.stringify(observation));
    child.once('exit', (code) => {
      writeFileSync(`${observationPath}.exit`, JSON.stringify({ ...observation, code }));
    });
  }
  return child;
}) as typeof original;
syncBuiltinESMExports();
