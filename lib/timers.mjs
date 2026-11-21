// Two-way sync with RepairShopr's ticket timers.
//  • RepairShopr is the real timer for anyone who has their own API key (Admin → Users).
//  • Pressing ▶ ❚❚ ■ in the app starts/pauses/stops the RS timer with that person's key.
//  • Starting/stopping a timer inside RepairShopr shows up in the app at the next sync (every minute,
//    or ⟳ Refresh).
//  • One running timer per person, ever: if someone ends up with two running (e.g. started one in
//    RS while another ran), the sync pauses all but the most recently started.
import { db } from "./db.mjs";
import { shopDate, today, startOfShopDayISO } from "./time.mjs";
import { listTimers, createTimer, timerOp } from "./rs.mjs";
import { decryptSecret } from "./secrets.mjs";

const STATUS = s => String(s || "").replace(/^status_/, "").toLowerCase(); // status_running → running

/** Active seconds a timer has, as RepairShopr reports it right now. */
export function timerSeconds(t) {
  const n = Number(t.elapsed_seconds ?? t.active_duration);
  if (Number.isFinite(n) && n >= 0) return Math.round(n);
  const start = Date.parse(t.start_time), end = t.end_time ? Date.parse(t.end_time) : Date.now();
  return Number.isFinite(start) ? Math.max(0, Math.round((end - start) / 1000)) : 0;
}

async function upsertTimers(sql, timers) {
  if (!timers.length) return;
  const rows = timers.filter(t => t && t.id != null).map(t => ({
    id: t.id, ticket_id: t.ticket_id, rs_user_id: t.user_id ?? null, status: STATUS(t.status) || "stopped",
    start_time: t.start_time || null, end_time: t.end_time || null, seconds: timerSeconds(t),
    rs_updated_at: t.updated_at || null,
  }));
  await sql`insert into rs_timers ${sql(rows, "id", "ticket_id", "rs_user_id", "status", "start_time", "end_time", "seconds", "rs_updated_at")}
    on conflict (id) do update set status = excluded.status, start_time = excluded.start_time, end_time = excluded.end_time,
      seconds = excluded.seconds, rs_updated_at = excluded.rs_updated_at, rs_user_id = excluded.rs_user_id, fetched_at = now()`;
}

/** Key to act on a given RS user's timer: their own key if we have it, else the default key. */
function keyForRsUser(peopleRows, rsUserId) {
  const p = peopleRows.find(x => x.rs_user_id != null && String(x.rs_user_id) === String(rsUserId));
  return (p && decryptSecret(p.rs_api_key_enc)) || undefined;
}

