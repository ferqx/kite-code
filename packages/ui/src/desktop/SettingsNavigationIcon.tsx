import {
  ArrowLeft02Icon,
  BookOpen01Icon,
  Link01Icon,
  PlugSocketIcon,
  Search01Icon,
  Settings02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

const icons = {
  back: ArrowLeft02Icon,
  general: Settings02Icon,
  providers: Link01Icon,
  webSearch: Search01Icon,
  mcp: PlugSocketIcon,
  skills: BookOpen01Icon,
};

export function SettingsNavigationIcon({ name }: { name: keyof typeof icons }) {
  return <HugeiconsIcon icon={icons[name]} data-icon="inline-start" aria-hidden="true" />;
}
