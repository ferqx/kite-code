/** Root CSS coordinates for a finite native menu anchor. */
export interface NativeBrowserMenuRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface NativeBrowserToolbarPresentation {
  readonly address: string;
  readonly loading: boolean;
  readonly hasPage: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly canNavigate: boolean;
  readonly error?: string;
  /** A local options-menu failure does not invalidate the page presentation. */
  readonly optionsIssue?: string;
  readonly notesAvailable: boolean;
  readonly notesOpen: boolean;
  readonly optionsAvailable: boolean;
}

export type NativeBrowserToolbarAction =
  | { readonly type: 'address-change'; readonly value: string }
  | { readonly type: 'address-focus'; readonly focused: boolean }
  | { readonly type: 'navigate' | 'back' | 'forward' | 'reload' | 'toggle-notes' }
  | { readonly type: 'show-options'; readonly anchor: NativeBrowserMenuRect };

export interface NativeBrowserControlPresentation {
  readonly label: string;
  readonly detail: string;
  readonly issue?: string;
}

export type NativeBrowserControlAction = {
  readonly type: 'show-menu';
  readonly anchor: NativeBrowserMenuRect;
};

/** Local presentation props; callbacks remain in the owning Root. */
export interface NativeBrowserToolbarProps {
  readonly data: NativeBrowserToolbarPresentation;
  readonly dispatch: (action: NativeBrowserToolbarAction) => void;
}
export interface NativeBrowserControlProps {
  readonly data: NativeBrowserControlPresentation;
  readonly dispatch: (action: NativeBrowserControlAction) => void;
}
