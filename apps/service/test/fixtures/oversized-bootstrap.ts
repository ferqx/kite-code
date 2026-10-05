for await (const bytes of Bun.stdin.stream()) {
  if (bytes.byteLength) {
    process.stdout.write('x'.repeat(16 * 1024 + 1));
    break;
  }
}
await new Promise(() => {});

export {};
