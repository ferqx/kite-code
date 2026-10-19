import type { Interaction } from '@kite-ai/client';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeWindowFrame } from '../../../../apps/desktop/src/native-window-frame';
import { SessionPage } from '../../../../packages/ui/src/desktop/SessionPage';
import { InteractionCard } from '../../../../packages/ui/src/interactions';

const root = createRoot(document.getElementById('root')!);
function Fixture({ card }: { card: Interaction }) {
  const [submitted, setSubmitted] = useState(false);
  return (
    <NativeWindowFrame>
      <SessionPage
        workspaces={[
          {
            id: 'workspace',
            label: '界面验证',
            state: 'loaded',
            sessions: [{ sessionId: 'session', displayName: '问答体验', status: 'waiting' }],
          },
        ]}
        selected="session"
        sessionLabel="问答体验"
        readingKey={card.id}
        messages={[
          { id: 'intro', role: 'assistant', text: '开始之前，想先确认你的偏好。', settled: true },
        ]}
        loading={false}
        connected
        connectionLabel=""
        actions={{}}
        interaction={
          <InteractionCard
            interaction={card}
            submission={submitted ? { phase: 'accepted', commandId: 'live-answer' } : undefined}
            onAnswer={async (original, answer) => {
              const response = await fetch('/answer', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  interactionId: original.id,
                  revision: original.revision,
                  answer,
                }),
              });
              if (!response.ok) throw Error('回答未保存');
              setSubmitted(true);
            }}
          />
        }
      />
    </NativeWindowFrame>
  );
}
Object.assign(window, {
  renderQuestion: (card: Interaction) => root.render(<Fixture key={card.id} card={card} />),
});
