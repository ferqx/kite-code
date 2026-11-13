/** Restore exact descriptors, including globals that were absent before this DOM fixture. */
export function installGlobals(values: Record<string, unknown>): () => void {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const window = values.window as { navigator?: unknown } | undefined;
  const globals = window?.navigator ? { navigator: window.navigator, ...values } : values;
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
