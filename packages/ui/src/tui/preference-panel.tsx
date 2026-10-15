import { useInput } from 'ink';
import { useEffect, useState } from 'react';
import { type TuiController, terminalText } from './controller';
import TuiOverlayFrame, { OverlayShortcutBar, OverlayStatusColumn } from './ink/OverlayFrame';
import { OverlayListRow, OverlayMessage } from './ink/OverlayPrimitives';
import type { TuiColorPreset, TuiLanguage } from './preferences';
import { TuiText as Text, useInkI18n, useTuiPresentation } from './presentation';

const languages: readonly TuiLanguage[] = ['system', 'zh-CN', 'en-US'];
const colors: readonly TuiColorPreset[] = ['teal', 'blue', 'purple', 'cyan', 'mono'];
export function TuiPreferencePanel({ controller }: { controller: TuiController }) {
  const { t: originalLabel, language: inkLanguage } = useInkI18n();
  const state = controller.state,
    facts = state.preferences;
  const { t, testDiagnostics } = useTuiPresentation();
  const language = state.panel === 'language';
  const options: readonly (TuiLanguage | TuiColorPreset)[] = language ? languages : colors;
  const current = language ? facts.language : facts.colorPreset;
  const [index, setIndex] = useState(Math.max(0, options.indexOf(current)));
  useEffect(() => {
    setIndex(Math.max(0, options.indexOf(current)));
  }, [current, options]);
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) controller.closePanel();
    else if (input.toLowerCase() === 'r') void controller.refreshPreferences();
    else if (key.upArrow) setIndex((i) => (i + options.length - 1) % options.length);
    else if (key.downArrow) setIndex((i) => (i + 1) % options.length);
    else if (key.return && state.preferenceStatus === 'confirmed') {
      const value = options[index]!,
        originalSessionId = state.sessionId;
      if (!testDiagnostics && value === current) {
        controller.closePanel();
        return;
      }
      void controller
        .savePreference(
          language
            ? { expectedRevision: facts.revision, key: 'language', value: value as TuiLanguage }
            : {
                expectedRevision: facts.revision,
                key: 'colorPreset',
                value: value as TuiColorPreset,
              },
        )
        .then(() => {
          if (
            !testDiagnostics &&
            controller.state.sessionId === originalSessionId &&
            controller.state.preferenceStatus === 'confirmed' &&
            controller.state.preferenceSaved &&
            controller.state.panel === (language ? 'language' : 'theme')
          )
            controller.closePanel();
        });
    }
  });
  const labels = {
    system: ['language.system', 'language.systemDescription'],
    'zh-CN': ['language.zhCN', 'language.zhCNDescription'],
    'en-US': ['language.enUS', 'language.enUSDescription'],
    teal: ['theme.teal', 'theme.tealDescription'],
    blue: ['theme.blue', 'theme.blueDescription'],
    purple: ['theme.purple', 'theme.purpleDescription'],
    cyan: ['theme.cyan', 'theme.cyanDescription'],
    mono: ['theme.mono', 'theme.monoDescription'],
  } as const;
  return (
    <TuiOverlayFrame
      title={
        testDiagnostics
          ? t(language ? 'Language' : 'Theme')
          : originalLabel(language ? 'language.title' : 'theme.title')
      }
      meta={`${index + 1} / ${options.length}`}
      footer={
        <OverlayShortcutBar
          shortcuts={[
            { keys: '↑↓', label: originalLabel('common.select') },
            { keys: 'Enter', label: originalLabel('common.confirm') },
            { keys: 'R', label: t('Refresh') },
            { keys: 'Esc', label: originalLabel('common.back') },
          ]}
        />
      }
      message={
        state.preferenceStatus !== 'confirmed' || state.preferenceSaved ? (
          <OverlayMessage tone={state.preferenceError ? 'error' : 'info'}>
            {state.preferenceStatus === 'confirmed'
              ? t('Preference saved')
              : state.preferenceStatus === 'loading'
                ? t('Reading preferences')
                : state.preferenceStatus === 'saving'
                  ? t('Saving preference')
                  : state.preferenceError === 'tui_preferences_publication_uncertain'
                    ? t(
                        'Save outcome unknown; last confirmed values retained. R rereads original preferences before another choice.',
                      )
                    : t(
                        'Preference failed; previous values retained. R rereads before another choice.',
                      )}
            {state.preferenceError && ` · ${terminalText(state.preferenceError)}`}
          </OverlayMessage>
        ) : undefined
      }
    >
      {options.map((value, i) => (
        <OverlayListRow
          key={value}
          selected={index === i}
          primary={originalLabel(labels[value][0])}
          secondary={originalLabel(labels[value][1])}
          trailing={
            <OverlayStatusColumn
              active={value === current}
              label={inkLanguage === 'zh-CN' ? '当前' : 'Current'}
            />
          }
        />
      ))}
      {testDiagnostics && (
        <Text>
          {t('Confirmed preferences')} · {language && t('System language')} ·{' '}
          {t('Effective language:')} {facts.resolvedLanguage} · {t('Base theme:')} {facts.theme}
        </Text>
      )}
    </TuiOverlayFrame>
  );
}
