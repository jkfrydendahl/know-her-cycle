export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// Diagnostic failures must not block a phase change or notification attempt.
export async function writeDiagnostic(store, id, detail, now = () => new Date()) {
  try { await store.appendDiagnostic(id, { ...detail, at: now().toISOString() }); }
  catch { console.warn('Notification diagnostic could not be stored.'); }
}
