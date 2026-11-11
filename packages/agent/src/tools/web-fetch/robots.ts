interface RobotsRule {
  readonly allow: boolean;
  readonly pattern: string;
}

const productToken = 'kitecode';

function normalizePath(value: string): string {
  return value.replace(/%[0-9a-f]{2}|[\u0080-\u{10ffff}]+/giu, (part) => {
    if (!part.startsWith('%')) return encodeURIComponent(part);
    const character = String.fromCharCode(Number.parseInt(part.slice(1), 16));
    return /^[a-z0-9._~-]$/i.test(character) ? character : part.toUpperCase();
  });
}

export function parseRobots(body: string): readonly RobotsRule[] {
  const specific: RobotsRule[] = [],
    wildcard: RobotsRule[] = [];
  let hasAgents = false,
    hasRules = false,
    appliesToProduct = false,
    appliesToAll = false,
    hasSpecificGroup = false;
  for (const line of body.split(/\r\n?|\n/)) {
    const entry = /^[\t ]*(user-agent|allow|disallow)[\t ]*:[\t ]*(.*?)[\t ]*$/i.exec(
      line.split('#', 1)[0]!,
    );
    if (!entry) continue;
    const field = entry[1]!.toLowerCase(),
      value = entry[2]!;
    if (field === 'user-agent') {
      if (!value) continue;
      if (hasRules) {
        hasRules = false;
        appliesToProduct = false;
        appliesToAll = false;
      }
      const agent = value.toLowerCase();
      hasAgents = true;
      if (agent === productToken) {
        appliesToProduct = true;
        hasSpecificGroup = true;
      }
      if (agent === '*') appliesToAll = true;
      continue;
    }
    if (!hasAgents) continue;
    hasRules = true;
    if (!value.startsWith('/') || /[\t ]/.test(value)) continue;
    const rule = { allow: field === 'allow', pattern: normalizePath(value) };
    if (appliesToProduct) specific.push(rule);
    else if (appliesToAll) wildcard.push(rule);
  }
  return hasSpecificGroup ? specific : wildcard;
}

function matches(path: string, pattern: string): boolean {
  const anchored = pattern.endsWith('$');
  const value = anchored ? pattern.slice(0, -1) : pattern;
  const [prefix, ...segments] = value.split(/\*+/);
  if (!path.startsWith(prefix!)) return false;
  if (!segments.length) return !anchored || path.length === prefix!.length;

  // Match literal segments without compiling untrusted patterns to regular expressions.
  let offset = prefix!.length,
    end = path.length;
  if (anchored) {
    const suffix = segments.pop()!;
    if (!path.endsWith(suffix)) return false;
    end -= suffix.length;
    if (end < offset) return false;
  }
  for (const segment of segments) {
    const match = path.indexOf(segment, offset);
    if (match < 0 || match + segment.length > end) return false;
    offset = match + segment.length;
  }
  return true;
}

export function robotsAllows(rules: readonly RobotsRule[], url: URL): boolean {
  const path = normalizePath(url.href.slice(url.origin.length).split('#', 1)[0]!)
    .replaceAll('*', '%2A')
    .replaceAll('$', '%24');
  let best: RobotsRule | undefined;
  for (const rule of rules) {
    if (
      best &&
      (rule.pattern.length < best.pattern.length ||
        (rule.pattern.length === best.pattern.length && (best.allow || !rule.allow)))
    )
      continue;
    if (matches(path, rule.pattern)) best = rule;
  }
  return best?.allow ?? true;
}
