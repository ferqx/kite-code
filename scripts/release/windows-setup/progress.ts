type SetupPhase =
  | 'location'
  | 'decode'
  | 'archive'
  | 'write'
  | 'rollback'
  | 'publish'
  | 'verify'
  | 'wait'
  | 'replace'
  | 'remove';

// The native window treats these as display updates. The final receipt and exit
// status still come from the original operation, even if display output fails.
function emit(line: string) {
  try {
    console.log(line);
  } catch {
    // Progress reporting cannot interrupt an installation or file removal.
  }
}

export function setupProgress() {
  let lastUpdate = -Infinity;
  let pending: string | undefined;
  const flush = () => {
    if (pending) emit(pending);
    pending = undefined;
  };
  return {
    flush,
    phase(phase: SetupPhase) {
      flush();
      lastUpdate = -Infinity;
      emit(`KITE_SETUP_PHASE ${phase}`);
    },
    count(phase: SetupPhase, completed: number, total = 0) {
      pending = `KITE_SETUP_PROGRESS ${phase} ${completed} ${total}`;
      const now = performance.now();
      if (completed !== 0 && completed !== total && now - lastUpdate < 150) return;
      lastUpdate = now;
      flush();
    },
  };
}