/** Pull timers from RS (running, paused, and everything started today), then enforce one-running-per-person. */
export async function syncTimers(peopleRows) {
  const sql = db();
  const [running, paused, todays] = await Promise.all([
    listTimers({ status: "running" }, { maxPages: 4 }),
    listTimers({ status: "paused" }, { maxPages: 4 }),
    listTimers({ created_at_gt: startOfShopDayISO() }, { maxPages: 8 }),
  ]);
  const seen = new Map();
  for (const t of [...todays, ...paused, ...running]) seen.set(t.id, t); // running/paused win (freshest)
  await upsertTimers(sql, [...seen.values()]);

  // Timers we thought were active but RS no longer lists as running/paused → they were stopped. Re-read them.
  const activeIds = new Set([...running, ...paused].map(t => t.id));
  const stale = (await sql`select id, ticket_id, rs_user_id from rs_timers where status in ('running','paused')`)
    .filter(r => !activeIds.has(Number(r.id))).slice(0, 10);
  for (const r of stale) {
    try {
      const list = await listTimers({ ticket_id: r.ticket_id, user_id: r.rs_user_id }, { maxPages: 2 });
      const fresh = list.find(x => String(x.id) === String(r.id));
      await upsertTimers(sql, fresh ? [fresh] : [{ id: Number(r.id), ticket_id: Number(r.ticket_id), user_id: r.rs_user_id, status: "stopped" }]);
    } catch { /* try again next sync */ }
  }

  // One running timer per person: keep the most recently started/resumed, pause the rest.
  const byUser = new Map();
  for (const t of running) {
    if (t.user_id == null) continue;
    if (!byUser.has(t.user_id)) byUser.set(t.user_id, []);
    byUser.get(t.user_id).push(t);
  }
  const paused2 = [];
  for (const [uid, list] of byUser) {
    if (list.length < 2) continue;
    list.sort((a, b) => Date.parse(b.updated_at || b.start_time) - Date.parse(a.updated_at || a.start_time));
    const key = keyForRsUser(peopleRows, uid);
    for (const t of list.slice(1)) {
      try { paused2.push(await timerOp(t.id, "pause", key)); } catch (e) { console.warn("auto-pause failed", t.id, e.message); }
    }
  }
  await upsertTimers(sql, paused2.filter(Boolean));

  // Same rule across the app's own timer and RepairShopr's: if a person has both running, the one
  // started most recently wins and the other is paused.
  const stillRunning = running.filter(t => !paused2.some(p => p && p.id === t.id));
  const local = await sql`select t.ticket_id, t.person_id, t.running_since, p.rs_user_id from timers t join people p on p.id = t.person_id
                          where t.state = 'running' and p.rs_user_id is not null`;
  let crossPaused = 0;
  for (const l of local) {
    const rsRun = stillRunning.filter(t => String(t.user_id) === String(l.rs_user_id));
    if (!rsRun.length) continue;
    const rsNewest = Math.max(...rsRun.map(t => Date.parse(t.updated_at || t.start_time)));
    if (rsNewest >= new Date(l.running_since).getTime()) {
      await sql.begin(async tx => {
        await tx`insert into time_entries (ticket_id, person_id, work_date, seconds, kind)
                 values (${l.ticket_id}, ${l.person_id}, ${today()}, greatest(0, round(extract(epoch from now() - ${l.running_since}::timestamptz)))::int, 'timer')`;
        await tx`update timers set state = 'paused', running_since = null where ticket_id = ${l.ticket_id} and person_id = ${l.person_id}`;
      });
    } else {
      const key = keyForRsUser(peopleRows, l.rs_user_id);
      for (const t of rsRun) { try { await upsertTimers(sql, [await timerOp(t.id, "pause", key)].filter(Boolean)); } catch (e) { console.warn("cross pause", e.message); } }
    }
    crossPaused++;
  }
  return { running: running.length, paused: paused.length, autoPaused: paused2.length + crossPaused };
}

/** ▶ ❚❚ ■ for someone with their own key: drive their real RS timer. */
export async function rsTimerAction(me, myKey, ticketId, action) {
  const sql = db();
  const uid = me.rs_user_id;
  const mine = await listTimers({ user_id: uid, ticket_id: ticketId }, { maxPages: 2, key: myKey });
  await upsertTimers(sql, mine);
  const active = mine.find(t => ["running", "paused"].includes(STATUS(t.status)));
  const changed = [];
  if (action === "start") {
    if (active && STATUS(active.status) === "running") return;
    changed.push(active ? await timerOp(active.id, "start", myKey) : await createTimer(ticketId, myKey));
    // never two at once: pause any other timer of mine that's running (any ticket, assigned or not)
    const others = (await listTimers({ user_id: uid, status: "running" }, { maxPages: 2, key: myKey })).filter(t => String(t.ticket_id) !== String(ticketId));
    for (const t of others) changed.push(await timerOp(t.id, "pause", myKey));
  } else if (active) {
    if (action === "pause" && STATUS(active.status) === "running") changed.push(await timerOp(active.id, "pause", myKey));
    if (action === "stop") changed.push(await timerOp(active.id, "stop", myKey));
  }
  await upsertTimers(sql, changed.filter(Boolean));
}

/** Seconds of RS timer time per (ticket, rs user): total, today, plus the running base for live ticking. */
export async function rsTimerTotals(ticketIds) {
  const t0 = today();
  const rows = await db()`select * from rs_timers where ticket_id = any(${ticketIds}::bigint[]) or status = 'running'`;
  return rows.map(r => ({
    ticketId: Number(r.ticket_id), rsUserId: r.rs_user_id != null ? String(r.rs_user_id) : null, status: r.status,
    seconds: r.seconds, today: r.start_time ? shopDate(r.start_time) === t0 : false, fetchedAt: r.fetched_at,
  }));
}
