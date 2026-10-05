const fs = require('node:fs'),
  cp = require('node:child_process');
const [bun, helper, dataRoot, profile, path] = process.argv.slice(2);
const fd = fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
let closed = false;
const child = cp.spawnSync(bun, [helper, 'inherited', dataRoot, profile], {
  stdio: ['ignore', 'pipe', 'pipe', fd],
  encoding: 'utf8',
  timeout: 10000,
});
if (child.status !== 0) throw Error(JSON.stringify(child));
process.send({
  event: 'ready',
  result: JSON.parse(child.stdout),
  fdIdentity: { dev: fs.fstatSync(fd).dev, ino: fs.fstatSync(fd).ino },
});
process.on('message', (message) => {
  if (message === 'close') {
    fs.closeSync(fd);
    closed = true;
    process.send({ event: 'closed' });
    process.disconnect();
  }
  if (message === 'unrelated') {
    const unrelated = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
    });
    unrelated.once('spawn', () => unrelated.kill('SIGTERM'));
    unrelated.once('exit', (code, signal) =>
      process.send({ event: 'unrelated-exited', code, signal }),
    );
  }
});
process.on('disconnect', () => {
  if (!closed) fs.closeSync(fd);
  process.exit(0);
});
