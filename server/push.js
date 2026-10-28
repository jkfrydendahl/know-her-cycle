import webpush from 'web-push';
import { createECDH } from 'node:crypto';
const PROVIDER_REASONS = new Set(['BadJwtToken', 'BadVapidPublicKey', 'VapidPkHashMismatch', 'BadSubject',
  'BadRequest', 'BadTtl', 'BadUrgency', 'BadTopic', 'PayloadTooLarge', 'ExpiredToken', 'BadDeviceToken', 'Unregistered']);

export function vapidConfiguration(env = process.env) {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim().replace(/=+$/, '');
  const privateKey = env.VAPID_PRIVATE_KEY?.trim().replace(/=+$/, '');
  let subject = env.VAPID_CONTACT?.trim();
  if (!publicKey && !privateKey && !subject) return { details: null, error: null };
  if (!publicKey || !privateKey || !subject) return { details: null, error: 'Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_CONTACT, then redeploy.' };
  // Accept a bare contact email as well as the documented mailto: form.
  if (/^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/.test(subject)) subject = `mailto:${subject}`;
  try {
    const contact = new URL(subject);
    if (!['mailto:', 'https:'].includes(contact.protocol) || contact.hostname === 'localhost'
      || (contact.protocol === 'mailto:' && !/^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/.test(contact.pathname))) throw new Error();
  } catch { return { details: null, error: 'VAPID_CONTACT must be a valid mailto: email address or public HTTPS URL.' }; }
  try {
    if (!/^[\w-]+$/.test(publicKey) || !/^[\w-]+$/.test(privateKey)
      || Buffer.from(publicKey, 'base64url').length !== 65 || Buffer.from(privateKey, 'base64url').length !== 32) throw new Error();
    const keyPair = createECDH('prime256v1');
    keyPair.setPrivateKey(Buffer.from(privateKey, 'base64url'));
    if (keyPair.getPublicKey('base64url') !== publicKey) {
      return { details: null, error: 'VAPID public and private keys do not match. Set both from the same generated pair, then redeploy.' };
    }
  } catch { return { details: null, error: 'The VAPID keys are invalid. Check the generated public and private key values, then redeploy.' }; }
  return { details: { subject, publicKey, privateKey }, error: null };
}

export function pushReady(env = process.env) {
  return Boolean(vapidConfiguration(env).details);
}
export function createNotifier(env = process.env, send = webpush.sendNotification.bind(webpush), log = console.warn) {
  return async ({ version, subscriptions, type = 'change' }) => {
    if (!subscriptions.length) return { sent: 0, failed: 0 };
    const configuration = vapidConfiguration(env);
    if (!configuration.details) return { sent: 0, failed: subscriptions.length, reason: configuration.error || 'Push notifications are not configured on the server.' };
    // Generic lock-screen text deliberately contains no phase or cycle identifier.
    const payload = JSON.stringify({ type, title: type === 'test-reminder' ? 'Test reminder' : type === 'reminder' ? 'Cycle reminder' : 'Cycle updated',
      body: type === 'test-reminder' ? 'This is a test reminder. No phase change is scheduled by this message.' : type === 'reminder' ? 'Your next phase is scheduled for tomorrow.' : 'Open the app to see the latest phase.',
      url: '/', tag: `cycle-update-${version}` });
    const results = await Promise.all(subscriptions.map(async (subscription) => {
      try {
        await send(subscription, payload, {
          TTL: 3600, timeout: 8000, urgency: 'normal',
          vapidDetails: configuration.details
        });
        return { sent: true };
      } catch (error) {
        const status = Number(error.statusCode) || 0;
        let providerReason = '';
        try {
          const value = JSON.parse(error.body)?.reason;
          if (PROVIDER_REASONS.has(value)) providerReason = value;
        } catch { /* Never expose raw provider bodies, headers or endpoints. */ }
        const reason = [401, 403].includes(status)
          ? `Push authentication rejected (${status}${providerReason ? ` ${providerReason}` : ''}). Check the VAPID contact and matching key pair.`
          : [404, 410].includes(status) ? 'A notification subscription expired. Turn notifications off and on again on the affected device.'
          : status === 429 ? 'The push service is temporarily rate limiting notifications. Try again later.'
          : status ? `The push service rejected a notification (HTTP ${status}).`
          : 'The notification could not reach the push service. Try again and check the Vercel function logs.';
        log('Push delivery failed', { status, reason: providerReason || 'PushSendFailed' });
        return { sent: false, expired: [404, 410].includes(status), endpoint: subscription.endpoint, reason };
      }
    }));
    const reason = results.find((r) => !r.sent)?.reason;
    return { sent: results.filter((r) => r.sent).length, failed: results.filter((r) => !r.sent).length, ...(reason ? { reason } : {}),
      expired: results.filter((r) => r.expired).map((r) => r.endpoint) };
  };
}
