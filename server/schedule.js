import { PHASES } from '../public/phases.js';

const DAY = 86_400_000;
export function localDate(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export const addDays = (date, count) => new Date(Date.parse(date) + count * DAY).toISOString().slice(0, 10);
export function validTimeZone(value) {
  if (typeof value !== 'string' || value.length > 100) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; }
}
export function validDurations(days) {
  return days && PHASES.every(({ id }) => Number.isInteger(days[id]) && days[id] >= 1 && days[id] <= 90);
}
export function nextDate(record) {
  const schedule = record.automation;
  return schedule?.enabled ? addDays(schedule.startDate, schedule.days[record.phase]) : null;
}
export function projection(record, today) {
  const schedule = record.automation;
  let phaseIndex = PHASES.findIndex(({ id }) => id === record.phase), startDate = schedule.startDate;
  const total = PHASES.reduce((sum, { id }) => sum + schedule.days[id], 0);
  const elapsed = Math.max(0, Math.round((Date.parse(today) - Date.parse(startDate)) / DAY));
  // Skip whole cycles before walking at most four stages, including long outages.
  startDate = addDays(startDate, Math.floor(elapsed / total) * total);
  for (let i = 0; i < PHASES.length; i++) {
    const end = addDays(startDate, schedule.days[PHASES[phaseIndex].id]);
    if (end > today) break;
    startDate = end; phaseIndex = (phaseIndex + 1) % PHASES.length;
  }
  return { phase: PHASES[phaseIndex].id, startDate };
}
