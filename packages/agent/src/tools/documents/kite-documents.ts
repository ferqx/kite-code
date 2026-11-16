import { createReadStream } from 'node:fs';
import { createPdfDocument } from './pdf-command';

const options = new Map<string, string>();
try {
  if (process.argv[2] !== 'pdf') throw Error('documents_command_invalid');
  for (let i = 3; i < process.argv.length; i += 2) {
    const key = process.argv[i]!,
      value = process.argv[i + 1];
    if (!['--input', '--out'].includes(key) || value === undefined || options.has(key))
      throw Error('documents_arguments_invalid');
    options.set(key, value);
  }
  const input = options.get('--input'),
    out = options.get('--out');
  if (!input || !out) throw Error('documents_arguments_invalid');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of input === '-' ? process.stdin : createReadStream(input)) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 8 * 1024 * 1024) throw Error('documents_input_limit');
    chunks.push(bytes);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const controller = new AbortController();
  const stop = () => controller.abort(Error('documents_cancelled'));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const result = await createPdfDocument({ spec: data, out, signal: controller.signal });
    console.log(JSON.stringify(result));
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
} catch (error) {
  console.error(
    JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message.slice(0, 3000) : 'documents_failed',
    }),
  );
  process.exitCode = 1;
}
