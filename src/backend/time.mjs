const fields = date => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(date);
  if (!match) throw badTime();
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day || hour > 23 || minute > 59) throw badTime();
  return { year, month, day, hour, minute };
};
const badTime = () => Object.assign(new Error('This local time does not exist in the selected time zone. Choose another time.'), { status: 400 });
const formatter = timezone => new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const parts = (time, fmt) => Object.fromEntries(fmt.formatToParts(time).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
const pad = value => String(value).padStart(2, '0');
export function localOf(instant, timezone) {
  const { year, month, day, hour, minute } = parts(new Date(instant), formatter(timezone));
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}
export function toInstant(local, timezone) {
  const { year, month, day, hour, minute } = fields(local);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const fmt = formatter(timezone);
  const offsets = [guess - 86400000, guess, guess + 86400000].map(time => {
    const p = parts(new Date(time), fmt);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - time;
  });
  const candidates = [...new Set(offsets)].map(offset => guess - offset).filter(time => {
    const p = parts(new Date(time), fmt);
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
  });
  if (!candidates.length) throw badTime();
  return new Date(Math.min(...candidates)).toISOString();
}
export function advance(local, frequency, count) {
  const { year, month, day, hour, minute } = fields(local);
  if (frequency === 'none') return local;
  if (frequency === 'monthly') {
    const first = new Date(Date.UTC(year, month - 1 + count, 1));
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    return `${first.getUTCFullYear()}-${pad(first.getUTCMonth() + 1)}-${pad(Math.min(day, last))}T${pad(hour)}:${pad(minute)}`;
  }
  const next = new Date(Date.UTC(year, month - 1, day + count * (frequency === 'weekly' ? 7 : 1), hour, minute));
  return next.toISOString().slice(0, 16);
}
export function shift(local, from, to) {
  const a = fields(from), b = fields(to), c = fields(local);
  const stamp = p => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return new Date(stamp(c) + stamp(b) - stamp(a)).toISOString().slice(0, 16);
}
