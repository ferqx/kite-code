import { createRequire, syncBuiltinESMExports } from 'node:module';

// Guard the actual argv process against accidental networking or owned child startup.
const childProcess = createRequire(import.meta.url)(
  'node:child_process',
) as typeof import('node:child_process');
const refuse = () => {
  throw Error('trace_started_child');
};
childProcess.spawn = refuse;
childProcess.spawnSync = refuse;
childProcess.exec = Object.assign(refuse, { __promisify__: refuse });
childProcess.execFile = Object.assign(refuse, { __promisify__: refuse });
childProcess.fork = refuse;
syncBuiltinESMExports();
globalThis.fetch = () => {
  throw Error('trace_network_attempt');
};
