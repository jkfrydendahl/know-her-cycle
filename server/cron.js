import { timingSafeEqual } from 'node:crypto';
import { writeDiagnostic } from './diagnostics.js';
import { createService, AppError } from './domain.js';

export function checkCronAuthorization(header, secret) {
  if (!secret || secret.length < 24 || typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${secret}`), received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
export async function runDailyCheck({ store, notify, now = () => new Date() }) {
  const service = createService({ store, notify, now });
  const summary = { checked: 0, advanced: 0, reminders: 0, failedDeliveries: 0, errors: 0 };
  await writeDiagnostic(store, 'cron', { kind: 'cron-started' }, now);
  let batch = [];
  async function process(id) {
    try {
      await writeDiagnostic(store, id, { kind: 'check-started' }, now);
      const result = await service.processScheduled(id);
      await writeDiagnostic(store, id, { kind: 'check-result', ...result }, now);
      summary.checked++; summary.advanced += Number(result.advanced);
      summary.reminders += Number(result.reminded); summary.failedDeliveries += result.failed;
    } catch (error) {
      await writeDiagnostic(store, id, { kind: 'check-error', status: 'failed' }, now);
      summary.errors++; console.error('Scheduled check failed:', error instanceof AppError ? error.status : error.name);
    }
  }
  try {
    for await (const id of store.scheduled()) {
      batch.push(process(id));
      if (batch.length === 5) { await Promise.all(batch); batch = []; }
    }
    await Promise.all(batch);
    await writeDiagnostic(store, 'cron', { kind: summary.errors ? 'cron-errors' : 'cron-completed' }, now);
    return summary;
  } catch (error) {
    await Promise.allSettled(batch);
    await writeDiagnostic(store, 'cron', { kind: 'cron-errors' }, now);
    throw error;
  }
}
