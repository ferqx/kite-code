import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const linuxTest = process.platform === 'linux' ? test : test.skip;
for (const kind of ['shell', 'stdio']) {
  linuxTest(
    `${kind} unknown-owner diagnostic handles interrupted, short and failed writes without releasing ownership`,
    () => {
      const root = mkdtempSync(join(tmpdir(), 'kite-linux-diagnostic-'));
      try {
        const source = join(root, 'probe.c');
        const binary = join(root, 'probe');
        const original = resolve(import.meta.dir, `../../../native/linux-${kind}-init.c`);
        writeFileSync(
          source,
          `#define _GNU_SOURCE
#include <unistd.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
static int mode, calls;
static ssize_t diagnostic_write(int fd, const void *buffer, size_t size);
static int diagnostic_pause(void);
#define write diagnostic_write
#define pause diagnostic_pause
#define main original_main
#include ${JSON.stringify(original)}
#undef main
#undef write
#undef pause
static ssize_t diagnostic_write(int fd, const void *buffer, size_t size) {
  const char expected[] = "kite_linux_${kind}_close_unknown\\n";
  calls++;
  if (fd != STDERR_FILENO || size != sizeof(expected) - 1 || memcmp(buffer, expected, size)) _exit(80);
  if (mode == 1 && calls == 1) { errno = EINTR; return -1; }
  if (mode == 2) return (ssize_t)size - 1;
  if (mode == 3) { errno = EIO; return -1; }
  return (ssize_t)size;
}
static int diagnostic_pause(void) {
  if (calls != (mode == 1 ? 2 : 1)) _exit(81);
  if (unknown != (mode >= 2 ? 1 : 0)) _exit(82);
  _exit(0);
}
int main(int argc, char **argv) {
  if (argc != 2) return 83;
  mode = atoi(argv[1]);
  retain_unknown();
}
`,
        );
        const compiled = spawnSync(
          'cc',
          [
            '-std=c11',
            '-O2',
            '-Wall',
            '-Wextra',
            '-Werror',
            '-fstack-protector-strong',
            '-D_FORTIFY_SOURCE=2',
            '-fPIE',
            '-pie',
            '-Wl,-z,relro,-z,now',
            source,
            '-o',
            binary,
          ],
          { encoding: 'utf8', timeout: 10000 },
        );
        expect(compiled.error).toBeUndefined();
        expect(compiled.status, compiled.stderr).toBe(0);
        for (const mode of ['0', '1', '2', '3']) {
          const result = spawnSync(binary, [mode], { encoding: 'utf8', timeout: 2000 });
          expect(result.error).toBeUndefined();
          expect(result.status, result.stderr).toBe(0);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
