import { timingSafeEqual } from 'node:crypto';
import { createService, AppError } from './domain.js';

export function checkCronAuthorization(header, secret) {
  if (!secret || secret.length < 24 || typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${secret}`), received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
export async function runDailyCheck({ store, notify, now }) {
  const service = createService({ store, notify, now });
  const summary = { checked: 0, advanced: 0, reminders: 0, failedDeliveries: 0, errors: 0 };
  let batch = [];
  async function process(id) {
    try {
      const result = await service.processScheduled(id);
      summary.checked++; summary.advanced += Number(result.advanced);
      summary.reminders += Number(result.reminded); summary.failedDeliveries += result.failed;
    } catch (error) { summary.errors++; console.error('Scheduled check failed:', error instanceof AppError ? error.status : error.name); }
  }
  for await (const id of store.scheduled()) {
    batch.push(process(id));
    if (batch.length === 5) { await Promise.all(batch); batch = []; }
  }
  await Promise.all(batch);
  return summary;
}
