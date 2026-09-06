import { appendFileSync } from 'node:fs';

const pidPath = process.argv[2];
if (!pidPath) throw new Error('Long-running child requires a PID path.');
appendFileSync(pidPath, `${process.pid}\n`);
setInterval(() => undefined, 1_000);
