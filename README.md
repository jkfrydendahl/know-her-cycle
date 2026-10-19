# Know Her Cycle

A small PWA for sharing a manually selected cycle phase. Four colors, one main button, and optional partner notifications.

## Everyday use

1. Choose **Track my cycle** and select the current phase.
2. In settings, create an invitation and share its link with your partner. It expires in ten minutes and works once. Creating another invalidates the previous one.
3. Your partner opens the link, taps **Connect with my partner**, and optionally enables notifications.
4. Tap **Start next phase** whenever you want to change the shared status. Use **Change phase** to correct or skip a stage, or **Undo last change** to restore the previous phase and its selection date.

The partner view refreshes when opened, brought to the foreground, manually refreshed, or every minute while visible. A push message also refreshes an open view. Status never advances automatically.

The four interface stages are menstrual, follicular, ovulatory, and luteal. Menstruation is biologically part of the follicular phase; it is displayed separately for simplicity. These are manually selected labels, not detected or predicted biological states. The app is for shared awareness, not contraception or medical decisions. It makes no claims about mood, energy, or fertility. See [NHS: the menstrual cycle](https://www.nhs.uk/conditions/periods/fertility-in-the-menstrual-cycle/).

## Deploy to Vercel

Use a **separate Vercel project and separate Upstash database** from your existing apps.

1. Import this GitHub repository into Vercel.
2. Select **Other** as the framework, repository root as Root Directory, and `public` as Output Directory. There is no build step. Node.js 24 is recommended.
3. Connect **Upstash for Redis** from Vercel Marketplace. Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` from its REST connection details. The server uses `@upstash/redis`; it does not use the older `@vercel/kv` package.
4. Run `npm ci`, then `npm run vapid` locally to generate a fresh VAPID key pair. Keep the private key out of GitHub, browser code, screenshots and logs.
5. Add the environment variables below in Vercel, then redeploy. For `APP_ORIGIN`, use your actual production URL (or custom domain), not this repository's GitHub URL. When changing domains, update this value and redeploy.

| Variable | Value |
| --- | --- |
| `APP_ORIGIN` | Exact origin, e.g. `https://know-her-cycle.vercel.app`, without a trailing slash |
| `UPSTASH_REDIS_REST_URL` | Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Redis REST write token, server only |
| `VAPID_PUBLIC_KEY` | Generated public VAPID key |
| `VAPID_PRIVATE_KEY` | Generated private VAPID key, server only |
| `VAPID_CONTACT` | Valid contact, e.g. `mailto:you@example.com` |

The public VAPID key is returned by `/api/config`, so no frontend edits are needed. You can use pairing and status updates without VAPID configured; the app will explain why notifications are unavailable. There are **no cron jobs**: a successful phase change sends notifications immediately from the backend.

Preview deployments require their own exact `APP_ORIGIN`. Give them a separate development database and VAPID keys rather than using production cycle records. Do not use this development server as public hosting.

### Phone setup

Install using **Add to Home Screen** on iPhone/iPad, then open the installed app before pairing or restoring access and enabling notifications. Web Push requires iOS/iPadOS 16.4 or later. On supported Android and desktop browsers, notifications are also opt-in. Each browser/install keeps its own credentials. If you set up in Safari before installing, use the saved access key in **Restore access** if the installed app does not share that session.

Notifications contain only “Cycle status updated”, without a phase name. Tapping one opens the current shared status. Delivery depends on the browser's push service, connectivity and device settings; it is not guaranteed. The API reports delivery failures without rolling back the saved status. It does not automatically retry transient push failures. Expired push endpoints are removed after 404/410 responses. Up to five partner devices can subscribe; switching off one device preserves the others.

### If a notification cannot be delivered

The phase is saved even when push delivery fails. The app now shows a safe diagnostic reason instead of only a generic failure.

- Open `/api/config` on your deployed origin. A `pushConfigurationError` identifies incomplete setup, malformed keys, or a public/private key mismatch. This endpoint never returns the private key.
- Use the public and private VAPID keys from the **same** generated pair. The server trims surrounding whitespace, accepts optional Base64 padding, and accepts either a bare contact email or its `mailto:` form.
- A provider response such as `403 BadJwtToken` points to push authentication. Check `VAPID_CONTACT`, the matching VAPID pair, and redeploy after correcting environment variables.
- A subscription is bound to the public VAPID key used when it was created. If that key changes, reopen the partner app; it will remove the stale subscription and ask to enable notifications again. Do not generate fresh keys on every deployment.
- For expired subscriptions (404/410), turn notifications off and on again on the partner device. For temporary network/provider failures, retry later.
- Vercel function logs include only status codes and a small allowlist of provider reason names, never full push endpoints, authorization headers, subscription keys or private VAPID keys.

### First deployment smoke check

- On the tracking phone, create a cycle and save the private access key from settings.
- Create an invitation; open it on the partner phone and connect. Check that the partner cannot edit the phase.
- Enable notifications on the partner phone, close the app, and change the phase on the tracking phone. Check the notification and its tap behavior.
- Verify correction and undo, refresh on the partner phone, and recovery using the access key.
- Disconnect the partner and confirm their next refresh removes access. Check that subsequent changes no longer target their subscriptions.
- With the app previously opened, go offline and check that cached status is marked as stale and edits are disabled.

## Access, storage and privacy

- No email, password, personal names, symptoms, analytics or third-party frontend assets.
- Each credential has a random cycle identifier and a 256-bit secret. Redis stores SHA-256 hashes of access and invitation credentials; the browser stores its own raw access credential locally. An access key grants its role's permissions. Keep it private.
- The tracking person controls status, invitations, disconnection and deletion. The partner can view, manage notifications on their devices, or leave. The backend enforces permissions, not just the interface.
- Invitations travel in URL fragments, so their secrets are not sent in HTTP request URLs or Referer headers. The app removes the fragment before further interaction. Invite redemption exchanges the invitation for a separate viewer credential.
- Each cycle is isolated in `khc:cycle:<random-id>`. It stores the current phase/date, one previous phase/date for undo, credential hashes, one pending invitation, and partner push subscriptions. No cycle-history timeline is retained. Records remain until the owner deletes them; rate-limit counters expire automatically.
- Atomic Redis compare-and-swap operations prevent invitation reuse, stale writes and subscription changes overwriting each other. Phase versions prevent a double tap or an old device overwriting a newer update.
- Subscriptions are private to the linked viewer and that cycle. Disconnecting clears their credential, all subscriptions and any pending invite. A push already handed to a push service cannot be recalled.
- Same-origin APIs, validation, request limits, method checks, content security policy, and push-host restrictions are included. Raw IP addresses are not stored by app code; temporary rate-limit keys use hashes. Hosting/provider infrastructure may have its own logs and backups.
- The offline cache stores only the app shell. The browser separately retains the last synced state, visibly marked stale when sync fails. API responses use `no-store`, are never service-worker cached, and offline edits are disabled.

### Recovery and removal

**Save the private access key from settings** in a password manager or another private place. Paste it into **Restore access** on a new install/device. Anyone with the owner key can control the cycle. Viewer devices restored using the same viewer key share membership; when one leaves, all those viewer devices lose access.

**Forget this device** removes its local credential and last synced status; for a connected partner, it also removes that device's push subscription. It does not delete the cycle or revoke copies of its access key. **Delete cycle** removes the live Redis record and all active credentials/subscriptions. It cannot erase copies of data already viewed or a provider's backups. If the owner loses every key and logged-in device, there is no email recovery or admin backdoor: create a new cycle.

## Development and checks

```sh
npm ci
npm run check
npm test
npm run dev
```

Open `http://localhost:3000`. Without Redis environment variables the development server uses **in-memory storage**, which resets on restart. Production never falls back to this store. To use real environment variables locally, copy `.env.example` to `.env` and use `node --env-file=.env scripts/dev.mjs`. Never commit `.env`.

Tests cover permission boundaries, one-use and concurrent invitations, expiry, cycle isolation, conflicting updates, undo, disconnection, deletion, push failures and cleanup, request validation, and a two-device DOM interaction flow. No live Redis or push service is needed. Real Redis connectivity, Vercel routing and phone push delivery require the deployment smoke check above. DOM interaction checks do not replace a rendered browser/device check.

## Structure

```text
public/             Buildless HTML/CSS/JS, manifest, service worker and icons
api/[action].js     Vercel API entry point (/api/create, /api/state, etc.)
server/domain.js    Permissions, pairing, phase updates and subscriptions
server/store.js     Upstash storage with atomic compare-and-swap
server/push.js      Web Push sender
server/http.js      API validation and rate limiting
scripts/            Local server and static checks
tests/              Domain, API and DOM integration tests
```

To deploy under a subfolder on GitHub Pages instead, paths, service-worker scope, API origin, CORS and CSP would need adapting. This version intentionally hosts both frontend and backend together on Vercel, following the ADHD Partner app's deployment pattern and the Love app's hardened notification flow.
