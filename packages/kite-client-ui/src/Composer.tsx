import { type ReactNode, type Ref, useRef } from 'react';
import { Button, Textarea } from './ui';

const sendIcon = new URL('./assets/send.svg', import.meta.url).href;
const stopIcon = new URL('./assets/stop.svg', import.meta.url).href;

export interface ComposerProps {
  inputRef?: Ref<HTMLTextAreaElement>;
  context?: ReactNode;
  draft: string;
  onChange: (value: string) => void;
  onSend?: () => void;
  onCancel?: () => void;
  onSettings?: () => void;
  active: boolean;
  stopping: boolean;
  cancelDisabled?: boolean;
  disabled: boolean;
  model?: string;
}
export function Composer(props: ComposerProps) {
  const composing = useRef(false);
  const canSend = !!props.onSend && !props.disabled && !!props.draft.trim() && !props.active;
  return (
    <>
      {props.context}
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend && !composing.current) props.onSend?.();
        }}
      >
        <Textarea
          ref={props.inputRef}
          aria-label="任务输入"
          placeholder={
            props.active ? '可以先写下下一步要求，当前任务结束后发送…' : '描述你想完成的工作…'
          }
          value={props.draft}
          onChange={(event) => props.onChange(event.target.value)}
          disabled={props.disabled}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.altKey) return;
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            if (canSend) props.onSend?.();
          }}
        />
        <div className="composer-bottom">
          {props.onSettings ? (
            <Button className="ghost model-button" onClick={props.onSettings}>
              {props.model || '配置模型'}
            </Button>
          ) : (
            <span>{props.model}</span>
          )}
          {props.active ? (
            props.onCancel && (
              <Button
                className="primary composer-action"
                size="icon-sm"
                aria-label={props.stopping ? '正在停止…' : '停止任务'}
                title={props.stopping ? '正在停止…' : '停止任务'}
                onClick={props.onCancel}
                disabled={props.stopping || props.cancelDisabled}
              >
                <img src={stopIcon} alt="" width={16} height={16} />
              </Button>
            )
          ) : (
            <Button
              className="primary composer-action"
              size="icon-sm"
              type="submit"
              aria-label="发送消息"
              title="发送消息"
              disabled={!canSend}
            >
              <img src={sendIcon} alt="" width={16} height={16} />
            </Button>
          )}
        </div>
      </form>
      <p className="hint">
        Enter 发送 · Shift+Enter 换行{props.active && ' · 当前执行期间仅保留草稿'}
      </p>
    </>
  );
}
