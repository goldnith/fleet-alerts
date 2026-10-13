// Offline tests for the alert sender: node test.mjs
import { run, computeAlerts, parseShopTime, buildMessage } from './notify.mjs';

let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } };

// ---- fake Firestore with the same shape as firebase-admin's ----
function fakeDb(seed) {
  const data = JSON.parse(JSON.stringify(seed));
  const snap = (col, id) => ({ id, exists: !!(data[col] && data[col][id]), data: () => JSON.parse(JSON.stringify(data[col][id])) });
  return {
    _data: data,
    collection(col) {
      data[col] ||= {};
      const docs = (filter) => Object.keys(data[col]).filter((id) => !filter || filter(data[col][id])).map((id) => snap(col, id));
      return {
        where: (f, op, v) => ({ get: async () => ({ docs: docs((d) => d[f] === v) }) }),
        get: async () => ({ docs: docs() }),
        doc: (id) => ({
          get: async () => snap(col, id),
          set: async (obj) => { data[col][id] = JSON.parse(JSON.stringify(obj)); },
          delete: async () => { delete data[col][id]; },
        }),
      };
    },
  };
}
const sub = (n) => ({ subscription: { endpoint: `https://push.example/${n}`, keys: { p256dh: 'x', auth: 'y' } } });
const makePusher = (failures = {}) => {
  const sent = [];
  const fn = async (subscription, payload) => {
    const code = failures[subscription.endpoint];
    if (code) { const e = new Error('push failed'); e.statusCode = code; throw e; }
    sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
  };
  fn.sent = sent; return fn;
};

// Reference moment: 2026-10-11 08:00 UTC  ==  13:30 in India
const NOW = new Date('2026-10-11T08:00:00Z');
const base = {
  vehicles: { 'VEH-1': { make: 'Swift', model: 'Dzire' }, 'VEH-2': { make: 'Hyundai', model: 'Creta' } },
  customers: { 'CUST-1': { name: 'Kumar' }, 'CUST-2': { name: 'Priya' } },
  config: { push: { publicKey: 'k' } },
  pushSubs: { a: sub('a'), b: sub('b') },
  bookings: {
    // naive times are INDIA time:  12:00 IST = 06:30Z  -> 1.5h before NOW  => overdue
    'BKG-1': { id: 'BKG-1', vehicleId: 'VEH-1', customerId: 'CUST-1', bookingStatus: 'Active', scheduledReturn: '2026-10-11T12:00', actualReturn: null },
    // 18:00 IST = 12:30Z -> 4.5h ahead => due soon
    'BKG-2': { id: 'BKG-2', vehicleId: 'VEH-2', customerId: 'CUST-2', bookingStatus: 'Active', scheduledReturn: '2026-10-11T18:00', actualReturn: '' },
    // tomorrow 10:00 IST -> ~20.5h ahead => nothing yet
    'BKG-3': { id: 'BKG-3', vehicleId: 'VEH-1', customerId: 'CUST-1', bookingStatus: 'Active', scheduledReturn: '2026-10-12T10:00', actualReturn: null },
    // already returned => nothing
    'BKG-4': { id: 'BKG-4', vehicleId: 'VEH-1', customerId: 'CUST-1', bookingStatus: 'Active', scheduledReturn: '2026-10-11T09:00', actualReturn: '2026-10-11T10:00' },
    // not Active => never looked at
    'BKG-5': { id: 'BKG-5', vehicleId: 'VEH-1', customerId: 'CUST-1', bookingStatus: 'Completed', scheduledReturn: '2026-10-10T09:00', actualReturn: null },
  },
};

/* ---------- time parsing ---------- */
check('naive time is read as India time (12:00 -> 06:30Z)', parseShopTime('2026-10-11T12:00').toISOString() === '2026-10-11T06:30:00.000Z');
check('naive time with seconds too', parseShopTime('2026-08-25T20:00:00').toISOString() === '2026-08-25T14:30:00.000Z');
check('explicit Z time is left alone', parseShopTime('2026-10-11T12:00:00Z').toISOString() === '2026-10-11T12:00:00.000Z');
check('explicit offset respected', parseShopTime('2026-10-11T12:00:00+00:00').toISOString() === '2026-10-11T12:00:00.000Z');
check('date-only means India midnight', parseShopTime('2026-10-11').toISOString() === '2026-10-10T18:30:00.000Z');
check('blank / junk gives null', parseShopTime('') === null && parseShopTime('nonsense') === null && parseShopTime(null) === null);
check('timezone can be changed', parseShopTime('2026-10-11T12:00', '+00:00').toISOString() === '2026-10-11T12:00:00.000Z');

