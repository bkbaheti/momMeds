# Eye Meds Tracker — Technical Spec

**Handover to Claude Code CLI**

---

## 1. Purpose

Mobile web PWA to track post-cataract surgery left-eye medications for a single patient (Mrs. Shobha Baheti, MRN P1900928, LVPEI Hyderabad, surgery date 2026-04-19). Used by mom and family caretakers. No authentication. Data synced across iOS and Android devices via a Google Sheet. Push notifications for due / late / overdue doses.

---

## 2. Stack

- **Frontend:** vanilla HTML/CSS/JS, single `index.html`, no build step. Hosted on GitHub Pages.
- **Backend:** Google Apps Script deployed as Web App, backed by a Google Sheet.
- **Push notifications:** OneSignal free tier (Web Push SDK; supports iOS 16.4+ PWA and Android Chrome PWA/browser). Chosen because OneSignal handles VAPID signing and subscription management — Apps Script just calls their REST API.
- **Offline:** localStorage cache + pending-writes queue.
- **PWA:** manifest.json + service worker (OneSignal provides one, we register an additional minimal SW for offline caching).

---

## 3. Medication schedule

All drops to **left eye** unless noted. Treatment start: **2026-04-19**.

| Drug | Route | Frequency | Duration |
|---|---|---|---|
| Ocupol (Polymyxin B + Chloramphenicol) | L eye drops | 4×/day | 7 days (ends 2026-04-26) |
| Amplinak (Nepafenac 0.1%) | L eye drops | 3×/day | Till next visit (open-ended until user marks inactive) |
| Pred Forte (Prednisolone acetate 1%) | L eye drops | Tapering (see below) | 6 weeks |
| Dolo 650 (Paracetamol) | Oral | PRN | Till next visit |

**Pred Forte taper** (auto-derive current week from `today - startDate`):

| Week | Dates (inclusive) | Doses/day |
|---|---|---|
| 1 | 2026-04-19 → 2026-04-25 | 6 |
| 2 | 2026-04-26 → 2026-05-02 | 5 |
| 3 | 2026-05-03 → 2026-05-09 | 4 |
| 4 | 2026-05-10 → 2026-05-16 | 3 |
| 5 | 2026-05-17 → 2026-05-23 | 2 |
| 6 | 2026-05-24 → 2026-05-30 | 1 |

**Shake-well + self-medication warning** (from prescription) — surface as info text on the Pred Forte dose card.

---

## 4. Settings

Stored in Sheet (Settings tab). All editable via UI except `resetPassword` which is hardcoded in `config.js`.

| Key | Default | Description |
|---|---|---|
| `wakeTime` | `07:00` | Start of active window |
| `bedTime` | `22:00` | End of active window |
| `startDate` | `2026-04-19` | Treatment start |
| `minGapMinutes` | `10` | Spacing between different drops at same slot |
| `graceMinutes` | `20` | After scheduled → mark "late" |
| `missMinutes` | `90` | After scheduled → mark "missed", skip slot |
| `amplinakActive` | `true` | Toggle off after next visit review |
| `deviceLabel` | device-specific | e.g. "Mom's iPhone" — stored in localStorage, synced to Subscriptions tab |

Hardcoded in `config.js`:
- `RESET_PASSWORD` (user-chosen, e.g. `"shobha2026"`)

---

## 5. Schedule computation

**Deterministic function — implemented identically in frontend JS and Apps Script backend.**

```
function computeSchedule(date, settings):
  activeMin = diffMinutes(settings.bedTime, settings.wakeTime)
  slots = []
  for drug in activeDrugs(date, settings):
    N = frequencyForDate(drug, date, settings.startDate)
    if N == 0: continue
    if N == 1:
      times = [settings.wakeTime]
    else:
      interval = activeMin / (N - 1)
      times = [settings.wakeTime + i * interval for i in 0..N-1]
    for t in times:
      slots.push({ drug, eye: "L", scheduledAt: combine(date, t) })
  
  // Stagger same-slot conflicts: priority Ocupol → Amplinak → Pred Forte
  slots.sortBy(scheduledAt, drugPriority)
  for i in 1..slots.length-1:
    if slots[i].scheduledAt - slots[i-1].scheduledAt < minGapMinutes:
      slots[i].scheduledAt = slots[i-1].scheduledAt + minGapMinutes
  
  return slots
```

