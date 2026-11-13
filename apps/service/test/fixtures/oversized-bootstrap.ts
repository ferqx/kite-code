import { startupStdin } from '../../src/bootstrap';

for await (const bytes of startupStdin()) {
  if (bytes.byteLength) {
    process.stdout.write('x'.repeat(16 * 1024 + 1));
    break;
  }
}
await new Promise(() => {});