/* ---------- which bookings alert ---------- */
const al = computeAlerts(Object.values(base.bookings).filter((b) => b.bookingStatus === 'Active'), NOW);
check('exactly one overdue + one due-soon', al.length === 2 && al.find((a) => a.key === 'delayed:BKG-1') && al.find((a) => a.key === 'upcoming:BKG-2'));
check('hours late computed (1.5)', al.find((a) => a.type === 'delayed').hours === 1.5);
check('hours left computed (4.5)', al.find((a) => a.type === 'upcoming').hours === 4.5);
check('a booking 20h away is not alerted', !al.some((a) => a.key.endsWith('BKG-3')));
check('returned booking is not alerted', !al.some((a) => a.key.endsWith('BKG-4')));
const m = buildMessage(al[0], { vehicle: 'Swift Dzire', customer: 'Kumar' });
check('message text matches the app', m.title === 'Vehicle overdue for return' && m.body === 'Swift Dzire — Kumar (BKG-1) is 1.5 hrs late');
check('message opens the right booking', m.url === './?booking=BKG-1' && m.tag === 'delayed:BKG-1' && m.bookingId === 'BKG-1');

/* ---------- full run ---------- */
{
  const db = fakeDb(base); const push = makePusher();
  const r1 = await run({ db, sendPush: push, now: NOW });
  check('run 1: both alerts sent to both devices (2x2)', push.sent.length === 4 && r1.delivered === 4);
  check('run 1: names looked up from vehicles/customers', push.sent.some((s) => s.payload.body === 'Hyundai Creta — Priya (BKG-2) due in 4.5 hrs'));
  check('run 1: state remembers both alerts', JSON.stringify(db._data.pushState.sent.keys) === JSON.stringify(['delayed:BKG-1', 'upcoming:BKG-2']));
  check('run 1: heartbeat written', db._data.pushState.heartbeat.lastRun === NOW.getTime() && db._data.pushState.heartbeat.error === null && db._data.pushState.heartbeat.subscribers === 2);

  const later = new Date(NOW.getTime() + 5 * 60000);
  const r2 = await run({ db, sendPush: push, now: later });
  check('run 2 (5 min later): nothing re-sent', push.sent.length === 4 && r2.fresh === 0);
  check('run 2: heartbeat moved forward', db._data.pushState.heartbeat.lastRun === later.getTime());

  // upcoming one turns into overdue later -> a NEW (delayed) alert, once
  const t3 = new Date('2026-10-11T13:00:00Z');   // 18:30 IST: BKG-2 now 30 min late
  const r3 = await run({ db, sendPush: push, now: t3 });
  check('due-soon booking later becomes an overdue alert', push.sent.filter((s) => s.payload.tag === 'delayed:BKG-2').length === 2 && r3.fresh === 1);
  check('old due-soon key forgotten, new key remembered', db._data.pushState.sent.keys.includes('delayed:BKG-2') && !db._data.pushState.sent.keys.includes('upcoming:BKG-2'));

  // booking gets returned -> its key is cleaned out of the state
  db._data.bookings['BKG-1'].actualReturn = '2026-10-11T19:00';
  await run({ db, sendPush: push, now: new Date(t3.getTime() + 600000) });
  check('returned booking is removed from the remembered list', !db._data.pushState.sent.keys.includes('delayed:BKG-1'));
}