Drug priority: `ocupol (1) → amplinak (2) → pred_forte (3)` (antibiotic first, steroid last — standard ophthalmology practice).

Dolo 650 is **not** in the schedule — PRN only, logged ad-hoc.

---

## 6. Data model (Google Sheet)

**Four tabs.** All rows appended by Apps Script; never hand-edit except to debug.

### Tab: `Logs`
| Column | Type | Notes |
|---|---|---|
| id | string (UUID) | primary key |
| drug | string | `ocupol` / `amplinak` / `pred_forte` / `dolo` |
| eye | string | `L` / `oral` |
| scheduledAt | ISO datetime | null for Dolo |
| actualAt | ISO datetime | when dose was given |
| loggedAt | ISO datetime | when entry was created (differs from actualAt for backdated entries) |
| manualEntry | bool | true if backdated |
| caretaker | string | optional, free text |
| status | string | `taken` / `missed` / `skipped` |

### Tab: `Settings`
Two columns: `key`, `value`. Upsert-style.

### Tab: `Subscriptions`
| Column | Type |
|---|---|
| subscriptionId | OneSignal player ID |
| deviceLabel | e.g. "Mom's iPhone" |
| addedAt | ISO datetime |
| active | bool |

### Tab: `Notifications`
Tracks which reminders have been sent to avoid duplicates.

| Column | Type |
|---|---|
| slotKey | `YYYY-MM-DD\|drug\|HH:mm` |
| level | `T-10` / `T0` / `T+late` / `T+escalate` |
| sentAt | ISO datetime |

---

## 7. Apps Script API

Deployed Web App URL handles all endpoints via query param `action`. Both `doGet` and `doPost` route to a dispatcher.

| Action | Method | Body / Params | Returns |
|---|---|---|---|
| `state` | GET | — | `{ settings, logs: last30Days, subscriptions, serverTime }` |
| `log` | POST | `{ drug, eye, actualAt, scheduledAt?, manualEntry, caretaker? }` | new log entry |
| `editLog` | POST | `{ id, actualAt }` | updated entry |
| `deleteLog` | POST | `{ id }` | `{ ok: true }` |
| `settings` | POST | `{ key, value }` | updated settings |
| `reset` | POST | `{ password }` | clears Logs + Notifications if match |
| `subscribe` | POST | `{ subscriptionId, deviceLabel }` | `{ ok: true }` |
| `unsubscribe` | POST | `{ subscriptionId }` | `{ ok: true }` |

Response envelope: `{ ok: bool, data?: any, error?: string }`.

**CORS:** return `Access-Control-Allow-Origin: *` on all responses. Family use — acceptable.

**Secrets:** OneSignal REST key and `resetPassword` (server-side copy, cross-checked with client) stored in Script Properties, never in code.

---

## 8. Apps Script cron (time-based trigger, every 5 min)

Function name: `cronCheck`. Runs the notification state machine.

```
function cronCheck():
  now = new Date()
  settings = readSettings()
  if inQuietHours(now, settings): return
  
  todaySchedule = computeSchedule(today, settings)
  todayLogs = readTodayLogs()
  sent = readTodayNotifications()  // Map<slotKey, Set<level>>
  
  for slot in todaySchedule:
    slotKey = `${today}|${slot.drug}|${formatTime(slot.scheduledAt)}`
    logged = todayLogs.find(l => l.drug == slot.drug 
                            && abs(l.actualAt - slot.scheduledAt) < 2h
                            && l.status == 'taken')
    if logged: continue
    
    delta = (now - slot.scheduledAt) / 60000  // minutes
    
    level = null
    if delta >= -10 and delta < 0 and !sent[slotKey].has('T-10'): level = 'T-10'
    else if delta >= 0 and delta < graceMin and !sent[slotKey].has('T0'): level = 'T0'
    else if delta >= graceMin and delta < 60 and !sent[slotKey].has('T+late'): level = 'T+late'
    else if delta >= 60 and delta < missMin and !sent[slotKey].has('T+escalate'): level = 'T+escalate'
    else if delta >= missMin:
      if !existingMissedLog(slot): insertMissedLog(slot)
      continue
    
    if level:
      sendPush(slot, level)
      recordNotification(slotKey, level)
```

