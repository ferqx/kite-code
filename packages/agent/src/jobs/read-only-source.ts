import { dirname, isAbsolute, relative, sep } from 'node:path';
import { type LaunchIdentity, launchIdentity } from './launch-identity';

const within = (root: string, path: string) => {
  const value = relative(root, path);
  return !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`);
};

/** A trusted original Skill tree, never a caller-selected permission exception. */
export function captureReadOnlySource(options: {
  cwd: LaunchIdentity;
  workspace: LaunchIdentity;
  control?: LaunchIdentity;
  protectedRoots: readonly LaunchIdentity[];
  readOnlySourceRoot?: string;
  mode?: 'host' | 'confined';
}): { source: LaunchIdentity; ancestors: LaunchIdentity[] } | undefined {
  if (options.readOnlySourceRoot === undefined) return;
  const source = launchIdentity(options.readOnlySourceRoot);
  const { cwd, workspace, control, protectedRoots } = options;
  if (
    options.mode === 'confined' ||
    !control ||
    source.canonical !== cwd.canonical ||
    within(source.canonical, workspace.canonical) ||
    within(source.canonical, control.canonical) ||
    within(control.canonical, source.canonical) ||
    !protectedRoots.some(
      (root) => root.canonical !== source.canonical && within(root.canonical, source.canonical),
    ) ||
    protectedRoots.some((root) => within(source.canonical, root.canonical))
  )
    throw Error('shell_readonly_source_invalid');
  const ancestors: LaunchIdentity[] = [];
  for (let path = dirname(source.canonical); ; path = dirname(path)) {
    ancestors.push(launchIdentity(path));
    if (dirname(path) === path) break;
  }
  return { source, ancestors };
}
