# Deployment and maintenance

[Back to the app overview](../README.md)

This guide covers hosting your own instance, configuring notifications and scheduling, and maintaining access and stored data.

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
| `CRON_SECRET` | Random secret of at least 24 characters, server only; required for automatic switching |

The public VAPID key is returned by `/api/config`, so no frontend edits are needed. You can use pairing and status updates without VAPID configured; the app will explain why notifications are unavailable. Manual phase changes send notifications immediately from the backend.

For scheduling, add `CRON_SECRET` to the production environment and redeploy. Generate a value locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`; keep it private. The daily `/api/cron` job in `vercel.json` runs at **07:00 UTC**. On Vercel Hobby it can run within the following hour: roughly 08:00–10:00 in Denmark depending on daylight saving. It does not switch at midnight or promise an exact delivery time. Vercel adds `Authorization: Bearer <CRON_SECRET>` to scheduled requests. Cron jobs run on production deployments; scheduling cannot be fully tested on a preview deployment. A 60-second function limit is configured for these small daily batches. For larger installations, use a queue with resumable processing before relying on this as a large-scale scheduler.

Preview deployments require their own exact `APP_ORIGIN`. Give them a separate development database and VAPID keys rather than using production cycle records. Do not use this development server as public hosting.

### Phone setup

Install using **Add to Home Screen** on iPhone/iPad, then open the installed app before pairing or restoring access and enabling notifications. Web Push requires iOS/iPadOS 16.4 or later. On supported Android and desktop browsers, notifications are also opt-in. Each browser/install keeps its own credentials. If you set up in Safari before installing, use the saved access key in **Restore access** if the installed app does not share that session.

Notifications use the title “Cycle updated” and the body “Open the app to see the latest phase.”, without a phase name. Owner reminders use “Cycle reminder” / “Your next phase is scheduled for tomorrow.” Tapping either opens the current shared status. Delivery depends on the browser's push service, connectivity and device settings; it is not guaranteed. The API reports delivery failures without rolling back the saved status. It does not automatically retry transient push failures. Expired push endpoints are removed after 404/410 responses. Up to five devices per role can subscribe; switching off one device preserves the others.

### If a notification cannot be delivered

The phase is saved even when push delivery fails. The app now shows a safe diagnostic reason instead of only a generic failure.

- Open `/api/config` on your deployed origin. A `pushConfigurationError` identifies incomplete setup, malformed keys, or a public/private key mismatch. This endpoint never returns the private key.
- Use the public and private VAPID keys from the **same** generated pair. The server trims surrounding whitespace, accepts optional Base64 padding, and accepts either a bare contact email or its `mailto:` form.
- A provider response such as `403 BadJwtToken` points to push authentication. Check `VAPID_CONTACT`, the matching VAPID pair, and redeploy after correcting environment variables.
- A subscription is bound to the public VAPID key used when it was created. If that key changes, reopen the partner app; it will remove the stale subscription and ask to enable notifications again. Do not generate fresh keys on every deployment.
- For expired subscriptions (404/410), turn notifications off and on again on the partner device. For temporary network/provider failures, retry later.
- Vercel function logs include only status codes and a small allowlist of provider reason names, never full push endpoints, authorization headers, subscription keys or private VAPID keys.

### Test reminders and retained diagnostics

In **Settings → Notifications**, either the owner or the currently linked partner can send a test reminder to the tracking person's existing owner subscriptions. The partner button reads **Send her a test reminder**; it does not use the partner's own push subscription. All enabled owner devices receive it, without revealing their endpoints. No access key sharing or schedule editing is needed. Tests have distinct fixed text and are limited to three per cycle every ten minutes.

Open **Notification history · last 7 days** to see daily job start/completion markers, checks for this cycle, whether a reminder was due, whether reminders were enabled, subscription counts, and push acceptance/failure results. Tests appear in the same history. Acceptance means the push service accepted the request, not confirmation that a phone displayed it. If no owner subscription exists, enable notifications in the installed app on the tracking phone first.

History starts after this version is deployed; it cannot recover earlier events. If a job never starts, there will be no start marker. If storage is unavailable, the app cannot persist diagnostics either, so absence of a record does not establish why a job is missing. Diagnostic write failures are logged safely and do not block scheduling or push attempts. Processing failures produce a failure marker when storage remains available. There are no automatic retries added by these diagnostics.

Redis keys `khc:diagnostics:<cycle-id>` and `khc:diagnostics:cron` retain at most 200 entries each. Writes expire keys after seven days, and writes/reads remove entries more than seven days old. Per-cycle entries contain timestamps, event types, counts, status flags, and safe provider error summaries; no phase names, raw access keys, push endpoints or subscription keys. Only authenticated cycle members can read that cycle's history. The shared daily-job history exposes timestamps and job status, without other cycles' data or counts. Deleting a cycle removes its diagnostic history atomically; shared job markers contain no cycle identifiers.

### First deployment smoke check

- On the tracking phone, create a cycle and save the private access key from settings.
- Create an invitation; open it on the partner phone and connect. Check that the partner cannot edit the phase.
- Enable notifications on the partner phone, close the app, and change the phase on the tracking phone. Check the notification and its tap behavior.
- Verify correction and undo, refresh on the partner phone, and recovery using the access key.
- Disconnect the partner and confirm their next refresh removes access. Check that subsequent changes no longer target their subscriptions.
- Enable automatic phases with a current start date and verify the next date. Save a manual correction and confirm it restarts the schedule from today. Enable owner reminders on the installed tracking app.
- In production, check the scheduled job in Vercel and verify a day-before reminder and the following phase change on both phones. Check that repeated runs do not resend the reminder. Keep the cron secret out of screenshots and logs.
- From the linked partner settings, send a test reminder. Confirm it appears on the tracking phone, uses the test text, and leaves the schedule unchanged. Inspect history from both views.
- With the app previously opened, go offline and check that cached status is marked as stale and edits are disabled.

## Storage, access and privacy

- No email, password, personal names, symptoms, analytics or third-party frontend assets.
- Each credential has a random cycle identifier and a 256-bit secret. Redis stores SHA-256 hashes of access and invitation credentials; the browser stores its own raw access credential locally. An access key grants its role's permissions. Keep it private.
- The tracking person controls status, invitations, disconnection and deletion. The partner can view, manage notifications on their devices, send a test reminder to owner devices, inspect notification history, or leave. The backend enforces permissions, not just the interface.
- Invitations travel in URL fragments, so their secrets are not sent in HTTP request URLs or Referer headers. The app removes the fragment before further interaction. Invite redemption exchanges the invitation for a separate viewer credential.
- Each cycle is isolated in `khc:cycle:<random-id>`. It stores the current phase/date, one previous phase/date for undo, credential hashes, one pending invitation, partner and owner push subscriptions, and optional schedule settings (durations, time zone, phase start date, last reminder claim). No cycle-history timeline is retained. Records remain until the owner deletes them; rate-limit counters expire automatically. The `khc:scheduled` Redis set contains only cycle IDs with automatic switching enabled; saving or deleting a record updates this index atomically. The `khc:limit:*` keys remain temporary request-rate counters.
- Atomic Redis compare-and-swap operations prevent invitation reuse, stale writes and subscription changes overwriting each other. Phase versions prevent a double tap or an old device overwriting a newer update.
- Subscriptions are private to their role and cycle. Disconnecting clears the viewer credential, viewer subscriptions and any pending invite; owner reminder subscriptions remain. A push already handed to a push service cannot be recalled.
- Same-origin APIs, validation, request limits, method checks, content security policy, and push-host restrictions are included. Raw IP addresses are not stored by app code; temporary rate-limit keys use hashes. Hosting/provider infrastructure may have its own logs and backups.
- The offline cache stores only the app shell. The browser separately retains the last synced state, visibly marked stale when sync fails. API responses use `no-store`, are never service-worker cached, and offline edits are disabled.

### Recovery and removal

**Save the private access key from settings** in a password manager or another private place. Paste it into **Restore access** on a new install/device. Anyone with the owner key can control the cycle. Viewer devices restored using the same viewer key share membership; when one leaves, all those viewer devices lose access.

**Forget this device** removes its local credential and last synced status; it also removes that device's push subscription for either role. It does not delete the cycle or revoke copies of its access key. **Delete cycle** removes the live Redis record and all active credentials/subscriptions. It cannot erase copies of data already viewed or a provider's backups. If the owner loses every key and logged-in device, there is no email recovery or admin backdoor: create a new cycle.

## Development and checks

```sh
npm ci
npm run check
npm test
npm run dev
```

Open `http://localhost:3000`. Without Redis environment variables the development server uses **in-memory storage**, which resets on restart. Production never falls back to this store. To use real environment variables locally, copy `.env.example` to `.env` and use `node --env-file=.env scripts/dev.mjs`. Never commit `.env`.

