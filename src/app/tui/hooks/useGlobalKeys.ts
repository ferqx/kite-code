import { useInput } from 'ink';
import type { Dispatch, MutableRefObject } from 'react';
import { useRef } from 'react';
import type { Action } from '../reducers';

/**
 * 全局快捷键 hook。
 * @param overlayActive — overlay 面板或中断激活时，仅保留 Ctrl+C / Escape，
 *   禁用 Ctrl+T/E/L 等修饰快捷键，避免与面板输入冲突。
 * @param supplementEscRef — PlanReviewBlock 设置此 ref 时，Esc 被局部消费（返回选项页），不触发全局 ESCAPE
 * @param wizardEscBackRef — MultiQuestionWizard 设置此 ref 时（step>0），Esc 回退上一步，不触发全局取消
 */
export function useGlobalKeys(
  dispatch: Dispatch<Action>,
  overlayActive = false,
  supplementEscRef?: MutableRefObject<boolean>,
  wizardEscBackRef?: MutableRefObject<boolean>,
) {
  const overlayActiveRef = useRef(overlayActive);
  overlayActiveRef.current = overlayActive;
  const ctrlCTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useInput(
    (
      input: string,
      key: {
        ctrl?: boolean;
        escape?: boolean;
        upArrow?: boolean;
        downArrow?: boolean;
        leftArrow?: boolean;
        rightArrow?: boolean;
        shift?: boolean;
        tab?: boolean;
      },
    ) => {
      // Shift+Tab: 切换 plan mode（全局，任何时候都生效，无 overlay 限制）
      if (key.shift && key.tab) {
        dispatch({ type: 'TOGGLE_PLAN_MODE' });
        return;
      }
      // Ctrl+C 始终生效
      if (key.ctrl && input === 'c') {
        dispatch({ type: 'CTRL_C' });
        if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);
        ctrlCTimerRef.current = setTimeout(() => {
          dispatch({ type: 'RESET_CTRL_C' });
          ctrlCTimerRef.current = null;
        }, 1000);
        return;
      }
      // Escape 键（非箭头键）
      // supplement 模式下 Esc 由 PlanReviewBlock 局部处理（返回选项页），不触发全局取消
      // wizard back 模式下 Esc 由 MultiQuestionWizard 局部处理（回退上一步），不触发全局取消
      if (key.escape && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
        if (supplementEscRef?.current) return;
        if (wizardEscBackRef?.current) return;
        dispatch({ type: 'ESCAPE' });
        return;
      }
      // 在任何其他键按下时重置 ctrlCPressed
      dispatch({ type: 'RESET_CTRL_C' });
      if (ctrlCTimerRef.current) {
        clearTimeout(ctrlCTimerRef.current);
        ctrlCTimerRef.current = null;
      }
      // overlay 激活时禁用其他全局快捷键
      if (overlayActiveRef.current) return;

      if (key.ctrl && input === 't') {
        dispatch({ type: 'TOGGLE_ALL_REASON' });
        return;
      }
      if (key.ctrl && (input === 'l' || input === 'L')) {
        dispatch({ type: 'CLEAR_OUTPUT' });
        return;
      }
    },
  );
}
