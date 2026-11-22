import { Button } from '@kite-ai/ui/desktop';
import { createContext, type ReactNode, type Ref, useContext } from 'react';

export const NativeSettingsDetailNavigation = createContext(false);

type Heading = {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  mark?: ReactNode;
  detailFocus?: Ref<HTMLHeadingElement>;
};

export function NativeSettingsHeading({ title, description, actions, mark, detailFocus }: Heading) {
  return (
    <header className="settings-page-heading native-settings-heading">
      <div className="native-settings-heading-copy">
        {mark}
        <div>
          <h2>{title}</h2>
          {description &&
            (detailFocus ? (
              <h3 ref={detailFocus} tabIndex={-1}>
                {description}
              </h3>
            ) : (
              <p>{description}</p>
            ))}
        </div>
      </div>
      {actions}
    </header>
  );
}

export function NativeSettingsDetail({
  id,
  label,
  title = label,
  description,
  mark,
  detailFocus,
  extra,
  onClose,
  children,
}: {
  id?: string;
  label: string;
  title?: string;
  extra?: ReactNode;
  onClose: () => void;
  children: ReactNode;
} & Omit<Heading, 'title' | 'actions'>) {
  const hasSharedBack = useContext(NativeSettingsDetailNavigation);
  return (
    <aside className="right-sidebar native-settings-detail" id={id} aria-label={label}>
      <div className="right-sidebar-heading native-settings-detail-header">
        <NativeSettingsHeading
          title={title}
          description={description}
          mark={mark}
          detailFocus={detailFocus}
          actions={
            (extra || !hasSharedBack) && (
              <div className="native-settings-detail-actions">
                {extra}
                {!hasSharedBack && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="right-sidebar-close"
                    aria-label="关闭"
                    title="关闭"
                    onClick={onClose}
                  >
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
                  </Button>
                )}
              </div>
            )
          }
        />
      </div>
      <div className="right-sidebar-content">{children}</div>
    </aside>
  );
}
