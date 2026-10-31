/** Plain CSS coordinates, admitted by Main before a remote Chrome event reaches Root. */
export interface NativeBrowserChromeRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface NativeBrowserToolbarPresentation {
  readonly id: string;
  readonly address: string;
  readonly readonlyURL: string;
  readonly loading: boolean;
  readonly hasPage: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly canNavigate: boolean;
  readonly error?: string;
  readonly notesAvailable: boolean;
  readonly notesOpen: boolean;
  readonly optionsAvailable: boolean;
}

export type NativeBrowserToolbarAction =
  | { readonly type: 'address-change'; readonly value: string }
  | { readonly type: 'address-focus'; readonly focused: boolean }
  | { readonly type: 'navigate' | 'back' | 'forward' | 'reload' | 'toggle-notes' }
  | { readonly type: 'show-options'; readonly anchor: NativeBrowserChromeRect };

export interface NativeBrowserControlPresentation {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly issue?: string;
  readonly handoffAvailable: boolean;
  readonly closeAvailable: boolean;
  readonly pending: boolean;
  readonly details: readonly string[];
}

export type NativeBrowserControlAction = {
  readonly type: 'show-menu';
  readonly anchor: NativeBrowserChromeRect;
};

/** Functions stay in the owning Root; only the data/action unions cross the Chrome bridge. */
export interface NativeBrowserToolbarPort {
  readonly data: NativeBrowserToolbarPresentation;
  readonly dispatch: (action: NativeBrowserToolbarAction) => void;
}
export interface NativeBrowserControlPort {
  readonly data: NativeBrowserControlPresentation;
  readonly dispatch: (action: NativeBrowserControlAction) => void;
}