**Grouping rule:** if two slots are within `minGapMinutes` of each other AND both would fire the same level AND neither has been sent yet, merge into a single grouped push.

**Missed dose handling:** when `delta >= missMinutes`, insert a `status: missed` log and **do not** send a catch-up notification. For Pred Forte tapering, a catch-up dose is medically inappropriate — next reminder is the next scheduled slot.

---

## 9. Notification copy

- **T-10:** `🔔 Pred Forte due in 10 min (10:00 AM) — left eye`
- **T0:** `💧 Pred Forte due now — left eye. Tap to log.`
- **T+late:** `⏰ Pred Forte is 25 min late — please administer`
- **T+escalate:** `🚨 Pred Forte overdue 1h — please check on Mom` (goes to ALL active subscribers, not just the logger)
- **Grouped:** `💧 Due now: Ocupol, then Pred Forte in 10 min (left eye)`

All notifications deep-link to home screen of PWA (OneSignal `url` field = PWA root).

**Quiet hours:** no notifications sent if `now` is between `bedTime` and `wakeTime` (wrap-around aware).

---

## 10. OneSignal integration

**Setup (one-time):**
1. Create OneSignal app → Web Push platform → get `APP_ID` + `REST_API_KEY`
2. In OneSignal dashboard, set site URL to the GitHub Pages URL
3. Download OneSignal SDK files (or use their CDN script)
4. Add `APP_ID` to `config.js`
5. Add `REST_API_KEY` to Apps Script → Project Settings → Script Properties as `ONESIGNAL_REST_KEY`

**Frontend:**
- Init OneSignal SDK on page load
- On Settings → "Enable push notifications" toggle: call `OneSignal.Notifications.requestPermission()`, then `OneSignal.User.PushSubscription.id` to get the subscription ID
- POST to `?action=subscribe` with `{ subscriptionId, deviceLabel }`

**Backend (send):**
```
function sendPush(slot, level):
  subs = readActiveSubscriptions()
  if level == 'T+escalate': targets = subs.map(s => s.subscriptionId)
  else: targets = subs.map(s => s.subscriptionId)  // still all — family model
  
  payload = {
    app_id: PROPERTIES.ONESIGNAL_APP_ID,
    include_subscription_ids: targets,
    headings: { en: title },
    contents: { en: body },
    url: SITE_URL,
    priority: level == 'T+escalate' ? 10 : 5
  }
  UrlFetchApp.fetch('https://onesignal.com/api/v1/notifications', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Basic ' + PROPERTIES.ONESIGNAL_REST_KEY },
    payload: JSON.stringify(payload)
  })
```

**iOS 16.4+ gotcha:** push only fires when app is installed as PWA (home screen). Handle gracefully — if SDK detects non-PWA iOS Safari, show a banner: *"Install to home screen to enable reminders"* with an arrow to the Install section in Settings.

---

## 11. Frontend screens (bottom tab nav: Home / History / Settings)

### 11.1 Home

**Next dose card** (hero, top):
- Drug name (large), eye indicator, scheduled time
- Countdown: `"in 14 min"` / `"due now"` / `"5 min late"` / `"1h 20m overdue"`
- Background color: green (>10min away), yellow (due now ±20min), red (>20min late)
- Primary CTA: **"✓ Taken now"** — logs with `actualAt = now`, `scheduledAt = slot`
- Secondary CTA: **"⏰ Log past dose"** — opens modal

**Today's timeline** (scrollable):
- Every slot as a row: time · drug · eye · status icon
  - `☐` upcoming / `✓` taken / `⚠` late / `✗` missed
- Tap a taken row → edit/delete modal
- Tap an upcoming row → quick-log button

**Dolo PRN button** (footer):
- "Log Dolo 650" → records `actualAt = now`, `scheduledAt = null`

### 11.2 Log past dose modal
- Drug dropdown (pre-selected to next missed/late slot if any)
- Eye auto-filled from drug
- Date picker (defaults to today, allows yesterday+)
- Time picker (defaults to now, scrollable back)
- Optional caretaker name field (remembered per device in localStorage)
- Save → POST `?action=log` with `manualEntry: true`

