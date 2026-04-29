// ============================================================
// Eye Meds Tracker — Google Apps Script Backend
// Sheet ID: 1ffgPdEHv-urkjMj1Rq9P66GoLFM_PBhTcOdvCTqj9eI
// ============================================================

const BACKEND_VERSION = '1.2.0'; // Bump this on every Code.gs update
const SHEET_ID = '1ffgPdEHv-urkjMj1Rq9P66GoLFM_PBhTcOdvCTqj9eI';
const PROPS = PropertiesService.getScriptProperties();

// ---- Drug definitions ----
const DRUGS = {
  ocupol: { name: 'Ocupol', eye: 'L', priority: 1, route: 'drops' },
  amplinak: { name: 'Amplinak', eye: 'L', priority: 2, route: 'drops' },
  pred_forte: { name: 'Pred Forte', eye: 'L', priority: 3, route: 'drops' },
  dolo: { name: 'Dolo 650', eye: 'oral', priority: 99, route: 'oral' }
};

// Pred Forte taper: week number (1-based) → doses/day
// Reset to 5-week taper per LVPEI prescription dated 23-04-2026.
const PRED_TAPER = { 1: 5, 2: 4, 3: 3, 4: 2, 5: 1 };

// ---- Helpers ----

function getSheet(tabName) {
  return SpreadsheetApp.openById(SHEET_ID).getSheetByName(tabName);
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function ok(data) {
  return jsonResponse({ ok: true, data: data || null });
}

function err(msg) {
  return jsonResponse({ ok: false, error: msg });
}

function uuid() {
  return Utilities.getUuid();
}

function parseISO(s) {
  if (!s) return null;
  return new Date(s);
}

function toISO(d) {
  if (!d) return null;
  return d.toISOString();
}

function daysBetween(a, b) {
  const msPerDay = 86400000;
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.floor((utcB - utcA) / msPerDay);
}

function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function combineDateTimeMinutes(dateObj, totalMinutes) {
  const d = new Date(dateObj);
  d.setHours(Math.floor(totalMinutes / 60), totalMinutes % 60, 0, 0);
  return d;
}

function formatTimeHHMM(date) {
  return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}

function todayDate() {
  // Apps Script uses project timezone (Asia/Kolkata). new Date() is already IST.
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function nowIST() {
  // Apps Script project timezone is Asia/Kolkata — no manual offset needed
  return new Date();
}

// ---- Settings ----

function readSettings() {
  const sheet = getSheet('Settings');
  const data = sheet.getDataRange().getValues();
  const raw = {};
  for (let i = 1; i < data.length; i++) {
    if (data[i][0]) {
      let val = data[i][1];
      // Google Sheets auto-converts time strings to Date objects — convert back
      if (val instanceof Date) {
        const key = data[i][0];
        if (key === 'startDate' || key === 'predForteStartDate') {
          // Format as YYYY-MM-DD
          val = Utilities.formatDate(val, Session.getScriptTimeZone(), 'yyyy-MM-dd');
        } else if (key === 'wakeTime' || key === 'bedTime') {
          // Format as HH:mm
          val = Utilities.formatDate(val, Session.getScriptTimeZone(), 'HH:mm');
        }
      }
      raw[data[i][0]] = val;
    }
  }
  return {
    wakeTime: raw.wakeTime || '07:00',
    bedTime: raw.bedTime || '22:00',
    startDate: raw.startDate || '2026-04-19',
    predForteStartDate: raw.predForteStartDate || '2026-04-23',
    minGapMinutes: parseInt(raw.minGapMinutes) || 10,
    graceMinutes: parseInt(raw.graceMinutes) || 20,
    missMinutes: parseInt(raw.missMinutes) || 90,
    amplinakActive: raw.amplinakActive !== 'false' && raw.amplinakActive !== false
  };
}

function writeSetting(key, value) {
  const sheet = getSheet('Settings');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}

// ---- Schedule computation (deterministic) ----

function activeDrugs(date, settings) {
  const startDate = new Date(settings.startDate);
  const day = daysBetween(startDate, date);
  const predStart = new Date(settings.predForteStartDate || settings.startDate);
  const predDay = daysBetween(predStart, date);
  const drugs = [];

  // Ocupol: 4x/day for 7 days (days 0-6) post treatment start
  if (day >= 0 && day < 7) {
    drugs.push({ id: 'ocupol', freq: 4 });
  }

  // Amplinak: 3x/day, open-ended while active
  if (day >= 0 && settings.amplinakActive) {
    drugs.push({ id: 'amplinak', freq: 3 });
  }

  // Pred Forte: tapering schedule anchored to predForteStartDate so a
  // mid-course re-taper (new prescription) can restart cleanly without
  // changing the overall treatment startDate.
  if (predDay >= 0) {
    const week = Math.floor(predDay / 7) + 1;
    const taperWeeks = Object.keys(PRED_TAPER).length;
    if (week <= taperWeeks) {
      drugs.push({ id: 'pred_forte', freq: PRED_TAPER[week] });
    }
  }

  return drugs;
}

function computeSchedule(date, settings) {
  const wakeMin = timeToMinutes(settings.wakeTime);
  const bedMin = timeToMinutes(settings.bedTime);
  const activeMin = bedMin - wakeMin;
  const minGap = settings.minGapMinutes;
  const drugs = activeDrugs(date, settings);
  const slots = [];

  for (const drug of drugs) {
    const N = drug.freq;
    if (N === 0) continue;
    const times = [];
    if (N === 1) {
      times.push(wakeMin);
    } else {
      const interval = activeMin / (N - 1);
      for (let i = 0; i < N; i++) {
        times.push(Math.round(wakeMin + i * interval));
      }
    }
    for (const t of times) {
      slots.push({
        drug: drug.id,
        eye: DRUGS[drug.id].eye,
        scheduledAt: combineDateTimeMinutes(date, t),
        priority: DRUGS[drug.id].priority,
        _minutes: t
      });
    }
  }

  // Sort by time then priority
  slots.sort((a, b) => a._minutes - b._minutes || a.priority - b.priority);

  // Stagger conflicts
  for (let i = 1; i < slots.length; i++) {
    const prevMin = slots[i - 1]._minutes;
    if (slots[i]._minutes - prevMin < minGap) {
      slots[i]._minutes = prevMin + minGap;
      slots[i].scheduledAt = combineDateTimeMinutes(date, slots[i]._minutes);
    }
  }

  return slots.map(s => ({
    drug: s.drug,
    eye: s.eye,
    scheduledAt: toISO(s.scheduledAt),
    scheduledTime: minutesToTime(s._minutes)
  }));
}

// ---- Logs ----

function readLogs(daysBack) {
  const sheet = getSheet('Logs');
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const headers = data[0];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (daysBack || 30));

  const logs = [];
  for (let i = 1; i < data.length; i++) {
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = data[i][j];
    }
    if (row.actualAt && new Date(row.actualAt) >= cutoff) {
      logs.push(row);
    }
  }
  return logs;
}

