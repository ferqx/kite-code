import { Box, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { type TuiController, terminalText } from './controller';
import type { TuiColorPreset, TuiLanguage } from './preferences';
import { TuiText as Text, useTuiPresentation } from './presentation';

const languages: readonly TuiLanguage[] = ['system', 'zh-CN', 'en-US'];
const colors: readonly TuiColorPreset[] = ['teal', 'blue', 'purple', 'cyan', 'mono'];
export function TuiPreferencePanel({ controller }: { controller: TuiController }) {
  const state = controller.state,
    facts = state.preferences;
  const { t } = useTuiPresentation();
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
      const value = options[index]!;
      void controller.savePreference(
        language
          ? { expectedRevision: facts.revision, key: 'language', value: value as TuiLanguage }
          : {
              expectedRevision: facts.revision,
              key: 'colorPreset',
              value: value as TuiColorPreset,
            },
      );
    }
  });
  return (
    <Box flexDirection="column">
      <Text bold>{t(language ? 'Language' : 'Theme')}</Text>
      <Text>{t('Local client preferences; work and permissions remain unchanged.')}</Text>
      {options.map((value, i) => (
        <Text key={value} bold={index === i}>
          {index === i ? '> ' : '  '}
          {language
            ? t(
                value === 'system'
                  ? 'System language'
                  : value === 'zh-CN'
                    ? 'Simplified Chinese'
                    : 'English',
              )
            : value}{' '}
          [{value}]{value === current ? ' ✓' : ''}
        </Text>
      ))}
      <Text>
        {t('Effective language:')} {facts.resolvedLanguage} · {t('Base theme:')} {facts.theme}
      </Text>
      <Text>{t('↑↓ select · Enter save · R reread · Esc back')}</Text>
      <Text>
        {state.preferenceStatus === 'confirmed'
          ? t(state.preferenceSaved ? 'Preference saved' : 'Confirmed preferences')
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
      </Text>
      {state.preferenceError && <Text color="red">{terminalText(state.preferenceError)}</Text>}
    </Box>
  );
}
