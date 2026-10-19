import webpush from 'web-push';

export function pushReady(env = process.env) {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_CONTACT);
}
export function createNotifier(env = process.env) {
  return async ({ id, version, subscriptions }) => {
    if (!subscriptions.length) return { sent: 0, failed: 0 };
    if (!pushReady(env)) return { sent: 0, failed: subscriptions.length };
    // Generic lock-screen text deliberately contains no phase or cycle identifier.
    const payload = JSON.stringify({ title: 'Know Her Cycle', body: 'Cycle status updated. Open the app to see what’s new.',
      url: '/', tag: `cycle-update-${version}` });
    const results = await Promise.all(subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(subscription, payload, {
          TTL: 3600, timeout: 8000, urgency: 'normal',
          vapidDetails: { subject: env.VAPID_CONTACT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY }
        });
        return { sent: true };
      } catch (error) {
        return { sent: false, expired: [404, 410].includes(error.statusCode), endpoint: subscription.endpoint };
      }
    }));
    return { sent: results.filter((r) => r.sent).length, failed: results.filter((r) => !r.sent).length,
      expired: results.filter((r) => r.expired).map((r) => r.endpoint) };
  };
}
