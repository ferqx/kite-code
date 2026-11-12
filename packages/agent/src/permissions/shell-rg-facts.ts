type OptionValue = {
  optionIndex: number;
  valueIndex: number;
  option: string;
  value: string;
  valueKind: 'pattern' | 'pattern_file' | 'preprocessor_command';
  form: 'next_token' | 'equals' | 'attached';
};
type Token = {
  index: number;
  value: string;
  role: string;
  consumes?: OptionValue;
  consumedByIndex?: number;
  valueKind?: OptionValue['valueKind'];
};

const unavailable = (reason: string) => ({
  availability: 'unavailable' as const,
  reason,
});

/** A deliberately bounded rg argv grammar, not a Shell interpreter or risk verdict. */
export function ripgrepRiskFacts(argv: readonly string[]) {
  const tokens: Token[] = [{ index: 0, value: argv[0] ?? '', role: 'executable' }];
  const consumedOptionValues: OptionValue[] = [];
  const configuredPreprocessors: {
    command: string;
    optionIndex: number;
    valueIndex: number;
    form: OptionValue['form'];
  }[] = [];
  const positionals: Token[] = [];
  const flags = new Set(['-F', '--fixed-strings', '-n', '--line-number', '--no-config']);
  let end = false;
  let explicitPattern = false;
  let optionTerminatorIndex: number | null = null;
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index]!;
    if (!end && value === '--') {
      tokens.push({ index, value, role: 'option_terminator' });
      optionTerminatorIndex = index;
      end = true;
      continue;
    }
    if (!end && flags.has(value)) {
      tokens.push({ index, value, role: 'option' });
      continue;
    }
    let option: string | undefined;
    let attached: string | undefined;
    let form: OptionValue['form'] = 'next_token';
    if (!end) {
      if (['-e', '--regexp', '-f', '--file', '--pre'].includes(value)) option = value;
      else {
        option = ['--regexp', '--file', '--pre'].find((name) => value.startsWith(`${name}=`));
        if (option) {
          attached = value.slice(option.length + 1);
          form = 'equals';
        } else if (value.length > 2 && ['-e', '-f'].includes(value.slice(0, 2))) {
          option = value.slice(0, 2);
          attached = value.slice(2);
          form = 'attached';
        }
      }
    }
    if (option) {
      const optionIndex = index;
      const valueIndex = attached === undefined ? index + 1 : index;
      const argument = attached ?? argv[index + 1];
      if (argument === undefined) return unavailable('missing_option_value');
      if (option === '--pre' && (!argument || configuredPreprocessors.length))
        return unavailable('unsupported_empty_or_repeated_preprocessor');
      const valueKind = ['-e', '--regexp'].includes(option)
        ? 'pattern'
        : ['-f', '--file'].includes(option)
          ? 'pattern_file'
          : 'preprocessor_command';
      const relation: OptionValue = {
        optionIndex,
        valueIndex,
        option,
        value: argument,
        valueKind,
        form,
      };
      tokens.push({ index, value, role: 'option', consumes: relation });
      consumedOptionValues.push(relation);
      if (attached === undefined) {
        index++;
        tokens.push({
          index,
          value: argument,
          role: 'option_value',
          consumedByIndex: optionIndex,
          valueKind,
        });
      }
      if (valueKind === 'preprocessor_command')
        configuredPreprocessors.push({ command: argument, optionIndex, valueIndex, form });
      else explicitPattern = true;
      continue;
    }
    if (!end && value.startsWith('-')) return unavailable('unsupported_option');
    const positional = { index, value, role: 'positional' };
    tokens.push(positional);
    positionals.push(positional);
  }
  for (const positional of positionals) {
    positional.role = explicitPattern ? 'path_argument' : 'pattern_argument';
    explicitPattern = true;
  }
  if (!explicitPattern) return unavailable('missing_pattern');
  return {
    availability: 'available' as const,
    coverage: 'literal_rg_option_subset',
    argv: [...argv],
    tokens,
    consumedOptionValues,
    optionTerminatorIndex,
    configuredPreprocessors,
    literalPathArguments: tokens
      .filter((token) => token.role === 'path_argument')
      .map((token) => token.value),
  };
}