function readTodayLogs() {
  const today = todayDate();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const sheet = getSheet('Logs');
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const headers = data[0];
  const logs = [];
  for (let i = 1; i < data.length; i++) {
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = data[i][j];
    }
    if (row.actualAt) {
      const d = new Date(row.actualAt);
      if (d >= today && d < tomorrow) {
        logs.push(row);
      }
    }
  }
  return logs;
}

function insertLog(entry) {
  const sheet = getSheet('Logs');
  const id = uuid();
  const now = toISO(new Date());
  sheet.appendRow([
    id,
    entry.drug,
    entry.eye || DRUGS[entry.drug].eye,
    entry.scheduledAt || '',
    entry.actualAt,
    entry.loggedAt || now,
    entry.manualEntry || false,
    entry.caretaker || '',
    entry.status || 'taken'
  ]);
  return {
    id, drug: entry.drug, eye: entry.eye || DRUGS[entry.drug].eye,
    scheduledAt: entry.scheduledAt, actualAt: entry.actualAt,
    loggedAt: now, manualEntry: entry.manualEntry || false,
    caretaker: entry.caretaker || '', status: entry.status || 'taken'
  };
}

function editLog(id, actualAt) {
  const sheet = getSheet('Logs');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('id');
  const actualCol = headers.indexOf('actualAt');
  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] === id) {
      sheet.getRange(i + 1, actualCol + 1).setValue(actualAt);
      return { id, actualAt };
    }
  }
  return null;
}

