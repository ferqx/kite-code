import { useMemo } from 'react';
import type { TrajectoryWorkbench, WorkbenchRow } from './workbench';

const lanes = [
  { id: 'message', label: '输入 / 回复' },
  { id: 'model', label: '思考' },
  { id: 'tool', label: '工具 / 子任务' },
  { id: 'compression-approval', label: '压缩 / 审批' },
] as const;
type LaneId = (typeof lanes)[number]['id'];
interface Mark {
  row: WorkbenchRow;
  left: number;
  width: number;
  track: number;
  duration: boolean;
}
interface Tick {
  left: number;
  label: string;
}
interface TimelineGroup {
  key: string;
  label: string;
  unknown: boolean;
  ticks: Tick[];
  marks: Map<LaneId | 'auxiliary', Mark[]>;
}

function laneFor(row: WorkbenchRow): LaneId | 'auxiliary' {
  if (row.category === 'compression' || row.category === 'approval') return 'compression-approval';
  if (row.category === 'message' || row.category === 'model' || row.category === 'tool')
    return row.category;
  return 'auxiliary';
}

function elapsed(milliseconds: number): string {
  if (milliseconds === 0) return '0 s';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  const seconds = milliseconds / 1000;
  return `${Number(seconds.toFixed(seconds < 10 ? 2 : 1))} s`;
}

/** Leave room for endpoint markers without shifting their recorded relative order. */
const position = (ratio: number) => 1 + Math.max(0, Math.min(1, ratio)) * 98;

function group(
  rows: WorkbenchRow[],
  key: string,
  label: string,
  unknown: boolean,
  ordered: boolean,
  startAt?: number,
  endAt?: number,
): TimelineGroup {
  const span = Math.max(0, (endAt ?? 0) - (startAt ?? 0));
  const marks = new Map<LaneId | 'auxiliary', Mark[]>();
  const laneEnds = new Map<LaneId | 'auxiliary', number[]>();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const lane = laneFor(row);
    const start = row.interval.startAt ?? row.positionAt;
    const duration =
      !ordered &&
      !unknown &&
      lane !== 'message' &&
      lane !== 'auxiliary' &&
      row.interval.basis !== 'unknown' &&
      row.interval.durationMs !== undefined &&
      start !== undefined &&
      row.interval.endAt !== undefined;
    const left =
      ordered || unknown
        ? position(index / Math.max(1, rows.length - 1))
        : position(((start ?? startAt ?? 0) - (startAt ?? 0)) / Math.max(1, span));
    const width = duration ? ((row.interval.endAt! - start!) / Math.max(1, span)) * 98 : 0;
    const ends = laneEnds.get(lane) ?? [];
    let track = ends.findIndex((end) => end + 0.8 < left);
    if (track < 0) track = ends.length;
    ends[track] = left + Math.max(width, 0.8);
    laneEnds.set(lane, ends);
    const entries = marks.get(lane) ?? [];
    entries.push({ row, left, width, track, duration });
    marks.set(lane, entries);
  }
  const ticks: Tick[] = [];
  if (ordered || unknown) {
    const indices = new Set(
      Array.from({ length: Math.min(5, rows.length) }, (_, index) =>
        Math.round((index / Math.max(1, Math.min(4, rows.length - 1))) * (rows.length - 1)),
      ),
    );
    for (const index of indices)
      ticks.push({
        left: position(index / Math.max(1, rows.length - 1)),
        label: `#${rows[index]!.firstSequence}`,
      });
  } else {
    for (let index = 0; index < (span > 0 ? 5 : 1); index++)
      ticks.push({ left: position(index / 4), label: elapsed((span * index) / 4) });
  }
  return { key, label, unknown, ticks, marks };
}

