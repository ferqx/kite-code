import { factory } from '../../factory';
export function createUpgrade(root: string, scope: string) {
  return factory('2', 10, new URL('../asset.txt', import.meta.url).pathname, root, scope);
}
