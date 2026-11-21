import { Button, SettingsNavigationIcon } from '@kite-ai/ui/desktop';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import './native-settings-layout.css';

export type NativeSettingsPage =
  | 'general'
  | 'appearance'
  | 'providers'
  | 'mcp'
  | 'skills'
  | 'trace'
  | 'webSearch';

const categories = {
  general: { label: '常规', icon: 'general' },
  appearance: { label: '外观', icon: 'appearance' },
  providers: { label: '提供商与模型', icon: 'providers' },
  mcp: { label: 'MCP', icon: 'mcp' },
  skills: { label: '技能', icon: 'skills' },
  trace: { label: '轨迹与集成', icon: 'mcp' },
  webSearch: { label: '网页搜索', icon: 'webSearch' },
} as const;

const groups = [
  { label: '应用', pages: ['general', 'appearance'] },
  { label: '模型与扩展', pages: ['providers', 'mcp', 'skills', 'webSearch', 'trace'] },
] as const;

const listNames: Partial<Record<NativeSettingsPage, string>> = {
  mcp: 'MCP 连接',
  providers: '提供商与模型',
  skills: '技能',
};

export function NativeSettingsLayout({
  page,
  onPageChange,
  canReadWebSearch,
  onClose,
  onEditorBack,
  setEditorHost,
  children,
}: {
  readonly page: NativeSettingsPage;
  readonly onPageChange: (page: NativeSettingsPage) => void;
  readonly canReadWebSearch?: boolean;
  readonly onClose: () => void;
  readonly onEditorBack?: () => void;
  readonly setEditorHost: (host: HTMLDivElement | null) => void;
  readonly children: ReactNode;
}) {
  const [showCategories, setShowCategories] = useState(false);
  const categoriesNav = useRef<HTMLElement>(null);
  const categoryBack = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);
  const goToCategories = () => {
    moveFocus.current = true;
    setShowCategories(true);
  };
  useLayoutEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    const target = showCategories
      ? categoriesNav.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
      : categoryBack.current;
    if (target?.getClientRects().length) target.focus();
  }, [showCategories]);
  return (
    <div
      className="settings desktop-settings native-settings-layout"
      data-narrow-screen={showCategories ? 'categories' : 'page'}
    >
      <aside className="native-settings-rail">
        <div className="native-settings-rail-heading">
          <span>设置</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="native-settings-close native-settings-narrow-close"
            aria-label="关闭设置"
            onClick={onClose}
          >
            <CloseIcon />
          </Button>
        </div>
        <nav aria-label="设置分类" ref={categoriesNav}>
          {groups.map((group) => (
            <section key={group.label} aria-label={group.label}>
              <p>{group.label}</p>
              {group.pages.map((key) => {
                const { label, icon } = categories[key];
                if (key === 'webSearch' && !canReadWebSearch) return null;
                return (
                  <Button
                    key={key}
                    className="sidebar-navigation-action"
                    variant="ghost"
                    type="button"
                    aria-pressed={page === key}
                    onClick={() => {
                      if (page !== key) onPageChange(key);
                      if (showCategories) moveFocus.current = true;
                      setShowCategories(false);
                    }}
                  >
                    {icon === 'appearance' ? (
                      <AppearanceIcon />
                    ) : (
                      <SettingsNavigationIcon name={icon} />
                    )}
                    <span>{label}</span>
                  </Button>
                );
              })}
            </section>
          ))}
        </nav>
      </aside>
      <div className="native-settings-page">
        <div className="native-settings-topbar">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="native-settings-category-back"
            ref={categoryBack}
            onClick={goToCategories}
          >
            <SettingsNavigationIcon name="back" />
            设置
          </Button>
          {onEditorBack && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="native-settings-editor-back"
              onClick={onEditorBack}
            >
              <SettingsNavigationIcon name="back" />
              {listNames[page] ?? categories[page].label}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="native-settings-close"
            aria-label="关闭设置"
            onClick={onClose}
          >
            <CloseIcon />
          </Button>
        </div>
        <div className="native-settings-workspace">
          <div className="settings-content">{children}</div>
          <div className="settings-editor-panel" ref={setEditorHost} />
        </div>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
    >
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

function AppearanceIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
    </svg>
  );
}