/* ---------- expired / unsubscribed devices ---------- */
{
  const db = fakeDb(base); const push = makePusher({ 'https://push.example/a': 410 });
  const r = await run({ db, sendPush: push, now: NOW });
  check('device that returns 410 is deleted', !db._data.pushSubs.a && !!db._data.pushSubs.b && r.removed === 1);
  check('healthy device still got both alerts', push.sent.length === 2 && push.sent.every((s) => s.endpoint.endsWith('/b')));
  check('alerts counted as sent (someone received them)', db._data.pushState.sent.keys.length === 2);
}
{
  const db = fakeDb(base); const push = makePusher({ 'https://push.example/a': 500, 'https://push.example/b': 500 });
  const r = await run({ db, sendPush: push, now: NOW });
  check('temporary push errors do NOT delete devices', Object.keys(db._data.pushSubs).length === 2 && r.removed === 0);
  check('...and are retried next run (not marked sent)', !db._data.pushState || !db._data.pushState.sent || db._data.pushState.sent.keys.length === 0);
  const push2 = makePusher();
  await run({ db, sendPush: push2, now: new Date(NOW.getTime() + 300000) });
  check('retry succeeds once the push service recovers', push2.sent.length === 4);
}

/* ---------- nobody has enabled notifications yet ---------- */
{
  const db = fakeDb({ ...base, pushSubs: {} }); const push = makePusher();
  const r = await run({ db, sendPush: push, now: NOW });
  check('no devices: nothing sent, nothing marked as sent', push.sent.length === 0 && r.subscribers === 0 && !(db._data.pushState.sent));
  db._data.pushSubs.z = sub('z');
  await run({ db, sendPush: push, now: new Date(NOW.getTime() + 300000) });
  check('a device that subscribes later still gets the alerts', push.sent.length === 2);
}

/* ---------- flood protection ---------- */
{
  const many = { ...base, bookings: {} };
  for (let i = 1; i <= 7; i++) many.bookings['BKG-' + i] = { id: 'BKG-' + i, vehicleId: 'VEH-1', customerId: 'CUST-1', bookingStatus: 'Active', scheduledReturn: '2026-10-11T12:00' };   // 7 overdue
  const db = fakeDb(many); const push = makePusher();
  await run({ db, sendPush: push, now: NOW });
  check('7 new alerts at once => ONE combined notification per device', push.sent.length === 2 && push.sent[0].payload.type === 'summary');
  check('combined text counts them', push.sent[0].payload.body.startsWith('7 overdue'));
  check('all 7 are marked sent', db._data.pushState.sent.keys.length === 7);
  await run({ db, sendPush: push, now: new Date(NOW.getTime() + 300000) });
  check('combined alert is not repeated', push.sent.length === 2);
}
{
  // a booking someone forgot to close, 10 days overdue: recorded silently, not pushed
  const old = { ...base, bookings: { 'BKG-9': { id: 'BKG-9', vehicleId: 'VEH-1', customerId: 'CUST-1', bookingStatus: 'Active', scheduledReturn: '2026-10-01T10:00' } } };
  const db = fakeDb(old); const push = makePusher();
  const r = await run({ db, sendPush: push, now: NOW });
  check('very old overdue booking is not pushed', push.sent.length === 0 && r.stale === 1);
  check('...but is remembered so it is never pushed later', db._data.pushState.sent.keys.includes('delayed:BKG-9'));
}

/* ---------- robustness ---------- */
{
  const odd = { ...base, vehicles: {}, customers: {}, bookings: { 'BKG-1': { vehicleId: 'GONE', customerId: 'GONE', bookingStatus: 'Active', scheduledReturn: '2026-10-11T12:00' } } };
  const db = fakeDb(odd); const push = makePusher();
  await run({ db, sendPush: push, now: NOW });
  check('missing vehicle/customer docs and missing id field do not crash', push.sent.length === 2 && push.sent[0].payload.body.includes('GONE'));
  const db2 = fakeDb({ ...base, bookings: { 'BKG-1': { id: 'BKG-1', bookingStatus: 'Active', scheduledReturn: 'garbage' } } });
  const r = await run({ db: db2, sendPush: makePusher(), now: NOW });
  check('unreadable return time is skipped quietly', r.alerts === 0);
  const db3 = fakeDb({ pushSubs: {}, bookings: {} });
  const r3 = await run({ db: db3, sendPush: makePusher(), now: NOW });
  check('empty database runs cleanly and still writes a heartbeat', r3.alerts === 0 && !!db3._data.pushState.heartbeat);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
