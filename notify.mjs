// Fleet Console — arrival alert sender.
//
// Runs on a schedule (GitHub Actions, every ~5 minutes). Each run:
//   1. reads the ACTIVE bookings from Firestore,
//   2. finds vehicles that are overdue, or due back within 12 hours,
//   3. sends a web-push notification to every device that enabled notifications
//      (so phones are alerted even when the app is closed),
//   4. remembers what it already sent, so nobody is alerted twice for the same booking.
import { pathToFileURL } from 'node:url';

export const UPCOMING_HOURS = 12;
export const DEFAULTS = {
  tzOffset: '+05:30',      // the shop's timezone (India). The app stores times WITHOUT a timezone.
  maxOverdueHours: 72,     // older "overdue" bookings are treated as stale data and not pushed
  maxIndividual: 4,        // more new alerts than this in one run => one combined notification
};

/** Reads a stored time. Times without a timezone (what the app saves) are shop-local time. */
export function parseShopTime(value, tzOffset = DEFAULTS.tzOffset) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') return value.toDate();   // Firestore Timestamp
  const s = String(value).trim();
  if (!s) return null;
  let iso = s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) iso = s + 'T00:00' + tzOffset;
  else if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) iso = s + tzOffset;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Same rules as the app: Active + not yet returned; overdue if past due, upcoming if due within 12h. */
export function computeAlerts(bookings, now = new Date(), opts = {}) {
  const tz = opts.tzOffset || DEFAULTS.tzOffset;
  const cutoff = new Date(now.getTime() + UPCOMING_HOURS * 3600000);
  const round1 = (ms) => Math.round((ms / 3600000) * 10) / 10;
  const alerts = [];
  for (const b of bookings) {
    if (!b || b.bookingStatus !== 'Active' || b.actualReturn) continue;
    const sched = parseShopTime(b.scheduledReturn, tz);
    if (!sched) continue;
    if (sched < now) alerts.push({ type: 'delayed', key: 'delayed:' + b.id, booking: b, hours: round1(now - sched) });
    else if (sched <= cutoff) alerts.push({ type: 'upcoming', key: 'upcoming:' + b.id, booking: b, hours: round1(sched - now) });
  }
  return alerts;
}

export function buildMessage(alert, names = {}) {
  const b = alert.booking;
  const vehicle = names.vehicle || b.vehicleId || 'Vehicle';
  const customer = names.customer || '—';
  const base = { tag: alert.key, bookingId: b.id, type: alert.type, url: './?booking=' + encodeURIComponent(b.id) };
  if (alert.type === 'delayed') {
    return { ...base, title: 'Vehicle overdue for return', body: `${vehicle} — ${customer} (${b.id}) is ${alert.hours} hrs late` };
  }
  return { ...base, title: 'Vehicle due back soon', body: `${vehicle} — ${customer} (${b.id}) due in ${alert.hours} hrs` };
}

/**
 * One sender run. `db` is a Firestore (admin) instance, `sendPush(subscription, payloadString, options)`
 * delivers one push and throws an error with `.statusCode` on failure. Both are injected so this
 * logic can be tested without any network.
 */
