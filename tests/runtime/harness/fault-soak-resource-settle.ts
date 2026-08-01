interface ResourceSettleHooks {
  collectGarbage: () => void;
  yieldTurn: () => Promise<void>;
}

const DEFAULT_SETTLE_HOOKS: ResourceSettleHooks = {
  collectGarbage: () => Bun.gc(true),
  yieldTurn: () => Bun.sleep(0),
};

/**
 * Removes dead fixture/JIT objects from same-process lifecycle samples without
 * hiding retained state. Two collections with a turn between them also drain
 * cleanup work scheduled by first-pass finalizers. A collection failure is
 * intentionally allowed to fail the probe.
 */
export async function settleSameProcessResourceSample(
  repeatCount: number,
  hooks: ResourceSettleHooks = DEFAULT_SETTLE_HOOKS,
): Promise<void> {
  if (!Number.isInteger(repeatCount) || repeatCount <= 1) return;
  await hooks.yieldTurn();
  hooks.collectGarbage();
  await hooks.yieldTurn();
  hooks.collectGarbage();
  await hooks.yieldTurn();
}
