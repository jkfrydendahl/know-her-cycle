import { PHASES, phaseById } from './phases.js';

const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'khc-access-v1', CACHE_KEY = 'khc-last-state-v1';
let token = null, state = null, config = null, busy = false, stale = true, swRegistration = null;
let phaseMode = 'create', toastTimer, currentSubscription = null, pollTimer;
let lastSync = null;
let renderedPhase = null;
function load(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function persist(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { throw new Error('Browser storage is unavailable. Enable storage before setting up this device.'); }
}
function toast(message, error = false) {
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').classList.toggle('error', error);
  $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 9000 : 5000);
}
function open(id) { $(id).showModal(); }
function close(id) { $(id).close(); }
async function request(action, body, access = token) {
  const response = await fetch(`/api/${action}`, { method: body === undefined ? 'GET' : 'POST',
    cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(18_000),
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(access ? { Authorization: `Bearer ${access}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let result;
  try { result = await response.json(); } catch { throw new Error('The service returned an unexpected response.'); }
  if (!response.ok) { const error = new Error(result.error || 'Please try again.'); error.status = response.status; throw error; }
  return result;
}
function setState(next) {
  if (!next || !phaseById(next.phase)) throw new Error('The saved cycle could not be read.');
  state = next; stale = false; lastSync = new Date().toISOString();
  try { persist(CACHE_KEY, { state: next, lastSync }); } catch { /* Live status remains usable. */ }
  render();
}
function remember(result) {
  persist(SESSION_KEY, result.token); token = result.token; setState(result.state);
}
function forget() {
  localStorage.removeItem(SESSION_KEY); localStorage.removeItem(CACHE_KEY);
  token = null; state = null; lastSync = null; stale = true; currentSubscription = null; renderedPhase = null;
  $('invite-result').hidden = true; $('invite-link').value = '';
  $('diagnostic-events').replaceChildren(); $('diagnostic-status').textContent = '';
  $('notification-diagnostics').open = false; render();
}
async function run(work) {
  if (busy) return;
  busy = true; render();
  try { await work(); } catch (error) {
    if (error.status === 409 && token) await refresh(true);
    if (error.status === 401 && token) {
      forget(); document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
    }
    toast(error.name === 'TimeoutError' ? 'The request timed out. Refresh to check whether it was saved.' : error.message || 'Something went wrong.', true);
  } finally { busy = false; render(); }
}
function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value));
}
function icon(name) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('class', 'ui-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(namespace, 'path');
  path.setAttribute('d', name === 'check' ? 'm5 12 4 4L19 6' : 'M6 18 18 6M6 6h12v12');
  svg.append(path);
  return svg;
}
function buttonContent(button, text, symbol) {
  const label = document.createElement('span');
  label.className = 'button-label';
  label.textContent = text;
  button.replaceChildren(label, icon(symbol));
}
function render() {
  $('welcome').hidden = Boolean(state); $('tracker').hidden = !state;
  $('session-settings').hidden = !state;
  document.querySelectorAll('button').forEach((button) => { button.disabled = busy && !button.classList.contains('close-dialog'); });
  if (!state) {
    $('start-owner').disabled = busy || !config?.storageReady;
    return;
  }
  const phase = phaseById(state.phase), index = PHASES.indexOf(phase), owner = state.role === 'owner';
  const phaseChanged = renderedPhase !== null && renderedPhase !== phase.id;
  renderedPhase = phase.id;
  document.body.dataset.phase = phase.id;
  if (phaseChanged && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const art = document.querySelector('.cycle-art');
    art.getAnimations?.().forEach((animation) => animation.cancel());
    art.animate?.([{ opacity: 0.45, transform: 'scale(.97)' }, { opacity: 1, transform: 'scale(1)' }],
      { duration: 450, easing: 'ease-out' });
  }
  $('phase-eyebrow').textContent = phase.eyebrow; $('phase-name').textContent = `${phase.name} ${phase.emoji}`;
  $('phase-line').textContent = phase.line; $('phase-number').textContent = `0${index + 1} / 04`;
  $('connection').textContent = owner ? (state.linked ? 'Your cycle · partner linked' : 'Your cycle · private') : 'Partner view · linked';
  $('sync-label').textContent = stale ? 'Last synced · offline or unavailable' : 'Synced';
  $('sync-label').classList.toggle('stale', stale);
  $('since-label').textContent = `${state.estimated ? 'Estimated from' : owner ? 'Selected' : 'Shared'} ${formatDate(state.since)}${state.automation?.nextDate ? ` · Next ${formatDate(state.automation.nextDate)}` : ''}${stale && lastSync ? ` · last synced ${formatDate(lastSync)}` : ''}`;
  $('phase-strip').querySelectorAll('.phase-item').forEach((item, i) => {
    if (i === index) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
  });
  $('owner-actions').hidden = !owner; $('viewer-actions').hidden = owner;
  buttonContent($('next-phase'), `Start ${phase.next.toLowerCase()} phase`, 'arrow');
  $('next-phase').disabled = busy || stale; $('correct-phase').disabled = busy || stale;
  $('undo').disabled = busy || stale || !state.canUndo;
  $('role-label').textContent = owner ? 'Your cycle, your choice' : 'Shared with you';
  $('sharing-label').textContent = owner ? (state.linked ? 'Your partner can view your selected phase.' : 'Only you can see this cycle. Invite your partner when you’re ready.') : 'Your partner selects the phase. You can leave this shared cycle at any time.';
  $('invite').hidden = !owner || state.linked;
  $('invite').disabled = busy || stale;
  $('disconnect').hidden = !state.linked;
  $('disconnect').disabled = busy || stale;
  $('disconnect').textContent = owner ? 'Disconnect partner' : 'Leave shared cycle';
  $('delete-section').hidden = !owner;
  $('delete-cycle').disabled = busy || stale;
  $('automation-settings').hidden = !owner;
  $('auto-save').disabled = busy || stale;
  $('notification-settings').hidden = false;
  $('test-reminder').disabled = busy || stale;
  $('refresh-diagnostics').disabled = busy || stale;
  $('test-reminder').textContent = owner ? 'Send me a test reminder' : 'Send her a test reminder';
  $('test-reminder-hint').textContent = owner ? 'Sends to your enabled notification devices without changing your schedule.' : 'Sends to her enabled notification devices. Your subscription and the schedule stay as they are.';
  const enabled = Boolean(currentSubscription) && globalThis.Notification?.permission === 'granted';
  buttonContent($('enable-push'), enabled ? 'Notifications enabled' : 'Notify me of changes', enabled ? 'check' : 'arrow');
  $('enable-push').disabled = busy || stale || enabled || !config?.vapidPublicKey;
  $('owner-enable-push').hidden = !owner || !state.automation?.enabled || !state.automation.reminders;
  $('owner-enable-push').textContent = enabled ? 'Notifications allowed on this phone' : 'Allow notifications on this phone';
  $('owner-enable-push').disabled = busy || stale || enabled || !config?.vapidPublicKey;
  $('auto-notification-hint').textContent = owner && state.automation?.enabled && state.automation.reminders
    ? config?.pushConfigurationError || (!config?.vapidPublicKey ? 'Notifications need to be configured on the server.' : enabled ? 'This device will receive a reminder the day before a scheduled change.' : 'Reminders are turned on for your cycle. Allow notifications on this phone to receive them here. On iPhone, open the installed Home Screen app.') : '';
  $('disable-push').disabled = busy || stale || !currentSubscription;
  $('notification-status').textContent = enabled ? 'Notifications are enabled on this device.' : 'Notifications are off on this device.';
  $('push-hint').textContent = config?.pushConfigurationError || (!config?.vapidPublicKey ? 'Notifications will be available once the server is configured.'
    : enabled ? 'We’ll let you know when the shared status changes.' : 'Optional. One notification when she updates the phase.');
}
async function refresh(quiet = false) {
  if (!token) return;
  try {
    const result = await request('state'); setState(result.state);
  } catch (error) {
    if (error.status === 401) { forget(); if (!quiet) toast('This device is no longer linked. Restore access or ask for a new invitation.', true); }
    else { stale = true; render(); if (!quiet) toast('Could not sync. Showing the last saved status.', true); }
  }
}
function selectPhase(mode) {
  phaseMode = mode;
  $('phase-dialog-title').textContent = mode === 'create' ? 'Where are you now?' : 'Choose your phase.';
  $('phase-options').querySelectorAll('button').forEach((button) => button.setAttribute('aria-pressed', String(state?.phase === button.dataset.phase)));
  open('phase-dialog');
}
async function changePhase(phase, undo = false) {
  const result = await request('phase', { phase, undo, version: state.version });
  setState(result.state);
  if ($('phase-dialog').open) close('phase-dialog');
  $('phase-name').focus({ preventScroll: true });
  toast(result.notification.failed ? `Phase saved. ${result.notification.reason || 'A partner notification could not be delivered.'}` : undo ? 'Last change undone.' : 'Phase updated.', Boolean(result.notification.failed));
}
function invitationFrom(value) {
  const trimmed = value.trim();
  if (trimmed.includes('#')) {
    try { return new URLSearchParams(new URL(trimmed).hash.slice(1)).get('join') || ''; } catch { return ''; }
  }
  return trimmed;
}
async function copy(value, message) {
  try { await navigator.clipboard.writeText(value); toast(message); }
  catch { throw new Error('Copy is unavailable here. Try opening the installed app or using a supported browser.'); }
}
function vapidBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
function subscriptionKeyMatches(subscription) {
  const key = subscription.options?.applicationServerKey;
  if (!key || !config?.vapidPublicKey) return false;
  const actual = new Uint8Array(key), expected = vapidBytes(config.vapidPublicKey);
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
}
async function enablePush() {
  // Call permission immediately in the click gesture, before network requests.
  if (!('Notification' in window) || !('PushManager' in window) || !swRegistration) throw new Error('Push notifications are not supported on this browser.');
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && !matchMedia('(display-mode: standalone)').matches && !navigator.standalone) throw new Error('On iPhone or iPad, add this app to the Home Screen, open it there, then enable notifications.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were not allowed. You can change this in your phone or browser settings.');
  let existing = await swRegistration.pushManager.getSubscription();
  if (existing && !subscriptionKeyMatches(existing)) {
    await request('unsubscribe', { endpoint: existing.endpoint });
    await existing.unsubscribe(); existing = null;
  }
  const subscription = existing || await swRegistration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidBytes(config.vapidPublicKey) });
  try {
    const result = await request('subscribe', { subscription: subscription.toJSON() });
    currentSubscription = subscription; setState(result.state); toast('Notifications enabled.');
  } catch (error) { if (!existing) await subscription.unsubscribe(); throw error; }
}
async function disablePush() {
  if (!currentSubscription) return;
  const result = await request('unsubscribe', { endpoint: currentSubscription.endpoint });
  await currentSubscription.unsubscribe(); currentSubscription = null; setState(result.state);
  toast('Notifications turned off on this device.');
}
async function syncSubscription() {
  if (!swRegistration || !state) return;
  try {
    const subscription = await swRegistration.pushManager.getSubscription();
    if (subscription && Notification.permission === 'granted' && config?.vapidPublicKey) {
      if (!subscriptionKeyMatches(subscription)) {
        await request('unsubscribe', { endpoint: subscription.endpoint });
        await subscription.unsubscribe(); currentSubscription = null;
        toast('Notification keys changed. Enable notifications again on this device.');
        render(); return;
      }
      await request('subscribe', { subscription: subscription.toJSON() }); currentSubscription = subscription;
    }
  } catch { currentSubscription = null; }
  render();
}
function diagnosticText(event) {
  if (event.kind === 'cron-started') return 'Daily job started.';
  if (event.kind === 'cron-completed') return 'Daily job completed.';
  if (event.kind === 'cron-errors') return 'Daily job encountered an error.';
  if (event.kind === 'check-started') return 'Checking this cycle.';
  if (event.kind === 'check-error') return 'This cycle could not be checked.';
  if (event.kind === 'test-started') return `Test started · ${event.ownerDevices} tracking device(s) subscribed.`;
  if (event.kind === 'test-result') {
    if (event.status === 'no-subscription') return 'Test not sent: no tracking devices subscribed. Enable notifications on her phone.';
    if (event.status === 'skipped') return 'Test skipped because the cycle or sharing changed.';
    return `Test: ${event.sent} accepted by push service, ${event.failed} failed.${event.reason ? ` ${event.reason}` : ''}`;
  }
  if (event.kind === 'check-result') {
    let message = event.advanced ? 'Phase advanced automatically. ' : '';
    if (!event.remindersEnabled) return message + 'Day-before reminders are off.';
    if (!event.reminderDue) return message + 'No reminder due for tomorrow.';
    if (event.alreadyAttempted) return message + 'Reminder already attempted; no duplicate sent.';
    if (!event.ownerDevices) return message + 'Reminder due, but no tracking devices subscribed.';
    return message + `Reminder due · ${event.ownerDevices} tracking device(s): ${event.reminderSent || 0} accepted, ${event.reminderFailed || 0} failed.${event.reason ? ` ${event.reason}` : ''}`;
  }
  return 'Diagnostic event.';
}
async function loadDiagnostics() {
  const result = await request('diagnostics');
  const entries = [...result.events, ...result.cron].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  $('diagnostic-status').textContent = `${result.ownerDevices} tracking device(s) subscribed. ${result.cron.length ? '' : 'No daily job recorded yet. '}${entries.length ? '' : 'History starts with this update.'}`.trim();
  $('diagnostic-events').replaceChildren(...entries.map((event) => {
    const item = document.createElement('li'), time = document.createElement('time'), message = document.createElement('span');
    time.dateTime = event.at; time.textContent = new Date(event.at).toLocaleString();
    message.textContent = diagnosticText(event); item.append(time, message); return item;
  }));
}
function populateSchedule() {
  if (state?.role !== 'owner') return;
  const schedule = state.automation;
  $('auto-enabled').checked = Boolean(schedule?.enabled);
  $('auto-fields').disabled = !schedule?.enabled;
  PHASES.forEach((phase) => { $(`auto-${phase.id}`).value = schedule?.days[phase.id] ?? ''; });
  const timeZone = schedule?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  $('auto-timezone').value = timeZone;
  $('auto-start-label').textContent = `${phaseById(state.phase).name} started`;
  const sinceParts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(state.since));
  const since = Object.fromEntries(sinceParts.map((part) => [part.type, part.value]));
  $('auto-start').value = schedule?.startDate || (/^\d{4}-\d{2}-\d{2}$/.test(state.since) ? state.since : `${since.year}-${since.month}-${since.day}`);
  $('auto-reminders').checked = Boolean(schedule?.reminders);
}
function wire() {
  PHASES.forEach((phase) => {
    const item = document.createElement('span'); item.className = 'phase-item'; item.textContent = phase.short; $('phase-strip').append(item);
    const option = document.createElement('button'); option.type = 'button'; option.className = 'phase-option'; option.dataset.phase = phase.id;
    const label = document.createElement('span'); label.textContent = `${phase.name} ${phase.emoji}`; option.append(label, icon('arrow'));
    option.addEventListener('click', () => run(async () => {
      if (phaseMode === 'create') { remember(await request('create', { phase: phase.id }, null)); close('phase-dialog'); }
      else if (state.phase === phase.id) close('phase-dialog');
      else await changePhase(phase.id);
    })); $('phase-options').append(option);
  });
  document.querySelectorAll('.close-dialog').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
  $('settings-open').addEventListener('click', () => { render(); populateSchedule(); open('settings-dialog'); });
  $('start-owner').addEventListener('click', () => selectPhase('create'));
  $('start-viewer').addEventListener('click', () => open('join-dialog'));
  $('restore-open').addEventListener('click', () => open('restore-dialog'));
  $('correct-phase').addEventListener('click', () => selectPhase('correct'));
  $('next-phase').addEventListener('click', () => run(() => changePhase(PHASES[(PHASES.findIndex((p) => p.id === state.phase) + 1) % 4].id)));
  $('undo').addEventListener('click', () => run(() => changePhase(undefined, true)));
  $('refresh').addEventListener('click', () => run(() => refresh()));
  $('auto-enabled').addEventListener('change', () => { $('auto-fields').disabled = !$('auto-enabled').checked; });
  $('automation-form').addEventListener('submit', (event) => { event.preventDefault(); run(async () => {
    const enabled = $('auto-enabled').checked;
    const input = { version: state.version, enabled };
    if (enabled) Object.assign(input, { reminders: $('auto-reminders').checked,
      days: Object.fromEntries(PHASES.map((phase) => [phase.id, Number($(`auto-${phase.id}`).value)])),
      startDate: $('auto-start').value, timeZone: $('auto-timezone').value.trim() });
    const result = await request('automation', input);
    setState(result.state); populateSchedule();
    toast(result.notification.failed ? 'Schedule saved. A partner notification could not be delivered.' : enabled ? 'Schedule saved.' : 'Automatic switching paused.', Boolean(result.notification.failed));
  }); });
  $('owner-enable-push').addEventListener('click', () => run(enablePush));
  $('enable-push').addEventListener('click', () => run(enablePush));
  $('disable-push').addEventListener('click', () => run(disablePush));
  $('test-reminder').addEventListener('click', () => run(async () => {
    const result = await request('test-reminder', {}), delivery = result.notification;
    toast(!result.ownerDevices ? 'No tracking devices subscribed. Enable notifications on her phone first.'
      : delivery.failed ? `Test reminder: ${delivery.sent} accepted, ${delivery.failed} failed. ${delivery.reason || ''}`
      : delivery.sent ? 'Test reminder accepted by the push service. Check her enabled devices.' : 'Test skipped because the cycle or sharing changed.', !result.ownerDevices || Boolean(delivery.failed));
    if ($('notification-diagnostics').open) await loadDiagnostics();
  }));
  $('refresh-diagnostics').addEventListener('click', () => run(loadDiagnostics));
  $('notification-diagnostics').addEventListener('toggle', () => { if ($('notification-diagnostics').open && !busy) run(loadDiagnostics); });
  $('join-form').addEventListener('submit', (event) => { event.preventDefault(); run(async () => {
    const result = await request('join', { invitation: invitationFrom($('invitation').value) }, null);
    remember(result); $('invitation').value = ''; close('join-dialog'); await syncSubscription(); toast('You’re connected.');
  }); });
  $('restore-form').addEventListener('submit', (event) => { event.preventDefault(); run(async () => {
    const recovery = $('recovery-key').value.trim();
    const result = await request('state', undefined, recovery);
    remember({ token: recovery, state: result.state }); $('recovery-key').value = ''; close('restore-dialog');
    await syncSubscription(); toast('Access restored.');
  }); });
  $('invite').addEventListener('click', () => run(async () => {
    const result = await request('invite', {});
    $('invite-link').value = `${location.origin}/#join=${encodeURIComponent(result.invitation)}`;
    $('invite-expiry').textContent = `Expires at ${new Date(result.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Works once. A new invitation replaces this one.`;
    $('invite-result').hidden = false; $('share-invite').hidden = !navigator.share;
  }));
  $('copy-invite').addEventListener('click', () => run(() => copy($('invite-link').value, 'Invitation copied.')));
  $('share-invite').addEventListener('click', () => run(async () => {
    try { await navigator.share({ title: 'Know Her Cycle', text: 'Join my shared cycle.', url: $('invite-link').value }); }
    catch (error) { if (error.name !== 'AbortError') throw error; }
  }));
  $('copy-key').addEventListener('click', () => run(() => copy(token, 'Private access key copied. Keep it safe.')));
  $('disconnect').addEventListener('click', () => run(async () => {
    const owner = state.role === 'owner';
    if (!confirm(owner ? 'Disconnect your partner? Their access and notifications will stop.' : 'Leave this cycle? You’ll need a new invitation to join again.')) return;
    const result = await request('disconnect', {});
    if (owner) { setState(result.state); toast('Partner disconnected.'); }
    else {
      try { await currentSubscription?.unsubscribe(); } catch { /* Server membership is already revoked. */ }
      forget(); close('settings-dialog'); toast('You’ve left this cycle.');
    }
  }));
  $('sign-out').addEventListener('click', () => run(async () => {
    if (!confirm('Forget this device? Save your access key first. Notifications on this device will be removed.')) return;
    {
      const subscription = currentSubscription || await swRegistration?.pushManager.getSubscription();
      if (subscription) { await request('unsubscribe', { endpoint: subscription.endpoint }); await subscription.unsubscribe(); }
    }
    forget(); close('settings-dialog'); toast('This device has been forgotten.');
  }));
  $('delete-cycle').addEventListener('click', () => run(async () => {
    if (!confirm('Permanently delete this cycle, all access keys, and all notification subscriptions?')) return;
    await request('delete', {}); forget(); close('settings-dialog'); toast('Cycle deleted.');
  }));
  window.addEventListener('online', () => { refresh(true); });
  window.addEventListener('offline', () => { stale = true; render(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !busy) refresh(true); });
  navigator.serviceWorker?.addEventListener('message', (event) => { if (event.data?.type === 'phase-updated') refresh(true); });
}
async function initialize() {
  // The invitation travels in a URL fragment: it never reaches server request logs.
  const invitation = new URLSearchParams(location.hash.slice(1)).get('join');
  if (location.hash) history.replaceState(null, '', location.pathname);
  wire();
  token = load(SESSION_KEY);
  const cached = token && load(CACHE_KEY);
  if (cached?.state && phaseById(cached.state.phase)) { state = cached.state; lastSync = cached.lastSync; }
  render();
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('/sw.js'); swRegistration = await navigator.serviceWorker.ready; }
    catch { /* The app remains usable without push or offline support. */ }
  }
  try {
    config = await request('config', undefined, null);
    $('setup-note').textContent = config.storageReady ? '' : 'Almost ready. The app’s shared storage still needs to be configured.';
  } catch { $('setup-note').textContent = 'The service is unavailable. Check your connection and reload.'; }
  if (token) await refresh();
  await syncSubscription(); render();
  if (invitation) {
    if (token) toast('This device already has a cycle. Forget it in settings before using another invitation.', true);
    else { $('invitation').value = invitation; open('join-dialog'); }
  }
  pollTimer = setInterval(() => { if (!document.hidden && !busy && navigator.onLine) refresh(true); }, 60_000);
}
initialize().catch(() => toast('The app could not start. Please reload.', true));
