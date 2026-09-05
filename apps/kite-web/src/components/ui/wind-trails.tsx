import { cn } from '@/lib/utils';

export function WindTrails({ className }: { readonly className?: string }) {
  const paths = [
    'M-80 382 C 120 232, 256 426, 480 258 S 850 110, 1110 252',
    'M-120 438 C 90 296, 276 474, 500 306 S 860 160, 1120 300',
    'M-160 492 C 70 364, 304 510, 534 358 S 882 224, 1160 354',
    'M-42 314 C 164 164, 302 352, 520 202 S 848 62, 1080 194',
    'M20 246 C 196 120, 348 276, 552 146 S 832 26, 1034 118',
  ] as const;

  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute inset-0 overflow-hidden text-wind-line',
        className,
      )}
    >
      <svg
        className="size-full"
        viewBox="0 0 960 540"
        fill="none"
        preserveAspectRatio="xMidYMid slice"
      >
        <title>Decorative wind trails</title>
        <g className="wind-trails-base">
          {paths.map((path) => (
            <path key={`base-${path}`} d={path} />
          ))}
        </g>
        <g className="wind-trails-flow">
          {paths.map((path) => (
            <path key={`flow-${path}`} d={path} />
          ))}
        </g>
      </svg>
    </div>
  );
}