### 11.3 History
- Date range selector: "Last 7 days" (default) / "Last 30 days" / "All"
- Per-drug compliance card:
  - Doses taken / scheduled (e.g. `28/30`)
  - On-time % (color-coded: green <30min avg dev / yellow / red)
  - Avg deviation (minutes)
- Daily bar chart (pure CSS, one bar per day, stacked or side-by-side by drug)
- "Export CSV" → generates CSV from logs, triggers `<a download>`

### 11.4 Settings

**Schedule section:**
- Wake time (time picker)
- Bed time (time picker)
- Treatment start date (date picker — warn before changing: "this will recompute all future schedules")
- Min gap (number, minutes)
- Grace period (number, minutes)
- Miss cutoff (number, minutes)
- Amplinak active toggle

**Notifications section:**
- "Enable push notifications" toggle
- Device label (text input — default "My iPhone" / "My Android" based on UA)
- Subscribed devices list (from Subscriptions tab): each row with label + last-seen + "Remove" button

**Install as app section:** (collapsible, see §12)

**Danger zone** (bottom, red-bordered card):
- "Reset all data" button → modal 1 (password) → modal 2 (type `DELETE`) → call `?action=reset`
- Show last-reset timestamp if any

---

## 12. PWA install instructions (device-detected, tucked in Settings)

Collapsible section: **"📱 Install as app for reminders"**. Default collapsed. Auto-expand on first visit if not yet installed (detect via `display-mode: standalone` media query).

Detect via `navigator.userAgent`:

**iOS (iPhone / iPad on Safari):**
> 1. Tap the **Share** button (□↑) at the bottom of Safari
> 2. Scroll down and tap **"Add to Home Screen"**
> 3. Tap **"Add"** in the top right
> 4. Open the app from your home screen
> 5. When prompted, tap **"Allow"** for notifications
>
> ⚠️ Must be **Safari** (not Chrome or other browsers) on **iOS 16.4 or newer**. Check Settings → General → Software Update.

**Android (Chrome):**
> 1. Tap the **⋮** menu (top right)
> 2. Tap **"Install app"** or **"Add to Home screen"**
> 3. Tap **"Install"**
> 4. Open from home screen and allow notifications when prompted

**Desktop (for testing):**
> Click the install icon in the address bar, or ⋮ → Install.

Show only the block matching detected device. Include a link: *"I'm using a different device"* that reveals all three.

---

## 13. Reset flow

1. Settings → Danger zone → tap "Reset all data"
2. **Modal 1:** "Enter password to continue" → password input (type=password) → Cancel / Continue
   - Client-side check against `config.js` `RESET_PASSWORD`
   - Wrong: shake animation + error "Incorrect password"
3. **Modal 2:** "Type DELETE to confirm. This will erase all logs." → text input → Cancel / Confirm (disabled until input === "DELETE")
4. On confirm: POST `?action=reset` with `{ password }` — server re-validates against Script Properties copy
5. Success: toast "All data cleared", reload state, UI shows empty timeline

---

## 14. Offline handling

- **On load:** GET `?action=state` → cache in `localStorage["eyedrops-cache-v1"]` as `{ state, cachedAt }`
- **On fetch fail:** use cache, show yellow banner: `⚠ Offline — showing last synced data (cached 12 min ago)`
- **Writes:** optimistic UI update + cache mutation, then POST
  - If POST fails: push to `localStorage["eyedrops-queue-v1"]`, show pill `⟳ 2 pending`
  - On `online` event OR next successful state fetch: flush queue in order
- **Conflict policy:** last-write-wins. For family-scale, sufficient.
- **Sync indicator:** top-right corner
  - `✓ Synced` (green, fades after 2s)
  - `⟳ Syncing…` (spinner)
  - `⚠ 2 pending` (yellow, tap to retry)

---

## 15. PWA manifest

`manifest.json`:
```json
{
  "name": "Mom's Eye Meds",
  "short_name": "EyeMeds",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#ffffff",
  "theme_color": "#1e40af",
  "icons": [
    { "src": "icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}
```

`<head>` additions for iOS:
```html
<link rel="apple-touch-icon" href="icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="EyeMeds">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
```

---

## 16. File structure

