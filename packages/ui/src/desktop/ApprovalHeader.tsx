import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Atom01Icon,
  BotIcon,
  Compass01Icon,
  Leaf01Icon,
  PuzzleIcon,
  Rocket01Icon,
  Shield01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button } from './ui';

// Session identities are random and immutable. Hashing them gives each child a stable
// allocation across reloads without persisting presentation data or using its title.
const childIcons = [BotIcon, Rocket01Icon, Compass01Icon, Atom01Icon, PuzzleIcon, Leaf01Icon];
export function childAgentAppearance(identity: string) {
  let hash = 2166136261;
  for (const character of identity) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return { icon: (hash >>> 0) % childIcons.length, color: ((hash >>> 8) >>> 0) % 6 };
}

export function ApprovalHeader({
  child,
  index,
  count,
  onPrevious,
  onNext,
}: {
  child?: { identity: string; name: string };
  index: number;
  count: number;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const appearance = child && childAgentAppearance(child.identity);
  return (
    <header className="approval-heading">
      <div className="approval-heading-label">
        <HugeiconsIcon icon={Shield01Icon} aria-hidden="true" />
        <strong>需要批准</strong>
        {child && appearance && (
          <span className="approval-child" title={child.name}>
            <span
              className="approval-child-icon"
              data-child-icon={appearance.icon}
              data-child-color={appearance.color}
            >
              <HugeiconsIcon icon={childIcons[appearance.icon]!} aria-hidden="true" />
            </span>
            <span className="approval-child-name">{child.name}</span>
          </span>
        )}
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