function deleteLog(id) {
  const sheet = getSheet('Logs');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('id');
  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol] === id) {
      sheet.deleteRow(i + 1);
      return true;
    }
  }
  return false;
}

// ---- Subscriptions ----

function readSubscriptions() {
  const sheet = getSheet('Subscriptions');
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const subs = [];
  for (let i = 1; i < data.length; i++) {
    subs.push({
      subscriptionId: data[i][0],
      deviceLabel: data[i][1],
      addedAt: data[i][2],
      active: data[i][3] !== false && data[i][3] !== 'false'
    });
  }
  return subs;
}

function addSubscription(subscriptionId, deviceLabel) {
  const sheet = getSheet('Subscriptions');
  const data = sheet.getDataRange().getValues();
  // Check if already exists
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === subscriptionId) {
      // Update label and reactivate
      sheet.getRange(i + 1, 2).setValue(deviceLabel);
      sheet.getRange(i + 1, 4).setValue(true);
      return;
    }
  }
  sheet.appendRow([subscriptionId, deviceLabel, toISO(new Date()), true]);
}

function removeSubscription(subscriptionId) {
  const sheet = getSheet('Subscriptions');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === subscriptionId) {
      sheet.getRange(i + 1, 4).setValue(false);
      return true;
    }
  }
  return false;
}

// ---- Notifications tracking ----

function readTodayNotifications() {
  const sheet = getSheet('Notifications');
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return {};
  const today = todayDate().toISOString().slice(0, 10);
  const sent = {};
  for (let i = 1; i < data.length; i++) {
    const key = data[i][0];
    if (key && key.startsWith(today)) {
      if (!sent[key]) sent[key] = new Set();
      sent[key].add(data[i][1]);
    }
  }
  return sent;
}

function recordNotification(slotKey, level) {
  const sheet = getSheet('Notifications');
  sheet.appendRow([slotKey, level, toISO(new Date())]);
}

// ---- Push via OneSignal ----

