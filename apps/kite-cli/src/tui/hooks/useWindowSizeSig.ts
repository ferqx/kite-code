/**
 * Singleton useWindowSize — registers exactly one "resize" listener on
 * process.stdout regardless of how many components consume it.
 */
import { useEffect, useState } from 'react';

interface WindowSize {
  columns: number;
  rows: number;
}

function readSize(): WindowSize {
  return {
    columns: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  };
}

let current = readSize();
const listeners = new Set<(s: WindowSize) => void>();
let installed = false;

function install() {
  if (installed) return;
  installed = true;
  process.stdout.on('resize', () => {
    current = readSize();
    for (const fn of listeners) {
      fn(current);
    }
  });
}

export function useWindowSize(): WindowSize {
  install();

  const [size, setSize] = useState<WindowSize>(current);

  useEffect(() => {
    listeners.add(setSize);
    return () => {
      listeners.delete(setSize);
    };
  }, []);

  return size;
}
