import type { AgentEvent } from '@/protocol/events';
import type { Action } from './reducers/actions';

/**
 * TextBatcher 合并连续 text 事件，减少流式渲染期间的 re-render 次数。
 *
 * 原理：text 事件携带累积内容（非 delta），可以只保留最新一个。
 * 在 `interval` ms 窗口内收到多个 text 事件时，只 dispatch 最后一个。
 * 非 text 事件（tool_call、reason、need_approval 等）立即 dispatch，
 * 之前先 flush 缓冲区。
 */
export class TextBatcher {
  private pendingText: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private textStreamOpen = false;

  private dispatch: (action: Action) => void;
  private interval: number;

  constructor(dispatch: (action: Action) => void, interval = 16) {
    this.dispatch = dispatch;
    this.interval = interval;
  }

  setRunning(running: boolean) {
    if (!running && this.running) {
      this.flush();
      this.textStreamOpen = false;
    }
    this.running = running;
  }

  push(event: AgentEvent) {
    if (this.running && event.type === 'text') {
      if (!this.textStreamOpen) {
        this.textStreamOpen = true;
        this.dispatch({ type: 'EVENT', event });
        return;
      }
      // 覆盖：只保留最新的累积文本
      this.pendingText = event.data.text;
      if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), this.interval);
      }
    } else {
      // 非 text 事件：先 flush 再立即 dispatch
      this.flush();
      this.textStreamOpen = false;
      this.dispatch({ type: 'EVENT', event });
    }
  }

  flush() {
    if (this.pendingText !== null) {
      this.dispatch({
        type: 'EVENT',
        event: { type: 'text', data: { text: this.pendingText } },
      });
      this.pendingText = null;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 组件卸载时调用，防止 flush 尝试 dispatch 到已卸载的组件 */
  dispose() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingText = null;
    this.textStreamOpen = false;
  }
}
