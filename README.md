# Know Her Cycle

Four colors. One shared status. A little more understanding.

Know Her Cycle is a simple progressive web app for keeping a partner in the loop about your current cycle phase. Choose a phase with a tap, or let an optional schedule advance it using your own timings.

[Open the app](https://know-her-cycle.vercel.app/)

## How it works

The person tracking their cycle chooses the current phase and can invite a partner using a private, single-use link. The partner gets a view of the shared status and can opt into notifications when it changes.

The interface has four phases, each with its own color: **Menstrual 😭**, **Follicular 🤗**, **Ovulating 😽**, and **Luteal 🤬**. The tracking person controls phase changes, sharing, and deletion; the partner can view the status or leave the shared cycle.

There are no email accounts or passwords. Each device keeps a private access key, which can also restore access on another phone.

## Your timing, your choice

**Manual by default.** Phases change when you press the button. You can move to the next phase, choose a different one, or undo the last change.

**Optional automatic switching.** Set the duration of each phase, the current phase's start date, and your time zone in Settings. The app checks the schedule daily, shows the next switch date, and marks automatically selected phases as estimates. A manual change starts that phase's timing from today while keeping your saved durations. You can pause scheduling at any time.

**Optional reminders.** The tracking person can receive a notification the day before a scheduled change. The partner can receive notifications when the shared phase changes. Notifications use discreet text without the phase name, and each device opts in separately.

## On your phone

Add the app to your Home Screen for an app-like experience. On iPhone and iPad, open the installed app before enabling notifications.

Save your **private access key** from Settings somewhere safe. It is your way back in if you change phones or clear browser data.

The last synced status remains available offline. Changes require a connection, and the app indicates when the displayed status may be out of date.

## Privacy and limitations

The app stores the selected phase and date, one previous selection for undo, access-key hashes, sharing details, notification subscriptions, and any schedule you enable. It does not collect personal names, symptoms, or analytics, and it does not keep a cycle-history timeline.

The tracking person can disconnect their partner or delete the cycle. Anyone with a private access key can use that key's permissions, so keep it private. Hosting and push providers may retain their own logs or backups.

Scheduled phases are calendar-based estimates, not measurements of what is happening in the body. The app is for shared awareness, not contraception or medical decisions. Menstruation is shown separately for simplicity, although it is part of the follicular phase. Everyone experiences their cycle differently; the selected phase and emoji do not define how someone feels.

## Development

Built with plain HTML, CSS, and JavaScript, a service worker, Vercel serverless functions, Upstash Redis, and Web Push.

```sh
npm ci
npm run check
npm test
npm run dev
```

See the [deployment and maintenance guide](docs/deployment.md) for local configuration, Vercel setup, environment variables, notification troubleshooting, scheduling details, and storage behavior.