Tests cover permission boundaries, one-use and concurrent invitations, expiry, cycle isolation, conflicting updates, undo, disconnection, deletion, push failures and cleanup, request validation, calendar scheduling, time zones/DST, catch-up, reminder deduplication, cron authorization, and DOM interaction flows for two-device sharing and owner scheduling. No live Redis or push service is needed. Real Redis connectivity, Vercel routing and phone push delivery require the deployment smoke check above. DOM interaction checks do not replace a rendered browser/device check.

## Structure

```text
public/             Buildless HTML/CSS/JS, manifest, service worker and icons
api/[action].js     Vercel API entry point (/api/create, /api/state, etc.)
server/domain.js    Permissions, pairing, phase updates and subscriptions
server/store.js     Upstash storage with atomic compare-and-swap
server/push.js      Web Push sender
server/schedule.js  Calendar-day scheduling and validation
server/cron.js      Authenticated daily processing
server/diagnostics.js Seven-day diagnostic retention and safe writes
server/http.js      API validation and rate limiting
scripts/            Local server and static checks
tests/              Domain, API and DOM integration tests
```

## Other hosting

To deploy under a subfolder on GitHub Pages instead, paths, service-worker scope, API origin, CORS and CSP would need adapting. This version intentionally hosts both frontend and backend together on Vercel, following the ADHD Partner app's deployment pattern and the Love app's hardened notification flow.

