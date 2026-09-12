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
  models?: readonly {
    readonly provider: string;
    readonly name: string;
  }[];
  onModelChange?: (provider: string, name: string) => void;
  modelDisabled?: boolean;
  permission?: 'accept_edits' | 'auto' | 'full';
  onPermissionChange?: (permission: 'accept_edits' | 'auto' | 'full') => void;
  permissionDisabled?: boolean;
  submitStatus?: string;
}
export function Composer(props: ComposerProps) {
  const composing = useRef(false);
  const canSend = !!props.onSend && !props.disabled && !!props.draft.trim() && !props.active;
  const selectedModel = props.model
    ? props.models?.find((model) => `${model.provider} / ${model.name}` === props.model)
    : undefined;
  const modelValue = selectedModel
    ? `${selectedModel.provider}\0${selectedModel.name}`
    : props.model
      ? `current\0${props.model}`
      : '';
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
          placeholder="描述你想完成的工作…"
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
          <div className="composer-options">
            {props.onModelChange && props.models?.length ? (
              <label className="composer-select">
                <span className="sr-only">模型</span>
                <select
                  aria-label="模型"
                  value={modelValue}
                  disabled={props.modelDisabled}
                  onChange={(event) => {
                    const model = props.models?.find(
                      (candidate) =>
                        `${candidate.provider}\0${candidate.name}` === event.target.value,
                    );
                    if (model) props.onModelChange?.(model.provider, model.name);
                  }}
                >
                  {props.model && !selectedModel && (
                    <option value={modelValue}>{props.model}</option>
                  )}
                  {[...new Set(props.models.map((model) => model.provider))].map((provider) => (
                    <optgroup key={provider} label={provider}>
                      {props
                        .models!.filter((model) => model.provider === provider)
                        .map((model) => (
                          <option
                            key={`${model.provider}\0${model.name}`}
                            value={`${model.provider}\0${model.name}`}
                          >
                            {model.name}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
              </label>
            ) : props.onSettings ? (
              <Button className="ghost model-button" onClick={props.onSettings}>
                {props.model || '配置模型'}
              </Button>
            ) : (
              <span>{props.model}</span>
            )}
            {props.permission && props.onPermissionChange && (
              <label className="composer-select permission-select">
                <span className="sr-only">权限</span>
                <select
                  aria-label="权限"
                  value={props.permission}
                  disabled={props.permissionDisabled}
                  onChange={(event) =>
                    props.onPermissionChange?.(
                      event.target.value as 'accept_edits' | 'auto' | 'full',
                    )
                  }
                >
                  <option value="accept_edits">Ask</option>
                  <option value="auto">Auto</option>
                  <option value="full">Full</option>
                </select>
              </label>
            )}
          </div>
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
              aria-label={props.submitStatus ? `发送消息：${props.submitStatus}` : '发送消息'}
              title={props.submitStatus || '发送消息'}
              disabled={!canSend}
            >
              <img src={sendIcon} alt="" width={16} height={16} />
            </Button>
          )}
        </div>
      </form>
      {props.submitStatus && (
        <span className="sr-only" aria-live="polite">
          {props.submitStatus}
        </span>
      )}
      <p className="hint">
        Enter 发送 · Shift+Enter 换行{props.active && ' · 当前执行期间仅保留草稿'}
      </p>
    </>
  );
}
