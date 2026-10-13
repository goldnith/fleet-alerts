# Alert Sender — one-time setup (about 20 minutes, free)

This makes overdue / due-back alerts reach phones **even when the app is closed.**
A small script runs on GitHub every few minutes, checks your bookings, and pushes a
notification to every phone or PC that has switched notifications on.

You need: your Firebase project, a free GitHub account, and the hosted app link.

---

## Step 0 — Put the app on an https link (phones require this)
Phones will not show notifications for a file opened from storage or an http address.
1. Unzip `FleetConsole_PWA.zip`.
2. Go to https://app.netlify.com/drop and drag the unzipped folder onto the page.
3. You get a link like `https://something.netlify.app` — that is your app. Open it on your phone.
   * **iPhone / iPad (iOS 16.4 or newer):** in Safari tap Share ▸ **Add to Home Screen**, then open
     the app from that new icon. iPhones only allow notifications for apps added this way.
   * **Android:** open the link in Chrome (or choose "Install app").

## Step 1 — Create the push keys
1. Double-click `Generate_Push_Keys.html` (it opens in your browser).
2. Click **Create keys**. The public half is saved to your database automatically.
3. Click **Copy private key** and keep it handy for Step 4. It is shown only once.

## Step 2 — Get a Firebase service account file
Firebase console ▸ your project ▸ ⚙ **Project settings** ▸ **Service accounts** ▸
**Generate new private key**. A `.json` file downloads. Keep it private.

## Step 3 — Create the GitHub repository
1. github.com ▸ **New repository** ▸ name it `fleet-alerts` ▸ choose **Public** ▸ Create.
   (Public is fine: there are no secrets in the files, and it keeps GitHub Actions free.)
2. Click **uploading an existing file** and drag in everything from this folder
   (`notify.mjs`, `package.json`, `package-lock.json`, the `.github` folder, …) ▸ Commit.
3. If the `.github` folder did not upload (it is hidden on some computers):
   **Add file ▸ Create new file**, name it `.github/workflows/notify.yml`, paste the
   contents of `workflow/notify.yml`, and commit.

## Step 4 — Add the three secrets
Repo ▸ **Settings ▸ Secrets and variables ▸ Actions ▸ New repository secret**. Add:

| Name | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | open the `.json` file from Step 2 in Notepad, copy **everything**, paste |
| `VAPID_PRIVATE_KEY` | the private key from Step 1 |
| `VAPID_SUBJECT` | `mailto:` followed by your email, e.g. `mailto:you@gmail.com` |

## Step 5 — Run it once
Repo ▸ **Actions** tab ▸ (click the green button to enable workflows if asked) ▸
**Arrival alerts** ▸ **Run workflow**. After about a minute it should show a green tick.
If it shows a red cross, click it and read the message — it says which secret is missing.

## Step 6 — Turn notifications on, on every phone / PC
Open the app link ▸ tap the 🔔 bell ▸ **Enable notifications** ▸ Allow.
The screen then shows a checklist. All lines should be ticked, including
"Alerts when the app is closed" and "Alert sender — last ran N min ago".
Tap **Send test notification** to confirm the device can show alerts.

---

## What to expect
* **Who gets alerted:** bookings that are *Active* and not yet returned — once when a vehicle is
  due back within 12 hours, and once when it becomes overdue.
* **Timing:** GitHub's scheduler is "about every 5 minutes", but it can run several minutes late
  at busy times. Alerts can therefore arrive a few minutes after the moment itself.
* **Many at once:** if more than 4 new alerts appear in one run they are combined into one
  notification ("7 overdue · 2 due back soon") instead of buzzing 9 times.
* **Forgotten bookings:** a booking more than 72 hours overdue is treated as old data and is not
  pushed (close such bookings in the app so they stop showing as delayed).
* **GitHub pauses idle schedules:** if the repository has no activity for 60 days, GitHub pauses
  the schedule and emails you. Open the Actions tab and click **Enable workflow**.
  The app's notification screen warns you when the sender has not run recently.
* **Phones:** very aggressive battery-saver modes on some Android phones can delay notifications.
  If alerts are late, exclude the app/browser from battery optimisation.

## Optional settings
These have sensible defaults and normally need no change (edit in `notify.mjs` or add as
`env:` lines in the workflow): `SHOP_TZ_OFFSET` (default `+05:30`, India),
`MAX_OVERDUE_HOURS` (default 72), `MAX_INDIVIDUAL` (default 4).

## Checking the logic yourself
`npm install` then `npm test` runs the offline tests (no internet or keys needed).