/** Four semantic lanes share coordinates only inside the same verified clock domain. */
export function TrajectoryTimeline({
  workbench,
  mode,
  selectedId,
  onChoose,
  labelFor,
}: {
  workbench: TrajectoryWorkbench;
  mode: 'time' | 'order';
  selectedId?: string | null;
  onModeChange: () => void;
  onChoose: (id: string) => void;
  labelFor?: (row: WorkbenchRow) => string;
}) {
  const groups = useMemo(() => {
    if (mode === 'order') {
      const rows = workbench.rows.filter(
        (row) =>
          row.matched && !row.virtualPart && !(row.kind === 'message' && row.outputSuppressed),
      );
      return rows.length ? [group(rows, 'order', '事件顺序 · 间距不代表耗时', false, true)] : [];
    }
    return workbench.timelineDomains.flatMap((domain, index) => {
      const rows = domain.rows.filter(
        (row) => row.matched && !(row.kind === 'message' && row.outputSuppressed),
      );
      if (!rows.length) return [];
      return [
        group(
          rows,
          `clock:${index}`,
          domain.unknown
            ? `时间未知 · ${rows.length} 项 · 按事件顺序定位`
            : `同来源观测 · ${domain.originStoreId ?? '来源未记录'} · 相对时间`,
          domain.unknown,
          false,
          domain.startAt ?? undefined,
          domain.endAt ?? undefined,
        ),
      ];
    });
  }, [workbench, mode]);
  return (
    <div className="trajectory-timeline">
      <div className="trajectory-timeline-heading">
        <span>执行概览</span>
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard readers need to scroll the bounded timeline region. */}
      <section className="trajectory-timeline-scroll" aria-label="执行概览坐标" tabIndex={0}>
        {groups.map((entry, index) => (
          <section
            className="trajectory-timeline-domain"
            key={entry.key}
            data-unknown={entry.unknown || undefined}
            aria-label={entry.label}
          >
            <p className="trajectory-timeline-domain-label" title={entry.label}>
              {mode === 'order'
                ? '事件顺序'
                : entry.unknown
                  ? '时间未记录'
                  : groups.length > 1
                    ? `时间轴 ${index + 1} · 相对时间`
                    : '相对时间'}
            </p>
            <div className="trajectory-timeline-ruler">
              <span aria-hidden="true" />
              <div className="trajectory-timeline-ruler-track">
                {entry.ticks.map((tick) => (
                  <span
                    className="trajectory-timeline-tick"
                    key={`${tick.left}:${tick.label}`}
                    style={{ left: `${tick.left}%` }}
                  >
                    {tick.label}
                  </span>
                ))}
              </div>
            </div>
            {lanes.map((lane) => (
              <Lane
                key={lane.id}
                id={lane.id}
                label={lane.label}
                marks={entry.marks.get(lane.id) ?? []}
                ticks={entry.ticks}
                selectedId={selectedId}
                onChoose={onChoose}
                labelFor={labelFor}
              />
            ))}
            {!!entry.marks.get('auxiliary')?.length && (
              <Lane
                id="auxiliary"
                label="辅助原事件"
                marks={entry.marks.get('auxiliary')!}
                ticks={entry.ticks}
                selectedId={selectedId}
                onChoose={onChoose}
                labelFor={labelFor}
              />
            )}
          </section>
        ))}
        {!groups.length && <p>没有可定位的记录。</p>}
      </section>
      <div className="trajectory-timeline-footnote">
        <span>{mode === 'time' ? '观测时间' : '事件顺序'}</span>
      </div>
    </div>
  );
}

function Lane({
  id,
  label,
  marks,
  ticks,
  selectedId,
  onChoose,
  labelFor,
}: {
  id: LaneId | 'auxiliary';
  label: string;
  marks: Mark[];
  ticks: Tick[];
  selectedId?: string | null;
  onChoose: (id: string) => void;
  labelFor?: (row: WorkbenchRow) => string;
}) {
  let tracks = 1;
  for (const mark of marks) tracks = Math.max(tracks, mark.track + 1);
  return (
    <div
      className={id === 'auxiliary' ? 'trajectory-timeline-auxiliary' : 'trajectory-timeline-lane'}
      data-lane={id}
    >
      <span className="trajectory-timeline-lane-label">{label}</span>
      <div className="trajectory-timeline-track" style={{ height: tracks * 18 + 4 }}>
        {ticks.map((tick) => (
          <span
            key={tick.left}
            className="trajectory-timeline-gridline"
            aria-hidden="true"
            style={{ left: `${tick.left}%` }}
          />
        ))}
        {marks.map(({ row, left, width, track, duration }) => {
          const interval =
            row.interval.unknownReason === 'not_a_call'
              ? row.positionAt === undefined
                ? '时间未记录'
                : '已记录时间点'
              : row.interval.durationMs === undefined
                ? '时长未知'
                : `${row.interval.durationMs}ms · ${row.interval.ongoing ? '已观测进度' : '已记录区间'}`;
          return (
            <button
              key={row.id}
              type="button"
              data-category={row.category}
              data-role={row.step?.messageRole}
              data-trajectory-marker={row.id}
              className={`trajectory-time-point ${duration ? 'trajectory-time-duration' : 'trajectory-time-instant'}${row.id === selectedId ? ' trajectory-timeline-selected' : ''}`}
              style={{
                left: `${left}%`,
                ...(duration ? { width: `${width}%` } : {}),
                top: track * 18 + 5,
              }}
              title={`${labelFor?.(row) ?? row.label} · #${row.firstSequence} · ${interval}`}
              aria-label={`定位${labelFor?.(row) ?? row.label} #${row.firstSequence} · ${interval}`}
              aria-pressed={row.id === selectedId}
              onClick={() => onChoose(row.id)}
            />
          );
        })}
      </div>
    </div>
  );
}