```
eye-meds-tracker/
├── index.html          # Main app: HTML + inline CSS + inline JS
├── manifest.json       # PWA manifest
├── sw.js               # Service worker (offline shell caching)
├── config.js           # { APPS_SCRIPT_URL, ONESIGNAL_APP_ID, RESET_PASSWORD }
├── icon-192.png        # App icon
├── icon-512.png        # App icon (maskable)
├── backend/
│   └── Code.gs         # Apps Script source
└── README.md           # Setup instructions
```

Keep `index.html` self-contained (CSS + JS inline) to minimize HTTP requests and ensure offline-friendly caching. Externalize only `config.js` so secrets stay out of the HTML template.

---

## 17. Setup steps (for README)

1. **Sheet**
   - Create a new Google Sheet named "Eye Meds Tracker"
   - Add tabs: `Logs`, `Settings`, `Subscriptions`, `Notifications` with the headers from §6
2. **Apps Script**
   - Extensions → Apps Script → paste `backend/Code.gs`
   - Project Settings → Script Properties → add: `ONESIGNAL_APP_ID`, `ONESIGNAL_REST_KEY`, `RESET_PASSWORD`
   - Deploy → New deployment → Type: Web app → Execute as: Me → Who has access: Anyone
   - Copy the `/exec` URL
   - Triggers → Add trigger → function: `cronCheck`, event source: time-driven, every 5 min
3. **OneSignal**
   - Sign up → new app → Web Push
   - Site URL: GitHub Pages URL (from step 5)
   - Copy App ID and REST API key
4. **Config**
   - Edit `config.js`:
     ```js
     window.CONFIG = {
       APPS_SCRIPT_URL: "https://script.google.com/macros/s/XXX/exec",
       ONESIGNAL_APP_ID: "abc-123",
       RESET_PASSWORD: "shobha2026"
     };
     ```
5. **Host**
   - Push repo to GitHub
   - Settings → Pages → deploy from branch → `main` / root
   - Note the Pages URL
6. **Icons**
   - Generate 192×192 and 512×512 PNGs (any eye / medical icon, e.g. use a flat design tool or emoji-to-png)
7. **Install on each phone**
   - Open Pages URL on phone
   - Follow in-app install instructions (Settings → Install as app)
   - Enable notifications when prompted
   - Set device label in Settings (e.g. "Mom's iPhone")

---

## 18. Acceptance criteria

- [ ] Opens on mobile within 1s from cache
- [ ] Dose logging updates UI immediately; syncs to Sheet within 3s online
- [ ] Backdated entry supports picking past date + time
- [ ] Edit / delete log requires confirm; persists to Sheet
- [ ] Pred Forte taper shows correct frequency for each week (verify across week boundaries)
- [ ] Same-slot drug conflict staggers by `minGapMinutes` in correct priority order
- [ ] Settings changes propagate to all devices after refresh
- [ ] Reset flow: wrong password blocks, correct password + DELETE clears Logs + Notifications tabs only
- [ ] Offline: app opens from cache, writes queue, flush on reconnect
- [ ] PWA installs on iOS Safari 16.4+ and Android Chrome
- [ ] Push notifications arrive at T-10, T0, T+20 (late), T+60 (escalate)
- [ ] Quiet hours suppress notifications between bedTime and wakeTime
- [ ] Missed doses insert `status: missed` log; no catch-up notification
- [ ] Grouped notification when two drugs due within `minGapMinutes`
- [ ] Today's timeline reconciles scheduled slots with logged doses correctly
- [ ] Install instructions auto-detect device and show correct block
- [ ] CSV export contains all log fields

---

## 19. Non-goals (explicitly out of scope)

- Multi-patient support
- Medication inventory / refill tracking
- EMR / FHIR integration
- Calendar export (ICS)
- SMS / WhatsApp / Telegram fallback channels
- Apple Health / Google Fit integration
- End-to-end encryption (family use, plain-text Sheet is acceptable)
- Server-side auth / access control
- Internationalization (English only)

---

## 20. Open items (verify before build)

- Confirm `RESET_PASSWORD` string — spec uses placeholder `shobha2026`
- Confirm device labels for initial subscribers (e.g. "Mom's iPhone", "Braj's Pixel")
- Confirm whether Amplinak should default-disable on a specific date (post next-visit 2026-04-23) or stay active until user toggles
- Icon asset — provide or generate?
