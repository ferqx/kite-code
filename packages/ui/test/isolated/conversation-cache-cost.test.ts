import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { ConversationCacheCost } from '../../src/desktop/conversation-cache-cost';

function fixture(elements = 1) {
  const dom = new JSDOM('<div id="container"></div>');
  const container = dom.window.document.getElementById('container')!;
  for (let index = 0; index < elements; index++) {
    const node = dom.window.document.createElement('span');
    node.textContent = 'text';
    container.append(node);
  }
  let nextId = 0;
  const tasks = new Map<number, () => void>();
  let scans = 0;
  const createTreeWalker = dom.window.document.createTreeWalker.bind(dom.window.document);
  dom.window.document.createTreeWalker = (...args) => {
    scans++;
    return createTreeWalker(...args);
  };
  const cost = new ConversationCacheCost(container, (task) => {
    const id = ++nextId;
    tasks.set(id, task);
    return () => {
      tasks.delete(id);
    };
  });
  const run = () => {
    const [id, task] = tasks.entries().next().value!;
    tasks.delete(id);
    task();
  };
  return {
    dom,
    container,
    cost,
    tasks,
    run,
    get scans() {
      return scans;
    },
    flush() {
      for (let count = 0; tasks.size; count++) {
        expect(count).toBeLessThan(100);
        run();
      }
    },
    close() {
      cost.stop();
      expect(tasks.size).toBe(0);
      dom.window.close();
    },
  };
}

test('cost scans are scheduled, attributes do not dirty a measured tree, and pending text mutations revoke its estimate synchronously', async () => {
  const f = fixture();
  try {
    f.cost.start();
    expect(f.scans).toBe(0);
    expect(f.cost.snapshot()).toBeUndefined();
    f.flush();
    expect(f.scans).toBe(1);
    const original = f.cost.snapshot()!;
    f.container.className = 'hover';
    f.container.style.display = 'none';
    await Promise.resolve();
    expect(f.cost.snapshot()).toEqual(original);
    expect(f.tasks.size).toBe(0);
    f.container.firstChild!.firstChild!.nodeValue = 'longer text';
    // No MutationObserver delivery has occurred yet: admission must drain records.
    expect(f.cost.snapshot()).toBeUndefined();
    expect(f.scans).toBe(1);
    f.flush();
    expect(f.scans).toBe(2);
    expect(f.cost.snapshot()).toEqual({ nodes: original.nodes, bytes: original.bytes + 14 });
  } finally {
    f.close();
  }
});

test('resources update the known DOM estimate immediately without another DOM scan', () => {
  const f = fixture();
  try {
    f.cost.start();
    f.flush();
    const original = f.cost.snapshot()!;
    const resource = { bytes: 7 * 1024 * 1024, release() {} };
    const unregister = f.cost.retain(resource);
    expect(f.cost.snapshot()).toEqual({ ...original, bytes: original.bytes + resource.bytes });
    expect(f.tasks.size).toBe(0);
    expect(f.scans).toBe(1);
    unregister();
    unregister();
    expect(f.cost.snapshot()).toEqual(original);
    const invalid = { bytes: NaN, release() {} };
    f.cost.retain(invalid);
    expect(f.cost.snapshot()!.bytes).toBe(Infinity);
    f.cost.remove(invalid);
    expect(f.cost.snapshot()).toEqual(original);
  } finally {
    f.close();
  }
});

test('a DOM change between background slices discards the incomplete result and stopped late tasks cannot affect a restarted owner', () => {
  const f = fixture(1500);
  try {
    f.cost.start();
    f.run();
    expect(f.scans).toBe(1);
    expect(f.cost.snapshot()).toBeUndefined();
    const stale = f.tasks.values().next().value!;
    f.container.firstChild!.remove();
    expect(f.cost.snapshot()).toBeUndefined();
    stale();
    f.flush();
    expect(f.cost.snapshot()!.nodes).toBe(2998);
    const before = f.scans;
    f.container.append(f.dom.window.document.createElement('span'));
    expect(f.cost.snapshot()).toBeUndefined();
    const stopped = f.tasks.values().next().value!;
    f.cost.stop();
    expect(f.tasks.size).toBe(0);
    f.cost.start();
    stopped();
    expect(f.cost.snapshot()).toBeUndefined();
    f.flush();
    expect(f.scans).toBe(before + 1);
    expect(f.cost.snapshot()!.nodes).toBe(2999);
  } finally {
    f.close();
  }
});

test('over-budget trees stop measuring at the node boundary without walking the remaining DOM', () => {
  const f = fixture(20_000);
  try {
    f.cost.start();
    f.flush();
    expect(f.cost.snapshot()!.nodes).toBe(10_001);
    expect(f.scans).toBe(1);
  } finally {
    f.close();
  }
});

test('an equal-text replacement that detaches the active walker node restarts incomplete accounting', () => {
  const f = fixture(1500);
  try {
    f.cost.start();
    f.run();
    expect(f.scans).toBe(1);
    expect(f.cost.snapshot()).toBeUndefined();
    const current = f.container.children[511]!.firstChild!;
    current.parentNode!.replaceChild(f.dom.window.document.createTextNode('text'), current);
    expect(current.isConnected).toBe(false);
    expect(f.cost.snapshot()).toBeUndefined();
    f.flush();
    expect(f.scans).toBe(2);
    expect(f.cost.snapshot()!.nodes).toBe(3000);
    const complete = f.cost.snapshot();
    const measuredNode = f.container.firstChild!.firstChild!;
    measuredNode.parentNode!.replaceChild(
      f.dom.window.document.createTextNode('text'),
      measuredNode,
    );
    expect(f.cost.snapshot()).toEqual(complete);
    expect(f.tasks.size).toBe(0);
    expect(f.scans).toBe(2);
  } finally {
    f.close();
  }
});
