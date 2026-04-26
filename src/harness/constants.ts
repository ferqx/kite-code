/** 计划批准后切换到 builder 模式的消息 / Message when switching to builder mode after plan approval */
export const CONTINUE_IN_BUILDER_MESSAGE =
  "Plan approved. Continue in builder mode and complete the original user request using tools as needed.";

/** 死循环重复限制 / Doom loop repeat limit (3 identical calls in a row triggers blocking) */
export const DOOM_LOOP_REPEAT_LIMIT = 3;

/** 看门狗停滞步数限制 / Watchdog stagnant step limit (5 steps without progress triggers alert) */
export const WATCHDOG_STAGNANT_LIMIT = 5;
