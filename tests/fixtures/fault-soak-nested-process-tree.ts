export {};

const nested = Bun.spawn(
  ['/bin/sh', '-c', 'sleep 30 & grandchild=$!; printf "%s\\n" "$grandchild"; wait'],
  {
    detached: true,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  },
);

process.stdout.write(`${nested.pid}\n`);
const reader = nested.stdout.getReader();
while (true) {
  const chunk = await reader.read();
  if (chunk.done) break;
  process.stdout.write(chunk.value);
  if (new TextDecoder().decode(chunk.value).includes('\n')) break;
}
reader.releaseLock();
await nested.exited;