function sendPush(title, body, targets) {
  const appId = PROPS.getProperty('ONESIGNAL_APP_ID');
  const restKey = PROPS.getProperty('ONESIGNAL_REST_KEY');
  if (!appId || !restKey || !targets || targets.length === 0) return;

  const payload = {
    app_id: appId,
    include_subscription_ids: targets,
    headings: { en: title },
    contents: { en: body },
    url: PROPS.getProperty('SITE_URL') || 'https://bkbaheti.github.io/momMeds/',
    priority: 10
  };

  try {
    UrlFetchApp.fetch('https://api.onesignal.com/notifications', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Basic ' + restKey },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log('Push error: ' + e.message);
  }
}

// ---- Notification copy ----

function notificationCopy(drug, scheduledAt, level) {
  const drugName = DRUGS[drug].name;
  const eye = DRUGS[drug].eye === 'L' ? 'left eye' : 'oral';
  const timeStr = formatTimeHHMM(new Date(scheduledAt));
  const ampm = formatAMPM(new Date(scheduledAt));

  switch (level) {
    case 'T-10':
      return { title: '🔔 Upcoming dose', body: drugName + ' due in 10 min (' + ampm + ') — ' + eye };
    case 'T0':
      return { title: '💧 Dose due now', body: drugName + ' due now — ' + eye + '. Tap to log.' };
    case 'T+late':
      return { title: '⏰ Late dose', body: drugName + ' is late — please administer' };
    case 'T+escalate':
      return { title: '🚨 Overdue', body: drugName + ' overdue — please check on Mom' };
    default:
      return { title: 'Eye Meds', body: drugName + ' — ' + eye };
  }
}

function formatAMPM(date) {
  let h = date.getHours();
  const m = String(date.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + m + ' ' + ampm;
}

// ---- Cron: notification state machine (every 5 min) ----

function cronCheck() {
  const now = nowIST();
  const settings = readSettings();

  // Quiet hours check
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const wakeMin = timeToMinutes(settings.wakeTime);
  const bedMin = timeToMinutes(settings.bedTime);
  if (bedMin > wakeMin) {
    if (nowMin >= bedMin || nowMin < wakeMin) return;
  } else {
    if (nowMin >= bedMin && nowMin < wakeMin) return;
  }

  const today = todayDate();
  const schedule = computeSchedule(today, settings);
  const todayLogs = readTodayLogs();
  const sent = readTodayNotifications();
  const subs = readSubscriptions().filter(s => s.active);
  const targets = subs.map(s => s.subscriptionId);
  if (targets.length === 0) return;

  const graceMin = settings.graceMinutes;
  const missMin = settings.missMinutes;
  const minGap = settings.minGapMinutes;

  // Collect pending notifications for grouping
  const pending = [];

  for (const slot of schedule) {
    const scheduledAt = new Date(slot.scheduledAt);
    const slotKey = today.toISOString().slice(0, 10) + '|' + slot.drug + '|' + slot.scheduledTime;

    // Check if already logged
    const logged = todayLogs.find(l =>
      l.drug === slot.drug &&
      l.status === 'taken' &&
      Math.abs(new Date(l.actualAt) - scheduledAt) < 2 * 60 * 60 * 1000
    );
    if (logged) continue;

    const delta = (now - scheduledAt) / 60000; // minutes

    const sentLevels = sent[slotKey] || new Set();
    let level = null;

    if (delta >= -10 && delta < 0 && !sentLevels.has('T-10')) {
      level = 'T-10';
    } else if (delta >= 0 && delta < graceMin && !sentLevels.has('T0')) {
      level = 'T0';
    } else if (delta >= graceMin && delta < 60 && !sentLevels.has('T+late')) {
      level = 'T+late';
    } else if (delta >= 60 && delta < missMin && !sentLevels.has('T+escalate')) {
      level = 'T+escalate';
    } else if (delta >= missMin) {
      // Insert missed log if not already present
      const alreadyMissed = todayLogs.find(l =>
        l.drug === slot.drug && l.status === 'missed' &&
        l.scheduledAt === slot.scheduledAt
      );
      if (!alreadyMissed) {
        insertLog({
          drug: slot.drug,
          eye: slot.eye,
          scheduledAt: slot.scheduledAt,
          actualAt: slot.scheduledAt,
          loggedAt: toISO(new Date()),
          manualEntry: false,
          status: 'missed'
        });
      }
      continue;
    }

    if (level) {
      pending.push({ slot, slotKey, level, scheduledAt });
    }
  }

  // Grouping: merge notifications with same level within minGap of each other
  const grouped = [];
  const used = new Set();

  for (let i = 0; i < pending.length; i++) {
    if (used.has(i)) continue;
    const group = [pending[i]];
    used.add(i);

    for (let j = i + 1; j < pending.length; j++) {
      if (used.has(j)) continue;
      if (pending[j].level === pending[i].level &&
        Math.abs(pending[j].scheduledAt - pending[i].scheduledAt) <= minGap * 60000) {
        group.push(pending[j]);
        used.add(j);
      }
    }
    grouped.push(group);
  }

  // Send notifications
  for (const group of grouped) {
    if (group.length === 1) {
      const { slot, slotKey, level } = group[0];
      const copy = notificationCopy(slot.drug, slot.scheduledAt, level);
      sendPush(copy.title, copy.body, targets);
      recordNotification(slotKey, level);
    } else {
      // Grouped notification
      const drugNames = group.map(g => DRUGS[g.slot.drug].name);
      const level = group[0].level;
      const gapMin = minGap;
      let body;
      if (level === 'T0') {
        body = 'Due now: ' + drugNames[0] + ', then ' + drugNames.slice(1).join(', ') + ' in ' + gapMin + ' min (left eye)';
      } else {
        body = drugNames.join(', ') + ' — left eye';
      }
      const title = level === 'T0' ? '💧 Doses due' : level === 'T-10' ? '🔔 Upcoming doses' : '⏰ Multiple doses';
      sendPush(title, body, targets);
      for (const g of group) {
        recordNotification(g.slotKey, g.level);
      }
    }
  }
}

// ---- API Router ----

function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}

function handleRequest(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  let body = {};

  try {
    if (e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
  } catch (_) {}

  try {
    switch (action) {
      case 'state':
        return handleState();
      case 'log':
        return handleLog(body);
      case 'editLog':
        return handleEditLog(body);
      case 'deleteLog':
        return handleDeleteLog(body);
      case 'settings':
        return handleSettings(body);
      case 'reset':
        return handleReset(body);
      case 'subscribe':
        return handleSubscribe(body);
      case 'unsubscribe':
        return handleUnsubscribe(body);
      default:
        return err('Unknown action: ' + action);
    }
  } catch (error) {
    return err(error.message || 'Internal error');
  }
}

function handleState() {
  const settings = readSettings();
  const logs = readLogs(30);
  const subs = readSubscriptions();
  return ok({
    settings,
    logs,
    subscriptions: subs,
    serverTime: toISO(new Date()),
    backendVersion: BACKEND_VERSION
  });
}

function handleLog(body) {
  const entry = insertLog({
    drug: body.drug,
    eye: body.eye,
    scheduledAt: body.scheduledAt || null,
    actualAt: body.actualAt,
    manualEntry: body.manualEntry || false,
    caretaker: body.caretaker || '',
    status: body.status || 'taken'
  });
  return ok(entry);
}

function handleEditLog(body) {
  const result = editLog(body.id, body.actualAt);
  if (!result) return err('Log not found');
  return ok(result);
}

function handleDeleteLog(body) {
  const result = deleteLog(body.id);
  if (!result) return err('Log not found');
  return ok({ deleted: true });
}

function handleSettings(body) {
  writeSetting(body.key, body.value);
  return ok({ key: body.key, value: body.value });
}

function handleReset(body) {
  const serverPassword = PROPS.getProperty('RESET_PASSWORD');
  if (body.password !== serverPassword) {
    return err('Incorrect password');
  }
  // Clear Logs
  const logsSheet = getSheet('Logs');
  if (logsSheet.getLastRow() > 1) {
    logsSheet.deleteRows(2, logsSheet.getLastRow() - 1);
  }
  // Clear Notifications
  const notifSheet = getSheet('Notifications');
  if (notifSheet.getLastRow() > 1) {
    notifSheet.deleteRows(2, notifSheet.getLastRow() - 1);
  }
  return ok({ reset: true });
}

function handleSubscribe(body) {
  addSubscription(body.subscriptionId, body.deviceLabel);
  return ok({ subscribed: true });
}

function handleUnsubscribe(body) {
  removeSubscription(body.subscriptionId);
  return ok({ unsubscribed: true });
}

// ---- Sheet initialization helper ----
// Run once manually to set up headers
function initHeaders() {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  const logs = ss.getSheetByName('Logs');
  if (logs.getLastRow() === 0) {
    logs.appendRow(['id', 'drug', 'eye', 'scheduledAt', 'actualAt', 'loggedAt', 'manualEntry', 'caretaker', 'status']);
  }

  const settings = ss.getSheetByName('Settings');
  if (settings.getLastRow() === 0) {
    settings.appendRow(['key', 'value']);
    settings.appendRow(['wakeTime', '07:00']);
    settings.appendRow(['bedTime', '22:00']);
    settings.appendRow(['startDate', '2026-04-19']);
    settings.appendRow(['predForteStartDate', '2026-04-23']);
    settings.appendRow(['minGapMinutes', '10']);
    settings.appendRow(['graceMinutes', '20']);
    settings.appendRow(['missMinutes', '90']);
    settings.appendRow(['amplinakActive', 'true']);
  }

  const subs = ss.getSheetByName('Subscriptions');
  if (subs.getLastRow() === 0) {
    subs.appendRow(['subscriptionId', 'deviceLabel', 'addedAt', 'active']);
  }

  const notif = ss.getSheetByName('Notifications');
  if (notif.getLastRow() === 0) {
    notif.appendRow(['slotKey', 'level', 'sentAt']);
  }
}
