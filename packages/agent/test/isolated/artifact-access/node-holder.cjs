const fs = require('node:fs'),
  cp = require('node:child_process');
const [bun, helper, root, path, mode = 'release'] = process.argv.slice(2);
const fd = fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
let closed = false;
function ready(result, helperSignal = null) {
  process.send({
    event: 'ready',
    result,
    helperSignal,
    fdIdentity: { dev: fs.fstatSync(fd).dev, ino: fs.fstatSync(fd).ino },
  });
}
if (mode === 'kill_helper') {
  const child = cp.spawn(bun, [helper, 'hold', root], { stdio: ['ignore', 'pipe', 'pipe', fd] });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
    if (output.includes('\n')) child.kill('SIGKILL');
  });
  child.once('exit', (_code, signal) => ready(JSON.parse(output.trim()), signal));
} else {
  const child = cp.spawnSync(bun, [helper, 'inherited', root], {
    stdio: ['ignore', 'pipe', 'pipe', fd],
    encoding: 'utf8',
    timeout: 10000,
  });
  if (child.status !== 0) throw Error(JSON.stringify(child));
  ready(JSON.parse(child.stdout));
}
process.on('message', (message) => {
  if (message === 'close') {
    fs.closeSync(fd);
    closed = true;
    process.send({ event: 'closed' });
    process.disconnect();
  }
});
process.on('disconnect', () => {
  if (!closed) fs.closeSync(fd);
  process.exit(0);
});
