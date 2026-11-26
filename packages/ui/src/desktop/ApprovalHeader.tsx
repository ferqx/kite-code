import { ArrowLeft01Icon, ArrowRight01Icon, Shield01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  AlienIcon,
  FlyingSaucerIcon,
  GhostIcon,
  PlanetIcon,
  RobotIcon,
  RocketLaunchIcon,
} from '@phosphor-icons/react';
import { Button } from './ui';

// Session identities are random and immutable. Hashing them gives each child a stable
// allocation across reloads without persisting presentation data or using its title.
const childIcons = [
  RobotIcon,
  AlienIcon,
  FlyingSaucerIcon,
  GhostIcon,
  PlanetIcon,
  RocketLaunchIcon,
];
export function childAgentAppearance(identity: string) {
  let hash = 2166136261;
  for (const character of identity) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return { icon: (hash >>> 0) % childIcons.length, color: ((hash >>> 8) >>> 0) % 6 };
}

/** Shared stable child identity decoration; presentation only. */
export function ChildAgentIcon({
  identity,
  neutral = false,
}: {
  identity: string;
  neutral?: boolean;
}) {
  const appearance = childAgentAppearance(identity);
  const Icon = childIcons[appearance.icon]!;
  return (
    <span
      className="approval-child-icon"
      data-child-icon={appearance.icon}
      data-child-color={appearance.color}
      data-neutral={neutral || undefined}
    >
      <Icon size="var(--ui-icon-size, 14px)" weight="regular" aria-hidden="true" />
    </span>
  );
}

export function ApprovalHeader({
  title = '需要批准',
  child,
  scopeLabel,
  index,
  count,
  onPrevious,
  onNext,
}: {
  title?: string;
  child?: { identity: string; name: string };
  scopeLabel?: string;
  index: number;
  count: number;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <header className="approval-heading">
      <div className="approval-heading-label">
        <HugeiconsIcon icon={Shield01Icon} aria-hidden="true" />
        <strong>{title}</strong>
        {child && (
          <span className="approval-child" title={child.name}>
            <ChildAgentIcon identity={child.identity} />
            <span className="approval-child-name">{child.name}</span>
          </span>
        )}
        {scopeLabel && <span className="approval-child-name">{scopeLabel}</span>}
      </div>
      {count > 1 && (
        <nav className="approval-pager" aria-label="切换审批">
          <Button variant="ghost" size="icon-xs" aria-label="上一项审批" onClick={onPrevious}>
            <HugeiconsIcon icon={ArrowLeft01Icon} />
          </Button>
          <span aria-live="polite">
            {index + 1}/{count}
          </span>
          <Button variant="ghost" size="icon-xs" aria-label="下一项审批" onClick={onNext}>
            <HugeiconsIcon icon={ArrowRight01Icon} />
          </Button>
        </nav>
      )}
    </header>
  );
}
