import { registerHooks } from 'node:module';
import {
  after,
  afterEach,
  before,
  beforeEach,
  mock as nodeMock,
  test as nodeTest,
  describe as suite,
} from 'node:test';
import { format, getCallSites } from 'node:util';
import { expect as jestExpect } from 'expect';
import { ModuleMocker } from 'jest-mock';

const spies = new ModuleMocker(globalThis);
const fn = spies.fn.bind(spies);
const spyOn = spies.spyOn.bind(spies);

export type { Mock } from 'jest-mock';
export { spyOn };

function hook(register: typeof before) {
  return (body: () => unknown, timeout?: number | { timeout?: number }) => {
    const options = typeof timeout === 'number' ? { timeout } : timeout;
    register(async () => {
      await body();
    }, options);
  };
}
export const beforeAll = hook(before);
export const afterAll = hook(after);
const setup = hook(beforeEach);
const teardown = hook(afterEach);

export { setup as beforeEach, teardown as afterEach };

declare module 'expect' {
  interface Matchers<R extends void | Promise<void>> {
    toBeArray(): R;
    toBeFalse(): R;
    toBeFunction(): R;
    toBeNumber(): R;
    toBeString(): R;
    toBeTrue(): R;
    toEndWith(suffix: string): R;
    toStartWith(prefix: string): R;
  }
}

function expectation(pass: boolean, description: string) {
  return { pass, message: () => description };
}
jestExpect.extend({
  toBeArray: (value) => expectation(Array.isArray(value), 'Expected an array'),
  toBeFalse: (value) => expectation(value === false, 'Expected false'),
  toBeFunction: (value) => expectation(typeof value === 'function', 'Expected a function'),
  toBeNumber: (value) => expectation(typeof value === 'number', 'Expected a number'),
  toBeString: (value) => expectation(typeof value === 'string', 'Expected a string'),
  toBeTrue: (value) => expectation(value === true, 'Expected true'),
  toEndWith: (value, suffix: string) =>
    expectation(
      typeof value === 'string' && value.endsWith(suffix),
      `Expected a string ending with ${JSON.stringify(suffix)}`,
    ),
  toStartWith: (value, prefix: string) =>
    expectation(
      typeof value === 'string' && value.startsWith(prefix),
      `Expected a string starting with ${JSON.stringify(prefix)}`,
    ),
});

export const expect: typeof jestExpect &
  (<T>(value: T, message?: string) => ReturnType<typeof jestExpect<T>>) = Object.assign(
  function assert<T>(value: T, message?: string) {
    const matchers = jestExpect(value);
    if (!message) return matchers;
    const contextual = (source: object): object =>
      new Proxy(source, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (value && typeof value === 'object') return contextual(value);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            const explain = (error: unknown): never => {
              if (error instanceof Error) error.message = `${message}\n${error.message}`;
              throw error;
            };
            try {
              const result = Reflect.apply(value, target, args);
              return result instanceof Promise ? result.catch(explain) : result;
            } catch (error) {
              return explain(error);
            }
          };
        },
      });
    return contextual(matchers) as typeof matchers;
  },
  jestExpect,
);

function callerURL(): URL {
  const frame = getCallSites(10).find(
    (site) => site.scriptName.startsWith('file:') && site.scriptName !== import.meta.url,
  );
  if (!frame) throw Error('test_module_mock_caller_missing');
  return new URL(frame.scriptName);
}

const moduleMocks = new Map<string, { restore(): void }>();
const electronMockTarget = new URL('./electron-mock-target.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(
      specifier === 'electron' && moduleMocks.has(electronMockTarget)
        ? electronMockTarget
        : specifier,
      context,
    );
  },
});
export const mock = Object.assign(fn, {
  module(specifier: string, factory: () => Record<string, unknown>) {
    const caller = callerURL();
    const target =
      specifier === 'electron'
        ? electronMockTarget
        : specifier.startsWith('node:') || specifier.startsWith('file:')
          ? specifier
          : import.meta.resolve(specifier, caller);
    moduleMocks.get(target)?.restore();
    const registered = nodeMock.module(target, { exports: factory(), cache: true });
    const handle = {
      restore() {
        registered.restore();
        if (moduleMocks.get(target) === handle) moduleMocks.delete(target);
      },
    };
    moduleMocks.set(target, handle);
    return handle;
  },
  restore() {
    // Restore function spies. Existing module mock references are unaffected.
    spies.restoreAllMocks();
  },
});

