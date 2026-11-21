import { Fragment } from 'react';
import { ChildAgentIcon, childAgentAppearance } from './ApprovalHeader';
import { TraceDescription, TraceIcon, TraceLine, TraceTitle } from './components/ui/trace';
import { Button } from './ui';

type Creation = {
  key: string;
  identity: string;
  name: string;
  onOpen?: () => void;
};

export function ChildAgentCreationLine({ creations }: { creations: readonly Creation[] }) {
  const first = creations[0]!;
  const grouped = creations.length > 1;
  const singleLabel = '子agent开始工作';
  return (
    <article
      className="message tool-activity child-agent-activity"
      aria-label={grouped ? '已创建的子 Agent' : `${first.name} · ${singleLabel}`}
      data-child-color={grouped ? undefined : childAgentAppearance(first.identity).color}
    >
      <TraceLine
        className="tool-activity-summary child-agent-creation-line"
        data-grouped={grouped || undefined}
      >
        {grouped && (
          <span className="child-agent-creation-icons" aria-hidden="true">
            {creations.map(({ key, identity }) => (
              <ChildAgentIcon key={key} identity={identity} />
            ))}
          </span>
        )}
        <TraceTitle className="child-agent-creation-names">
          {creations.map(({ key, identity, name, onOpen }, index) => (
            <Fragment key={key}>
              {index > 0 && (
                <span aria-hidden="true">{index === creations.length - 1 ? '和' : '、'}</span>
              )}
              <Button
                className="child-agent-creation-link"
                variant="ghost"
                aria-label={`查看子 Agent 详情：${name}`}
                title={name}
                disabled={!onOpen}
                onClick={onOpen}
              >
                {!grouped && (
                  <TraceIcon>
                    <ChildAgentIcon identity={identity} />
                  </TraceIcon>
                )}
                <span className="tool-agent-name">{name}</span>
                {!grouped && (
                  <>
                    <span aria-hidden="true">·</span>
                    <TraceDescription className="tool-agent-operation">
                      {singleLabel}
                    </TraceDescription>
                  </>
                )}
              </Button>
            </Fragment>
          ))}
        </TraceTitle>
        {grouped && <TraceDescription>已创建</TraceDescription>}
      </TraceLine>
    </article>
  );
}
