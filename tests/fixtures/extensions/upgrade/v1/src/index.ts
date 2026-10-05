import { factory } from '../../factory';
export function createUpgrade(root: string, scope: string) {
  return factory('1', 1, new URL('../asset.txt', import.meta.url).pathname, root, scope);
}
