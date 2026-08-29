/** Timed-event layout for day/week timelines (Apple Calendar-style positioning). */

export const DESKTOP_HOUR_HEIGHT_PX = 56;
export const MOBILE_HOUR_HEIGHT_PX = 48;
export const MIN_EVENT_MINUTES = 15;
/** Reserved sticky height for weekday + date number. Timed events start below this. */
export const WEEK_DAY_HEADER_HEIGHT_PX = 72;
export const MOBILE_DAY_HEADER_HEIGHT_PX = 44;
/**
 * Padding on the timed-events layer so the first hour label (centered on the
 * 08:00 line via -translate-y-1/2) cannot paint into the date header.
 * Event `top`/`height` stay relative to the hour grid inside this layer.
 */
export const TIMED_EVENTS_LAYER_OFFSET_PX = 10;

export function parseTimeToMinutes(time: string): number {
  const parts = String(time || '0:0').split(':');
  const hours = Number(parts[0]) || 0;
  const minutes = Number(parts[1]) || 0;
  return hours * 60 + minutes;
}

export type TimedItem = {
  id: string;
  startTime: string;
  endTime: string;
};

export type LaidOutEvent<T extends TimedItem> = {
  item: T;
  startMinutes: number;
  endMinutes: number;
  top: number;
  height: number;
  column: number;
  columnCount: number;
};

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function layoutDayEvents<T extends TimedItem>(
  items: T[],
  hourStart: number,
  hourEnd: number,
  hourHeight = DESKTOP_HOUR_HEIGHT_PX
): LaidOutEvent<T>[] {
  const rangeStart = hourStart * 60;
  const rangeEnd = (hourEnd + 1) * 60;

  const prepared = items
    .map((item) => {
      let start = parseTimeToMinutes(item.startTime);
      let end = parseTimeToMinutes(item.endTime);
      if (end <= start) end = start + MIN_EVENT_MINUTES;
      start = Math.max(start, rangeStart);
      end = Math.min(end, rangeEnd);
      if (end <= start) end = Math.min(start + 8, rangeEnd);
      return { item, startMinutes: start, endMinutes: Math.max(end, start + 8) };
    })
    .sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes);

  const columns: number[][] = [];
  const colOf: number[] = [];

  for (let i = 0; i < prepared.length; i += 1) {
    const ev = prepared[i];
    let placed = false;
    for (let c = 0; c < columns.length; c += 1) {
      const lastIdx = columns[c][columns[c].length - 1];
      const last = prepared[lastIdx];
      if (last.endMinutes <= ev.startMinutes) {
        columns[c].push(i);
        colOf[i] = c;
        placed = true;
        break;
      }
    }
    if (!placed) {
      colOf[i] = columns.length;
      columns.push([i]);
    }
  }

  const parent = prepared.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      if (
        overlaps(
          prepared[i].startMinutes,
          prepared[i].endMinutes,
          prepared[j].startMinutes,
          prepared[j].endMinutes
        )
      ) {
        union(i, j);
      }
    }
  }

  const clusterCols = new Map<number, number>();
  for (let i = 0; i < prepared.length; i += 1) {
    const root = find(i);
    clusterCols.set(root, Math.max(clusterCols.get(root) ?? 0, colOf[i] + 1));
  }

  return prepared.map((ev, i) => ({
    item: ev.item,
    startMinutes: ev.startMinutes,
    endMinutes: ev.endMinutes,
    top: ((ev.startMinutes - rangeStart) / 60) * hourHeight,
    height: Math.max(((ev.endMinutes - ev.startMinutes) / 60) * hourHeight, 22),
    column: colOf[i] ?? 0,
    columnCount: clusterCols.get(find(i)) ?? 1,
  }));
}

export function nowLineOffset(
  hourStart: number,
  hourHeight: number,
  now = new Date()
): number {
  const minutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  return ((minutes - hourStart * 60) / 60) * hourHeight;
}

export function isNowWithinHours(hourStart: number, hourEnd: number, now = new Date()): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= hourStart * 60 && minutes <= (hourEnd + 1) * 60;
}
