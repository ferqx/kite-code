import { ModelOutputMessage, type ModelOutputMessageProps } from '@kite-ai/ui';
import {
  MessageContent,
  useConversationReadActive,
  useConversationResourceRetention,
} from '@kite-ai/ui/desktop';
import { memo, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useNativeDiagnostics } from './native-diagnostics';
import { nativePreparedMarkdown } from './native-markdown';

const RetainedModelOutput = memo(ModelOutputMessage);

/** Keep verified copy display with its cached DOM; current activity still gates every action. */
export function NativeModelOutputMessage({
  openFile,
  autoRead = true,
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
  const renderText = useCallback<NonNullable<ModelOutputMessageProps['renderText']>>(
    (text, verified) => (
      <NativeMarkdownBody
        text={text}
        verified={verified}
        message={props.message}
        storeId={props.storeId}
        autoRead={autoRead}
        suspended={props.suspended}
        hasVerifiedCandidate={props.verifiedSnapshot !== undefined}
        openFile={openFile}
      />
    ),
    [props.message, props.storeId, props.verifiedSnapshot, autoRead, props.suspended, openFile],
  );
  return (
    <RetainedModelOutput
      {...props}
      autoRead={autoRead}
      renderText={
        props.message.contentFormat === 'unsupported' ? undefined : (props.renderText ?? renderText)
      }
      showReasoning={diagnostics && props.showReasoning === true}
      onContent={publishDisplay}
      readActive={readActive}
    />
  );
}

/** Keep a verified reading visible while the next automatic body revision is in flight. */
function NativeMarkdownBody({
  text,
  verified,
  message,
  storeId,
  autoRead,
  suspended,
  hasVerifiedCandidate,
  openFile,
}: {
  text: string;
  verified?: ModelOutputMessageProps['verifiedSnapshot'];
  message: ModelOutputMessageProps['message'];
  storeId: string;
  autoRead: boolean;
  suspended?: boolean;
  hasVerifiedCandidate: boolean;
  openFile?: (path: string) => void;
}) {
  const scope = JSON.stringify([
    storeId,
    message.sessionId,
    message.id,
    message.runId,
    message.originMessage,
    message.outputBody?.executionId,
  ]);
  const committed = useRef<
    | {
        scope: string;
        text: string;
        hasVerified: boolean;
        prepared: ReturnType<typeof nativePreparedMarkdown>;
      }
    | undefined
  >(undefined);
  const previous = committed.current?.scope === scope ? committed.current : undefined;
  // A host-supplied snapshot that the shared verifier rejected is not a pending
  // read. Retire its previous full display as well as its copy eligibility.
  const retained =
    autoRead &&
    !verified &&
    !hasVerifiedCandidate &&
    previous?.hasVerified &&
    previous.text.startsWith(text);
  const displayed = retained ? previous.text : text;
  const prepared = retained ? previous.prepared : nativePreparedMarkdown(verified, displayed);
  useLayoutEffect(() => {
    committed.current = {
      scope,
      text: displayed,
      prepared,
      hasVerified: !!verified || !!previous?.hasVerified,
    };
  }, [scope, displayed, prepared, verified, previous?.hasVerified]);
  useLayoutEffect(
    () => () => {
      committed.current = undefined;
    },
    [],
  );
  return (
    <MessageContent
      key={scope}
      text={displayed}
      prepared={prepared}
      openFile={retained ? undefined : openFile}
      streaming={
        !suspended && message.role === 'assistant' && (autoRead || !verified)
          ? message.status === 'incomplete'
          : undefined
      }
      streamingReveal={!(autoRead && verified && !previous?.hasVerified)}
    />
  );
}
