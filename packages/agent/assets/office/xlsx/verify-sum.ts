// Kite's narrow OfficeCLI delivery check. Run only on an authorized working copy.
import { execFileSync } from 'node:child_process';
import { copyFileSync, constants, linkSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';

function verify() {
  const [input, output, cell, formula, expected] = process.argv.slice(2);
  const target = /^\/([\p{L}\p{N}_ -]{1,31})\/([A-Z]{1,3})([1-9]\d{0,6})$/u.exec(cell ?? '');
  const range = /^SUM\(([A-Z]{1,3})([1-9]\d{0,6}):([A-Z]{1,3})([1-9]\d{0,6})\)$/i.exec(formula ?? '');
  if (process.argv.length !== 7 || !input || !output || !target || !range ||
      extname(input).toLowerCase() !== '.xlsx' || extname(output).toLowerCase() !== '.xlsx' ||
      !/^(?:0|-?[1-9]\d{0,14})$/.test(expected ?? ''))
    throw Error('xlsx_sum_check_invalid');
  const col = (name: string) => [...name.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  const left = col(range[1]!), right = col(range[3]!), top = Number(range[2]), bottom = Number(range[4]);
  const x = col(target[2]!), y = Number(target[3]);
  if (right < left || bottom < top || right > 16384 || x > 16384 || bottom > 1048576 ||
      y > 1048576 || (right - left + 1) * (bottom - top + 1) > 16 ||
      (x >= left && x <= right && y >= top && y <= bottom))
    throw Error('xlsx_sum_check_unsupported');
  if (!statSync(input).isFile() || statSync(input).size > 16 * 1024 * 1024)
    throw Error('xlsx_sum_check_input_invalid');
  const cli = process.env.KITE_OFFICE_CLI;
  if (!cli || !isAbsolute(cli)) throw Error('xlsx_sum_check_cli_unavailable');
  const validator = process.env.KITE_DOCUMENTS_HELPER;
  if (!validator || !isAbsolute(validator)) throw Error('xlsx_sum_check_validator_unavailable');
  const directory = mkdtempSync(join(dirname(resolve(output)), '.kite-xlsx-'));
  const copy = join(directory, 'check.xlsx');
  try {
    copyFileSync(input, copy, constants.COPYFILE_EXCL);
    const command = (verb: string, path: string, ...args: string[]) => {
      let result;
      try {
        result = JSON.parse(execFileSync(cli, [verb, copy, path, ...args, '--json'], {
          encoding: 'utf8', timeout: 10000, maxBuffer: 512 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, OFFICECLI_NO_AUTO_RESIDENT: '1', OFFICECLI_SKIP_UPDATE: '1' },
        }));
      } catch {
        throw Error('xlsx_sum_check_cli_failed');
      }
      if (result.success !== true) throw Error('xlsx_sum_check_cli_failed');
      return result.data;
    };
    const get = (path: string) => {
      const data = command('get', path);
      if (data?.matches !== 1 || data.results?.[0]?.path !== path || !data.results[0].format)
        throw Error('xlsx_sum_check_cell_missing');
      return data.results[0].format;
    };
    const name = (c: number) => {
      let result = '';
      for (; c > 0; c = Math.floor((c - 1) / 26))
        result = String.fromCharCode(65 + ((c - 1) % 26)) + result;
      return result;
    };
    const current = get(cell!);
    if (current.formula !== formula) throw Error('xlsx_sum_check_formula_changed');
    const sheet = '/' + target[1] + '/';
    const byPath = new Map<string, { text?: string; format?: { type?: string; formula?: string } }>();
    const first = name(left) + top, last = name(right) + bottom;
    if (first === last) {
      const data = command('get', sheet + first);
      if (data?.matches === 1 && data.results?.[0]?.path === sheet + first)
        byPath.set(sheet + first, data.results[0]);
    } else {
      const path = sheet + first + ':' + last;
      const data = command('get', path);
      if (data?.matches === 1 && data.results?.[0]?.path === path)
        for (const child of data.results[0].children ?? []) byPath.set(child.path, child);
    }
    for (let row = top; row <= bottom; row++) {
      for (let c = left; c <= right; c++) {
        const operand = byPath.get(sheet + name(c) + row);
        if (operand?.format?.type !== 'Number' || Object.hasOwn(operand.format, 'formula') ||
            !/^(?:0|-?[1-9]\d{0,14})$/.test(operand.text ?? ''))
          throw Error('xlsx_sum_check_unsupported');
      }
    }
    if (current.computedValue !== expected || current.evaluated !== true)
      throw Error('xlsx_sum_check_result_mismatch');
    // OfficeCLI get resolves shared formulas to ordinary text. Its set can sever
    // the shared anchor, so prove this is a standalone cell before publishing.
    const xml = command('raw', '/' + target[1], '--start', target[3]!, '--end', target[3]!, '--cols', target[2]!);
    try {
      const proof = JSON.parse(execFileSync(process.execPath,
        ['--no-install', validator, 'xlsx-formula-guard', '--input', '-'], {
          input: JSON.stringify({ xml, address: target[2]! + target[3]!, formula }),
          encoding: 'utf8', timeout: 10000, maxBuffer: 4096,
          stdio: ['pipe', 'pipe', 'pipe'],
        }));
      if (proof.success !== true) throw Error('invalid_proof');
    } catch {
      throw Error('xlsx_sum_check_formula_unverified');
    }
    if (current.cachedValue !== expected)
      command('set', cell!, '--prop', 'formula=' + formula);
    const saved = get(cell!);
    if (saved.formula !== formula || saved.type !== 'Number' || saved.cachedValue !== expected ||
        saved.computedValue !== expected || saved.evaluated !== true)
      throw Error('xlsx_sum_check_result_mismatch');
    linkSync(copy, resolve(output));
    console.log(JSON.stringify({ success: true, cell, formula, cachedValue: saved.cachedValue }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

try {
  verify();
} catch (error) {
  console.error(JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'xlsx_sum_check_failed' }));
  process.exitCode = 1;
}