export async function run({ db, sendPush, now = new Date(), env = {} }) {
  const tz = env.SHOP_TZ_OFFSET || DEFAULTS.tzOffset;
  const maxOverdueMs = (Number(env.MAX_OVERDUE_HOURS) || DEFAULTS.maxOverdueHours) * 3600000;
  const maxIndividual = Number(env.MAX_INDIVIDUAL) || DEFAULTS.maxIndividual;

  // 1. who needs an alert right now
  const bookingSnap = await db.collection('bookings').where('bookingStatus', '==', 'Active').get();
  const bookings = bookingSnap.docs.map((d) => ({ ...d.data(), id: d.data().id || d.id }));
  const alerts = computeAlerts(bookings, now, { tzOffset: tz });

  // 2. which of those were already sent
  const stateRef = db.collection('pushState').doc('sent');
  const stateSnap = await stateRef.get();
  const sentKeys = new Set(stateSnap.exists ? (stateSnap.data().keys || []) : []);
  const fresh = alerts.filter((a) => !sentKeys.has(a.key));
  const stale = fresh.filter((a) => a.type === 'delayed' && a.hours * 3600000 > maxOverdueMs);
  const toSend = fresh.filter((a) => !stale.includes(a));

  // 3. who to send to
  const subSnap = await db.collection('pushSubs').get();
  const subs = subSnap.docs.map((d) => ({ id: d.id, subscription: d.data().subscription }))
    .filter((s) => s.subscription && s.subscription.endpoint);

  // 4. build messages (names are looked up only when something is actually being sent)
  const cache = new Map();
  const nameOf = async (collection, id, format) => {
    if (!id) return '';
    const k = collection + ':' + id;
    if (cache.has(k)) return cache.get(k);
    const snap = await db.collection(collection).doc(id).get();
    const v = snap.exists ? format(snap.data()) : '';
    cache.set(k, v);
    return v;
  };
  let messages = [];
  if (toSend.length > maxIndividual) {
    const d = toSend.filter((a) => a.type === 'delayed').length;
    const u = toSend.filter((a) => a.type === 'upcoming').length;
    messages.push({
      alerts: toSend,
      payload: { title: 'Fleet alerts', body: `${d} overdue · ${u} due back soon — tap to review`, tag: 'summary', type: 'summary', url: './?view=bookings' },
    });
  } else {
    for (const a of toSend) {
      const vehicle = await nameOf('vehicles', a.booking.vehicleId, (v) => `${v.make || ''} ${v.model || ''}`.trim());
      const customer = await nameOf('customers', a.booking.customerId, (c) => c.name || '');
      messages.push({ alerts: [a], payload: buildMessage(a, { vehicle, customer }) });
    }
  }

  // 5. deliver
  const dead = new Set();
  const newlySent = new Set();
  let delivered = 0;
  for (const m of messages) {
    let ok = 0;
    for (const s of subs) {
      if (dead.has(s.id)) continue;
      try {
        await sendPush(s.subscription, JSON.stringify(m.payload), { TTL: 6 * 3600, urgency: 'high' });
        ok++; delivered++;
      } catch (err) {
        const code = err && err.statusCode;
        if (code === 404 || code === 410) dead.add(s.id);        // device unsubscribed / expired
        else console.error(`push to ${s.id.slice(0, 8)}… failed:`, code || '', (err && err.message) || err);
      }
    }
    if (ok > 0) m.alerts.forEach((a) => newlySent.add(a.key));   // only "sent" if someone received it
  }
  for (const id of dead) await db.collection('pushSubs').doc(id).delete();

  // 6. remember what was sent (stale ones are recorded silently), forget bookings no longer relevant
  const relevant = new Set(alerts.map((a) => a.key));
  const nextKeys = [...new Set([...sentKeys, ...newlySent, ...stale.map((a) => a.key)])].filter((k) => relevant.has(k)).sort();
  const prevKeys = [...sentKeys].sort();
  if (JSON.stringify(nextKeys) !== JSON.stringify(prevKeys)) await stateRef.set({ keys: nextKeys, updatedAt: now.getTime() });

  // 7. heartbeat: lets the app show "sender last ran N minutes ago"
  const summary = { alerts: alerts.length, fresh: toSend.length, stale: stale.length, subscribers: subs.length, delivered, removed: dead.size };
  await db.collection('pushState').doc('heartbeat').set({ lastRun: now.getTime(), ...summary, error: null });
  return summary;
}

async function main() {
  const [{ default: webpush }, { initializeApp, cert }, { getFirestore }] = await Promise.all([
    import('web-push'), import('firebase-admin/app'), import('firebase-admin/firestore'),
  ]);
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('Missing secret FIREBASE_SERVICE_ACCOUNT');
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  const db = getFirestore();

  const fail = async (message) => {
    await db.collection('pushState').doc('heartbeat').set({ lastRun: Date.now(), error: message });
    throw new Error(message);
  };
  const cfg = await db.collection('config').doc('push').get();
  const publicKey = cfg.exists ? cfg.data().publicKey : null;
  if (!publicKey) await fail('No push key found in Firestore. Open Generate_Push_Keys.html and create one first.');
  if (!process.env.VAPID_PRIVATE_KEY) await fail('Missing secret VAPID_PRIVATE_KEY');
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', publicKey, process.env.VAPID_PRIVATE_KEY);

  const summary = await run({
    db, env: process.env,
    sendPush: (subscription, payload, options) => webpush.sendNotification(subscription, payload, options),
  });
  console.log('Alert run complete:', JSON.stringify(summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
