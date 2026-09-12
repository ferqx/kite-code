import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { DesktopEditor } from '../src/bridge';

export function editorFileTarget(workspace: string, supplied: string): string {
  if (
    !supplied ||
    Buffer.byteLength(supplied, 'utf8') > 8192 ||
    [...supplied].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  )
    throw new Error('文件目标无效。');
  let root: string;
  try {
    root = realpathSync.native(workspace);
  } catch {
    throw new Error('项目已不可用。');
  }
  if (root !== workspace) throw new Error('项目路径发生变化，请重新连接。');
  if (supplied.split(sep).includes('..')) throw new Error('文件目标不能包含上级目录。');
  const unresolved = isAbsolute(supplied) ? supplied : resolve(root, supplied);
  let target: string;
  try {
    target = realpathSync.native(unresolved);
  } catch {
    throw new Error('文件不存在或已不可用。');
  }
  const fromRoot = relative(root, target);
  let file = false;
  try {
    file = statSync(target).isFile();
  } catch {
    file = false;
  }
  if (!file || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
    throw new Error('只能打开当前项目内的普通文件。');
  return target;
}

export async function openEditor(editor: DesktopEditor, target: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('外部编辑器跳转尚未在此平台验证。');
  const application = {
    vscode: 'Visual Studio Code',
    zed: 'Zed',
    textedit: 'TextEdit',
  }[editor];
  const child = spawn('/usr/bin/open', ['-a', application, '--', target], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('打开编辑器超时。'));
    }, 10_000);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('无法启动编辑器。'));
    });
    child.once('close', (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
  if (code !== 0) throw new Error('无法打开文件，请确认所选编辑器已安装。');
}
