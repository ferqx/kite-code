export interface TuiSystemResourceSample {
  rssBytes: number;
  activeResourceCount: number;
  fdCount?: number;
}

export interface ResourceTrendLimits {
  windowSize: number;
  rssGrowthBytes: number;
  activeResourceGrowth: number;
  fdGrowth: number;
}

export const DEFAULT_RESOURCE_TREND_LIMITS: Readonly<ResourceTrendLimits> = Object.freeze({
  windowSize: 8,
  rssGrowthBytes: 32 * 1024 * 1024,
  activeResourceGrowth: 2,
  fdGrowth: 2,
});

export function hasSustainedPositiveSlope(
  values: readonly number[],
  minimumGrowth: number,
  windowSize: number,
): boolean {
  if (values.length < windowSize) return false;
  const tail = values.slice(-windowSize);
  const positiveSteps = tail.slice(1).filter((value, index) => value > tail[index]!).length;
  return positiveSteps >= tail.length - 2 && tail.at(-1)! - tail[0]! > minimumGrowth;
}

export function resourceTrendFailures(
  samples: readonly TuiSystemResourceSample[],
  limits: ResourceTrendLimits = DEFAULT_RESOURCE_TREND_LIMITS,
): string[] {
  const failures: string[] = [];
  if (
    hasSustainedPositiveSlope(
      samples.map((sample) => sample.rssBytes),
      limits.rssGrowthBytes,
      limits.windowSize,
    )
  ) {
    failures.push('rss');
  }
  if (
    hasSustainedPositiveSlope(
      samples.map((sample) => sample.activeResourceCount),
      limits.activeResourceGrowth,
      limits.windowSize,
    )
  ) {
    failures.push('active-resources');
  }
  const fdSamples = samples.flatMap((sample) => (sample.fdCount == null ? [] : [sample.fdCount]));
  if (hasSustainedPositiveSlope(fdSamples, limits.fdGrowth, limits.windowSize)) {
    failures.push('file-descriptors');
  }
  return failures;
}