## Scheduling behavior

In **Settings → Automatic phases**, enter the number of days in each phase (1–90), when the current phase started, and your IANA time zone (for example, `Europe/Copenhagen`). Enable switching and save. There are no preset phase durations. Calendar days are counted in the chosen time zone: five days starting October 19 means the next phase is scheduled for October 24.

- The server checks schedules once daily, even when both apps are closed. Automatically selected phases show **Estimated from**; the next scheduled date is shown beside the selection date.
- A manual phase change becomes the new starting point **today**, preserving the four saved durations. In automatic mode, Undo also starts the restored phase from today. In manual mode, Undo retains its original behavior of restoring the earlier date.
- **Send day-before reminders** enables owner reminders. Save first, then tap **Allow notifications on this phone**. Owner reminders and partner change notifications have separate subscriptions; up to five devices per role can subscribe.
- Unchecking automatic switching and saving pauses it, retaining durations for later. Re-enabling uses the date you enter and catches up immediately if that phase would already have ended.
- A missed daily run catches up to the current estimated phase on the next run, sending one current-status notification rather than a backlog. Expired reminders are skipped. Attempts are claimed before sending, so overlapping jobs do not duplicate reminders. Failed notifications are best effort and are not retried automatically.

Existing cycles remain manual until their owner enables switching. No data migration is required.