export const jest = {
  useFakeTimers() {
    nodeMock.timers.enable({ apis: ['setTimeout', 'setInterval', 'setImmediate', 'Date'] });
  },
  advanceTimersByTime(ms: number) {
    nodeMock.timers.tick(ms);
  },
  useRealTimers() {
    nodeMock.timers.reset();
  },
};

type Timeout = number | { timeout?: number };
type Done = (error?: unknown) => void;
type Case<Args extends unknown[]> = (...args: [...Args, Done]) => unknown;
type AsRow<Row> = Row extends readonly unknown[] ? Row : readonly [Row];
// Tuple positions keep contextual types even when the readonly rows differ.
type UnionColumns<Row extends readonly unknown[], AllRows extends Row = Row> = {
  -readonly [Index in keyof Row]: AllRows[Index];
};
type RowArguments<Row> =
  UnionColumns<AsRow<Row>> extends infer Args extends unknown[] ? Args : never;
interface Register<Args extends unknown[]> {
  (name: string, body: Case<Args>, timeout?: Timeout): void;
  (name: string, timeout: Timeout, body: Case<Args>): void;
}
interface Cases<Args extends unknown[]> extends Register<Args> {
  only: Cases<Args>;
  skip: Cases<Args>;
  todo: Cases<Args>;
  skipIf(condition: boolean): Cases<Args>;
  if(condition: boolean): Cases<Args>;
  each<Row>(table: readonly Row[]): Cases<RowArguments<Row>>;
}

function checkedTimeout(ms: number): number {
  if (!Number.isSafeInteger(ms) || ms < 1) throw Error('test_timeout_invalid');
  return ms;
}

let fileTimeout: number | undefined;
export function setDefaultTimeout(ms: number): void {
  fileTimeout = checkedTimeout(ms);
}
const defaultTimeout = () => checkedTimeout(Number(process.env.KITE_TEST_TIMEOUT_MS ?? 5000));
type Mode = 'skip' | 'only' | 'todo';
function registerCases<Args extends unknown[]>(
  registration: typeof nodeTest | typeof suite,
  mode?: Mode,
  table?: readonly unknown[],
): Cases<Args> {
  const register = ((name, bodyOrTimeout, timeoutOrBody) => {
    const body = typeof bodyOrTimeout === 'function' ? bodyOrTimeout : timeoutOrBody;
    const options = typeof bodyOrTimeout === 'function' ? timeoutOrBody : bodyOrTimeout;
    if (typeof body !== 'function') throw Error('test_callback_required');
    const timeout =
      typeof options === 'number'
        ? options
        : typeof options === 'object'
          ? options.timeout
          : undefined;
    for (const [index, row] of (table ?? [undefined]).entries()) {
      const args: unknown[] = !table ? [] : Array.isArray(row) ? row : [row];
      const title = table
        ? format(
            name.replaceAll('%#', String(index)),
            ...args.slice(0, (name.match(/%[sdifjoOc]/g) ?? []).length),
          )
        : name;
      const label = table && title === name ? `${name} [${index}]` : title;
      registration(
        label,
        {
          ...(mode === undefined ? {} : { [mode]: true }),
          ...(registration === nodeTest
            ? { timeout: checkedTimeout(timeout ?? fileTimeout ?? defaultTimeout()) }
            : {}),
        },
        async () => {
          if (registration === nodeTest && body.length > args.length) {
            await new Promise<void>((resolve, reject) => {
              Reflect.apply(body, undefined, [
                ...args,
                (error?: unknown) => (error === undefined ? resolve() : reject(error)),
              ]);
            });
          } else await Reflect.apply(body, undefined, args);
        },
      );
    }
  }) as Cases<Args>;
  for (const variant of ['only', 'skip', 'todo'] as const)
    Object.defineProperty(register, variant, {
      get: () => registerCases(registration, variant, table),
    });
  register.skipIf = (condition) => (condition ? register.skip : register);
  register.if = (condition) => register.skipIf(!condition);
  register.each = (rows) => registerCases(registration, mode, rows);
  return register;
}
export const test = registerCases<[]>(nodeTest);
export const it = test;
export const describe = registerCases<[]>(suite);
