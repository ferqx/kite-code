import { createReadStream } from 'node:fs';
import { stageDocument } from './document-export';
import { createPdfDocument } from './pdf-command';

const options = new Map<string, string>();
try {
  const command = process.argv[2];
  if (command !== 'pdf' && command !== 'stage') throw Error('documents_command_invalid');
  for (let i = 3; i < process.argv.length; i += 2) {
    const key = process.argv[i]!,
      value = process.argv[i + 1];
    if (!['--input', '--out'].includes(key) || value === undefined || options.has(key))
      throw Error('documents_arguments_invalid');
    options.set(key, value);
  }
  const input = options.get('--input'),
    out = options.get('--out');
  if (!input || (command === 'pdf' ? !out : out !== undefined))
    throw Error('documents_arguments_invalid');
  let spec: unknown;
  if (command === 'pdf') {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of input === '-' ? process.stdin : createReadStream(input)) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > 8 * 1024 * 1024) throw Error('documents_input_limit');
      chunks.push(bytes);
    }
    spec = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const controller = new AbortController();
  const stop = () => controller.abort(Error('documents_cancelled'));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const result =
      command === 'stage'
        ? await stageDocument(input, controller.signal)
        : await createPdfDocument({ spec, out: out!, signal: controller.signal });
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
