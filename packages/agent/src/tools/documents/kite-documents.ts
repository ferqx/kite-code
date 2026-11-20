import { createReadStream } from 'node:fs';
import { SaxesParser } from 'saxes';
import { stageDocument } from './document-export';
import { createPdfDocument } from './pdf-command';

function checkPlainXlsxFormula(input: unknown) {
  const fail = () => {
    throw Error('xlsx_sum_check_formula_unverified');
  };
  if (!input || typeof input !== 'object') return fail();
  const { xml, address, formula } = input as Record<string, unknown>;
  if (
    typeof xml !== 'string' ||
    xml.length > 256 * 1024 ||
    typeof address !== 'string' ||
    typeof formula !== 'string'
  )
    return fail();
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const cellPath = 'worksheet/sheetData/row/c',
    formulaPath = `${cellPath}/f`;
  const names: string[] = [];
  let selected = false,
    cells = 0,
    formulas = 0,
    content = '';
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', fail);
  parser.on('error', fail);
  parser.on('opentag', (tag) => {
    names.push(tag.uri === ns ? tag.local : '');
    if (names.length > 32) fail();
    const path = names.join('/');
    if (path === cellPath && tag.attributes.r?.value === address) {
      if (
        ++cells !== 1 ||
        Object.values(tag.attributes).some(({ local }) => local === 'cm' || local === 'vm')
      )
        fail();
      selected = true;
    } else if (selected && path === formulaPath) {
      if (
        ++formulas !== 1 ||
        Object.values(tag.attributes).some(
          ({ uri, local, value }) =>
            uri !== 'http://www.w3.org/2000/xmlns/' &&
            !(uri === '' && local === 't' && value === 'normal'),
        )
      )
        fail();
    } else if (selected && path.startsWith(`${formulaPath}/`)) {
      fail();
    }
  });
  parser.on('closetag', () => {
    if (names.length === 4) selected = false;
    names.pop();
  });
  const text = (chunk: string) => {
    if (selected && names.join('/') === formulaPath) content += chunk;
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.write(xml).close();
  if (cells !== 1 || formulas !== 1 || content !== formula) fail();
  return { success: true };
}

const options = new Map<string, string>();
try {
  const command = process.argv[2];
  if (command !== 'pdf' && command !== 'stage' && command !== 'xlsx-formula-guard')
    throw Error('documents_command_invalid');
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
  if (command !== 'stage') {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of input === '-' ? process.stdin : createReadStream(input)) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > (command === 'xlsx-formula-guard' ? 512 * 1024 : 8 * 1024 * 1024))
        throw Error('documents_input_limit');
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
        : command === 'pdf'
          ? await createPdfDocument({ spec, out: out!, signal: controller.signal })
          : checkPlainXlsxFormula(spec);
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
