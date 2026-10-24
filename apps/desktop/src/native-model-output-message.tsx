import { ModelOutputMessage, type ModelOutputMessageProps } from '@kite-ai/ui';
import {
  MessageContent,
  useConversationReadActive,
  useConversationResourceRetention,
} from '@kite-ai/ui/desktop';
import { useCallback, useEffect, useRef } from 'react';
import { useNativeDiagnostics } from './native-diagnostics';
import { nativePreparedMarkdown } from './native-markdown';

/** Keep verified copy display with its cached DOM; current activity still gates every action. */
export function NativeModelOutputMessage({
  openFile,
  ...props
}: ModelOutputMessageProps & { openFile?: (path: string) => void }) {
  const diagnostics = useNativeDiagnostics();
  const readActive = useConversationReadActive();
  const retention = useConversationResourceRetention();
  const current = useRef({ readActive, onContent: props.onContent });
  current.current = { readActive, onContent: props.onContent };
  const resource = useRef<{ release: () => void; unregister: () => void } | undefined>(undefined);
  const hasContentListener = !!props.onContent;
  useEffect(() => {
    if (!hasContentListener || !retention) return;
    if (!resource.current) {
      const release = () => {
        resource.current?.unregister();
        resource.current = undefined;
        current.current.onContent?.(undefined);
      };
      // The string is already budgeted as rendered DOM. This owns its display callback only.
      resource.current = { release, unregister: retention.retain({ bytes: 0, release }) };
    }
    return () => {
      if (!retention.isPaused()) resource.current?.release();
    };
  }, [retention, hasContentListener]);
  const publishDisplay = useCallback(
    (text: string | undefined) => {
      if (text === undefined && retention && (retention.isPaused() || !current.current.readActive))
        return;
      current.current.onContent?.(text);
    },
    [retention],
  );
  return (
    <ModelOutputMessage
      {...props}
      autoRead
      renderText={
        props.message.contentFormat === 'unsupported'
          ? undefined
          : (props.renderText ??
            ((text, verified) => (
              <MessageContent
                text={text}
                prepared={nativePreparedMarkdown(verified, text)}
                openFile={openFile}
              />
            )))
      }
      showReasoning={diagnostics && props.showReasoning === true}
      onContent={publishDisplay}
      readActive={readActive}
    />
  );
}
