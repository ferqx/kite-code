import { execFileSync } from 'node:child_process';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import type { LanguagePreference } from '@/core/config';
import { enUS, type MessageKey, zhCN } from './messages';

export type TuiLanguage = 'zh-CN' | 'en-US';

type MessageValues = Record<string, string | number>;

export interface I18n {
  language: TuiLanguage;
  t: (key: MessageKey, values?: MessageValues) => string;
  formatNumber: (value: number) => string;
  formatDateTime: (value: number) => string;
  formatElapsed: (milliseconds: number) => string;
}

function systemLanguage(deviceLocale?: string): TuiLanguage {
  try {
    const locale = deviceLocale ?? Intl.DateTimeFormat().resolvedOptions().locale;
    return new Intl.Locale(locale).language === 'zh' ? 'zh-CN' : 'en-US';
  } catch {
    return 'en-US';
  }
}

function macOSAppleLanguage(): string | undefined {
  try {
    const output = execFileSync('defaults', ['read', '-g', 'AppleLanguages'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /"([^"\r\n]+)"/.exec(output)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * The Electron/PTY host may force LANG=C even when macOS itself is localized.
 * Prefer the actual macOS primary language in that case.
 */
export function detectTuiDeviceLocale(
  intlLocale = Intl.DateTimeFormat().resolvedOptions().locale,
  platform = process.platform,
  appleLanguage = platform === 'darwin' ? macOSAppleLanguage() : undefined,
): string {
  return appleLanguage ?? intlLocale;
}

export function resolveTuiLanguage(
  preference: LanguagePreference,
  deviceLocale?: string,
): TuiLanguage {
  if (preference === 'zh-CN' || preference === 'en-US') return preference;
  return systemLanguage(deviceLocale);
}

function formatTemplate(template: string, values?: MessageValues): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

function createI18n(language: TuiLanguage): I18n {
  const catalog = language === 'zh-CN' ? zhCN : enUS;
  const locale = language === 'zh-CN' ? 'zh-CN' : 'en-US';
  return {
    language,
    t: (key, values) => formatTemplate(catalog[key], values),
    formatNumber: (value) => new Intl.NumberFormat(locale).format(value),
    formatDateTime: (value) => {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return language === 'zh-CN' ? '（未知）' : '(unknown)';
      return new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'medium',
      }).format(date);
    },
    formatElapsed: (milliseconds) => {
      const seconds = Math.max(1, Math.round(milliseconds / 1000));
      const minutes = Math.floor(seconds / 60);
      const rest = seconds % 60;
      if (language === 'zh-CN') return minutes > 0 ? `${minutes} 分 ${rest} 秒` : `${seconds} 秒`;
      return minutes > 0 ? `${minutes}m ${rest}s` : `${seconds}s`;
    },
  };
}

const I18nContext = createContext<I18n>(createI18n('en-US'));

export function I18nProvider({
  language,
  children,
}: {
  language: TuiLanguage;
  children?: ReactNode;
}) {
  const value = useMemo(() => createI18n(language), [language]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  return useContext(I18nContext);
}

export type { MessageKey } from './messages';
