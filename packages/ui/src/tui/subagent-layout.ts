import { MAX_RUNNING_STEPS } from './ink/SubAgentBlock';

export interface SubagentLayoutItem {
  readonly key: string;
  readonly subagentSteps?: readonly number[];
}
export interface SubagentLayout {
  readonly maxVisibleSteps: number;
  readonly maxVisibleChildren: number;
  readonly allowExpanded: boolean;
}

/** The original mutable-tail budget: reserve prompt/chrome and compress before clipping. */
export function subagentLayouts(
  items: readonly SubagentLayoutItem[],
  terminalRows: number,
  hasEarlierOutput: boolean,
): ReadonlyMap<string, SubagentLayout> {
  const rows = Math.max(1, Math.floor(terminalRows));
  const children = items.reduce((sum, item) => sum + (item.subagentSteps?.length ?? 0), 0);
  const otherBlocks = items.filter((item) => !item.subagentSteps?.length).length;
  const gaps = Math.max(0, children - 1);
  const steps =
    children <= 1
      ? MAX_RUNNING_STEPS
      : otherBlocks > 0
        ? 0
        : Math.min(
            MAX_RUNNING_STEPS,
            Math.floor(Math.max(0, rows - 5 - gaps - children * 3) / children),
          );
  return new Map(
    items.flatMap((item, index) => {
      if (!item.subagentSteps?.length) return [];
      const margin = index > 0 || hasEarlierOutput ? 1 : 0;
      return [
        [
          item.key,
          {
            maxVisibleSteps: steps,
            maxVisibleChildren: Math.max(0, Math.floor((rows - 5 - 3 - margin) / 2)),
            allowExpanded:
              items.length === 1 &&
              1 +
                item.subagentSteps.reduce((sum, count) => sum + 2 + (count > 0 ? 1 : 0), 0) +
                5 +
                margin <
                rows,
          },
        ],
      ];
    }),
  );
}
