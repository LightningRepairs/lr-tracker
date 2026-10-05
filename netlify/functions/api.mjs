// All server endpoints for the Lightning Repairs tech tool, served at /api/*.
// Secrets live in Netlify environment variables: DATABASE_URL, SESSION_SECRET, RS_API_KEY
// (optional: RS_SUBDOMAIN, SHOP_TZ).
import { db } from "../../lib/db.mjs";
import { signToken, verifyToken } from "../../lib/auth.mjs";
import { today, shopDate } from "../../lib/time.mjs";
import { effectiveDevice, creditedMinutes } from "../../lib/booktime.mjs";
import {
  getTickets, getUsers, assignTicket, setTicketIssueType, postComment, invalidate, patchCachedTicket, probeRs, RsError, RS_SUBDOMAIN,
} from "../../lib/rs.mjs";
import { syncFromRs, DEFAULT_QUEUE_STATUSES } from "../../lib/sync.mjs";
import { ensureSchema } from "../../lib/migrate.mjs";
import { RS_ISSUE_TYPES } from "../../lib/booktime.mjs";

// Time budgets so a page load always answers well inside Netlify's ~10s function limit.
const TICKETS_WAIT_MS = 4500, USERS_WAIT_MS = 3000;

export const config = { path: "/api/*" };

const POSITIONS = ["Technician", "Float", "Sales", "Manager"];
const OUTCOMES = ["diagnosis_completed", "diagnosis_incomplete", "repair_completed", "repair_incomplete"];
const PERSON_COLORS = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "#7a5af8", "#0f9fb5", "#b5651d"];

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});
const ms = d => (d ? new Date(d).getTime() : null);
const dstr = d => (d == null ? null : (typeof d === "string" ? d.slice(0, 10) : shopDateFromDb(d)));
// DATE columns come back from postgres.js as JS Dates at UTC midnight — read them back as UTC.
function shopDateFromDb(d) { return new Date(d).toISOString().slice(0, 10); }

export default async (req, context) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api/, "").replace(/\/+$/, "") || "/";
  try {
    if (req.method === "GET" && route === "/health") return json(await health(url.searchParams.get("rs") === "1"));
    if (req.method === "POST" && route === "/login") return json(await login(req, context));

    await ensureSchema();
    const me = await requireMe(req);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    if (req.method === "GET" && route === "/state") return json(await buildState(me));
    if (req.method === "POST") {
      switch (route) {
        case "/position":      return json(await setPosition(me, body));
        case "/timer":         return json(await timerAction(me, body));
        case "/manual-time":   return json(await manualTime(me, body));
        case "/device":        return json(await setDevice(me, body));
        case "/outcome":       return json(await setOutcome(me, body));
        case "/note":          return json(await addNote(me, body));
        case "/assign":        return json(await assign(me, body));
        case "/issue-type":    return json(await setIssueType(me, body));
      }
      if (route.startsWith("/admin/")) {
        if (!me.is_admin) throw new HttpError(403, "Admins only");
        switch (route) {
          case "/admin/booktime-cell":      return json(await setBookTimeCell(body));
          case "/admin/booktime-structure": return json(await editBookTimeStructure(body));
          case "/admin/threshold":          return json(await setSetting("over_book_threshold_pct", Math.max(0, Math.round(Number(body.value) || 0))));
          case "/admin/eligible-statuses":  return json(await setSetting("diagnosis_eligible_statuses", (body.statuses || []).map(String).slice(0, 50)));
          case "/admin/queue-statuses":     return json(await setSetting("queue_statuses", (body.statuses || []).map(String).slice(0, 50)));
          case "/admin/person":             return json(await upsertPerson(me, body));
          case "/admin/pin":                return json(await setPin(body));
        }
      }
    }
    if (req.method === "GET" && route === "/admin/rs-check") {
      if (!me.is_admin) throw new HttpError(403, "Admins only");
      return json(await rsCheck());
    }
    throw new HttpError(404, `No route ${req.method} ${route}`);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    if (e instanceof RsError) return json({ error: e.message }, 502);
    console.error(e);
    return json({ error: e.message || "Server error" }, 500);
  }
};

/* ---------------- auth ---------------- */
async function requireMe(req) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const pid = verifyToken(token);
  if (!pid) throw new HttpError(401, "Not logged in");
  const [me] = await db()`select * from people where id = ${pid} and active`;
  if (!me) throw new HttpError(401, "Not logged in");
  return me;
}

async function login(req, context) {
  const sql = db();
  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
  const { pin } = await req.json().catch(() => ({}));
  const [{ n }] = await sql`select count(*)::int as n from login_attempts where ip = ${ip} and attempted_at > now() - interval '10 minutes'`;
  if (n >= 8) throw new HttpError(429, "Too many wrong PINs — wait 10 minutes");
  const [row] = await sql`select verify_pin(${String(pin || "")}) as id`;
  if (!row?.id) {
    await sql`insert into login_attempts (ip) values (${ip})`;
    await sql`delete from login_attempts where attempted_at < now() - interval '1 day'`;
    throw new HttpError(401, "PIN not recognized");
  }
  return { token: signToken(row.id), personId: row.id };
}

async function health(withRs) {
  const env = {
    DATABASE_URL: !!process.env.DATABASE_URL,
    SESSION_SECRET: (process.env.SESSION_SECRET || "").length >= 16,
    RS_API_KEY: !!process.env.RS_API_KEY,
  };
  let database = "ok";
  try {
    const [{ n }] = await db()`select count(*)::int as n from people`;
    database = `ok (${n} people)`;
  } catch (e) { database = `error: ${e.message}`; }
  const out = { env, database, rsSubdomain: RS_SUBDOMAIN, today: today() };
  if (withRs) out.repairshopr = await probeRs();
  return out;
}

/* ---------------- state ---------------- */
async function loadSettings(sql) {
  const rows = await sql`select key, value from settings`;
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    bookTimes: s.book_times || {},
    overBookThresholdPct: Number(s.over_book_threshold_pct ?? 15),
    diagnosisEligibleStatuses: s.diagnosis_eligible_statuses || [],
    // Statuses that count as "in the queue" — only these show under "Your assigned tickets".
    queueStatuses: s.queue_statuses || DEFAULT_QUEUE_STATUSES,
  };
}

async function buildState(me) {
  const sql = db();
  const t0 = today();
  const [sync, settings, attendanceRows] = await Promise.all([
    syncFromRs({ ticketsWaitMs: TICKETS_WAIT_MS, usersWaitMs: USERS_WAIT_MS }),
    loadSettings(sql),
    sql`select person_id, position from attendance where work_date = ${t0}`,
  ]);
  const { peopleRows, rsUsers, rsError, personByRsUser } = sync;
  const rsList = sync.list;

  // Tickets not on RS's open list but touched today (e.g. resolved) still need to show up.
  const openIds = new Set(rsList.map(t => t.id));
  const extraIdRows = await sql`
    select ticket_id from work_log where work_date = ${t0}
    union select ticket_id from time_entries where work_date = ${t0}
    union select ticket_id from timers where state in ('running','paused')
    union select ticket_id from notes where work_date = ${t0}`;
  const extraIds = extraIdRows.map(r => Number(r.ticket_id)).filter(id => !openIds.has(id));
  const ids = [...openIds, ...extraIds];

  const [stateRows, workRows, assignRows, noteRows, timerRows, totalRows, todayRows, bookTodayRows, spentTodayRows, runningRows, queueRows] = await Promise.all([
    sql`select * from ticket_state where ticket_id = any(${ids}::bigint[])`,
    sql`select * from work_log where ticket_id = any(${ids}::bigint[]) and work_date = ${t0}`,
    sql`select * from assignment_log where ticket_id = any(${ids}::bigint[]) and work_date = ${t0}`,
    sql`select ticket_id, person_id from notes where ticket_id = any(${ids}::bigint[]) and work_date = ${t0}`,
    sql`select * from timers where ticket_id = any(${ids}::bigint[]) and state <> 'idle'`,
    sql`select ticket_id, person_id, sum(seconds)::int as s from time_entries where ticket_id = any(${ids}::bigint[]) group by 1,2`,
    sql`select ticket_id, person_id, sum(seconds)::int as s from time_entries where ticket_id = any(${ids}::bigint[]) and work_date = ${t0} group by 1,2`,
    sql`select person_id, sum(credited_minutes)::int as m from work_log where work_date = ${t0} and outcome in ('diagnosis_completed','repair_completed') group by 1`,
    sql`select person_id, sum(seconds)::int as s from time_entries where work_date = ${t0} group by 1`,
    sql`select person_id, ticket_id, running_since from timers where state = 'running'`,
    sql`select ticket_id, person_id from queue_log where ticket_id = any(${ids}::bigint[]) and work_date = ${t0}`,
  ]);

  const stateById = new Map(stateRows.map(r => [Number(r.ticket_id), r]));
  const group = (rows) => { const m = new Map(); for (const r of rows) { const k = Number(r.ticket_id); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
  const workBy = group(workRows), assignBy = group(assignRows), notesBy = group(noteRows), timersBy = group(timerRows), queueBy = group(queueRows);
  const totalBy = group(totalRows), todayBy = group(todayRows);

  const baseTickets = [
    ...rsList,
    ...extraIds.map(id => {
      const s = stateById.get(id) || {};
      return { id, num: s.rs_number ? Number(s.rs_number) : null, subject: s.rs_subject || `Ticket ${id}`, status: s.rs_status || "", issueType: s.rs_problem_type || null, rsUserId: s.rs_user_id ?? null, customer: "", notOpen: true };
    }),
  ];

  const tickets = baseTickets.map(t => {
    const s = stateById.get(t.id) || {};
    const timers = {};
    for (const r of timersBy.get(t.id) || []) timers[r.person_id] = { state: r.state, runningSince: ms(r.running_since), totalSec: 0, todaySec: 0 };
    for (const r of totalBy.get(t.id) || []) (timers[r.person_id] ||= { state: "idle", runningSince: null, totalSec: 0, todaySec: 0 }).totalSec = r.s;
    for (const r of todayBy.get(t.id) || []) (timers[r.person_id] ||= { state: "idle", runningSince: null, totalSec: 0, todaySec: 0 }).todaySec = r.s;
    return {
      id: t.id, num: t.num, subject: t.subject, status: t.status, issueType: t.issueType, customer: t.customer || "",
      notOpen: !!t.notOpen,
      assignedRsUserId: t.rsUserId ?? null,
      assignedTo: t.rsUserId != null ? (personByRsUser.get(String(t.rsUserId)) || null) : null,
      deviceOverrideCategory: s.device_category || null,
      deviceOverrideSubtype: s.device_subtype || null,
      deviceRow: s.device_row || null,
      repairType: s.repair_type || null,
      diagnosisClaimedBy: s.diagnosis_claimed_by || null, diagnosisClaimedAt: dstr(s.diagnosis_claimed_at),
      diagnosisLocked: !!s.diagnosis_locked,
      repairClaimedBy: s.repair_claimed_by || null, repairClaimedAt: dstr(s.repair_claimed_at),
      repairLocked: !!s.repair_locked,
      workLog: (workBy.get(t.id) || []).map(w => ({ personId: w.person_id, date: dstr(w.work_date), outcome: w.outcome, creditedMinutes: w.credited_minutes, loggedAt: ms(w.logged_at) })),
      assignmentLog: (assignBy.get(t.id) || []).map(a => ({ personId: a.person_id, date: dstr(a.work_date) })),
      notes: (notesBy.get(t.id) || []).map(n => ({ author: n.person_id, date: t0 })),
      queuedToday: (queueBy.get(t.id) || []).map(q => q.person_id), // people who had it in their queue today
      timers,
    };
  });

  const personToday = {};
  for (const p of peopleRows) personToday[p.id] = { bookSec: 0, spentSec: 0, runningSince: null, runningTicketId: null };
  for (const r of bookTodayRows) if (personToday[r.person_id]) personToday[r.person_id].bookSec = r.m * 60;
  for (const r of spentTodayRows) if (personToday[r.person_id]) personToday[r.person_id].spentSec = r.s;
  for (const r of runningRows) if (personToday[r.person_id]) { personToday[r.person_id].runningSince = ms(r.running_since); personToday[r.person_id].runningTicketId = Number(r.ticket_id); }

  return {
    me: me.id,
    today: t0,
    serverNow: Date.now(),
    rsSubdomain: RS_SUBDOMAIN,
    rsError,
    people: peopleRows.map(p => ({
      id: p.id, name: p.name, initials: p.initials, color: p.color, isAdmin: p.is_admin,
      positions: p.positions || [], rsUserId: p.rs_user_id != null ? Number(p.rs_user_id) : null,
      hasPin: !!p.pin_hash, active: p.active,
    })),
    attendance: attendanceRows.map(a => ({ personId: a.person_id, position: a.position })),
    settings,
    tickets,
    personToday,
    rsUsers: me.is_admin ? rsUsers : [],
  };
}

/* ---------------- mutations ---------------- */
async function setPosition(me, { position }) {
  if (!(me.positions || []).includes(position)) throw new HttpError(400, "That position isn't assigned to you");
  await db()`insert into attendance (person_id, work_date, position) values (${me.id}, ${today()}, ${position})
             on conflict (person_id, work_date) do update set position = excluded.position`;
  return { ok: true };
}

const ticketIdOf = v => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Bad ticket id"); return n; };

async function finalizeRunning(tx, ticketId, personId, t0) {
  await tx`
    insert into time_entries (ticket_id, person_id, work_date, seconds, kind)
    select ticket_id, person_id, ${t0}, greatest(0, round(extract(epoch from now() - running_since)))::int, 'timer'
      from timers where ticket_id = ${ticketId} and person_id = ${personId} and state = 'running' and running_since is not null`;
}

async function timerAction(me, { ticketId, action }) {
  const id = ticketIdOf(ticketId);
  if (!["start", "pause", "stop"].includes(action)) throw new HttpError(400, "Bad timer action");
  const t0 = today();
  await db().begin(async tx => {
    await tx`insert into timers (ticket_id, person_id) values (${id}, ${me.id}) on conflict do nothing`;
    const [cur] = await tx`select * from timers where ticket_id = ${id} and person_id = ${me.id} for update`;
    if (action === "start") {
      if (cur.state === "running") return;
      // only one running timer per person: auto-PAUSE (not stop) whatever else is running
      const others = await tx`select ticket_id from timers where person_id = ${me.id} and state = 'running' and ticket_id <> ${id} for update`;
      for (const o of others) {
        await finalizeRunning(tx, o.ticket_id, me.id, t0);
        await tx`update timers set state = 'paused', running_since = null where ticket_id = ${o.ticket_id} and person_id = ${me.id}`;
      }
      await tx`update timers set state = 'running', running_since = now() where ticket_id = ${id} and person_id = ${me.id}`;
    } else {
      await finalizeRunning(tx, id, me.id, t0);
      const next = action === "pause" ? (cur.state === "running" ? "paused" : cur.state) : "logged";
      await tx`update timers set state = ${next}, running_since = null where ticket_id = ${id} and person_id = ${me.id}`;
    }
  });
  return { ok: true };
}

// SETS this person's total logged time on the ticket to exactly `minutes` (not additive), and stops the timer.
async function manualTime(me, { ticketId, minutes }) {
  const id = ticketIdOf(ticketId);
  const target = Math.round(Number(minutes) * 60);
  if (!Number.isFinite(target) || target < 0 || target > 24 * 3600) throw new HttpError(400, "Enter minutes between 0 and 1440");
  const t0 = today();
  await db().begin(async tx => {
    await tx`insert into timers (ticket_id, person_id) values (${id}, ${me.id}) on conflict do nothing`;
    await tx`select 1 from timers where ticket_id = ${id} and person_id = ${me.id} for update`;
    const [{ s }] = await tx`select coalesce(sum(seconds),0)::int as s from time_entries where ticket_id = ${id} and person_id = ${me.id}`;
    const delta = target - s;  // running segment is discarded: the typed number IS the total
    if (delta !== 0) await tx`insert into time_entries (ticket_id, person_id, work_date, seconds, kind) values (${id}, ${me.id}, ${t0}, ${delta}, 'manual')`;
    await tx`update timers set state = 'logged', running_since = null where ticket_id = ${id} and person_id = ${me.id}`;
  });
  return { ok: true };
}

async function recomputeCredits(tx, ticketId) {
  const [s] = await tx`select * from ticket_state where ticket_id = ${ticketId}`;
  const bookTimes = (await tx`select value from settings where key = 'book_times'`)[0]?.value || {};
  const dev = effectiveDevice(s?.rs_problem_type, s);
  const rows = await tx`select id, outcome from work_log where ticket_id = ${ticketId} and work_date = ${today()}`;
  for (const r of rows) {
    await tx`update work_log set credited_minutes = ${creditedMinutes(bookTimes, dev, r.outcome)},
             repair_type = ${r.outcome === "repair_completed" ? dev.repairType : null} where id = ${r.id}`;
  }
}

const clean = (v, max = 120) => (v == null || v === "" ? null : String(v).slice(0, max));

async function setDevice(me, { ticketId, category, subtype, row, repairType }) {
  const id = ticketIdOf(ticketId);
  await db().begin(async tx => {
    await tx`
      insert into ticket_state (ticket_id, device_category, device_subtype, device_row, repair_type, updated_at)
      values (${id}, ${clean(category)}, ${clean(subtype)}, ${clean(row)}, ${clean(repairType)}, now())
      on conflict (ticket_id) do update set device_category = excluded.device_category, device_subtype = excluded.device_subtype,
        device_row = excluded.device_row, repair_type = excluded.repair_type, updated_at = now()`;
    await recomputeCredits(tx, id);
  });
  return { ok: true };
}

function reverseEffects(s, outcome, personId) {
  if (outcome === "diagnosis_completed" && s.diagnosis_claimed_by === personId) {
    s.diagnosis_claimed_by = null; s.diagnosis_claimed_at = null; s.diagnosis_locked = false;
  } else if (outcome === "repair_completed" && s.repair_claimed_by === personId) {
    s.repair_claimed_by = null; s.repair_claimed_at = null; s.repair_locked = false;
    if (!s.diagnosis_claimed_by) s.diagnosis_locked = false;
  }
}
function applyEffects(s, outcome, personId, t0) {
  if (outcome === "diagnosis_completed") {
    s.diagnosis_claimed_by = personId; s.diagnosis_claimed_at = t0; s.diagnosis_locked = true;
  } else if (outcome === "repair_completed") {
    s.repair_claimed_by = personId; s.repair_claimed_at = t0; s.repair_locked = true; s.diagnosis_locked = true;
  }
}

async function setOutcome(me, { ticketId, outcome }) {
  const id = ticketIdOf(ticketId);
  const next = outcome || null;
  if (next && !OUTCOMES.includes(next)) throw new HttpError(400, "Bad outcome");
  const t0 = today();
  await db().begin(async tx => {
    await tx`insert into ticket_state (ticket_id) values (${id}) on conflict do nothing`;
    const [s] = await tx`select * from ticket_state where ticket_id = ${id} for update`;
    const [existing] = await tx`select * from work_log where ticket_id = ${id} and person_id = ${me.id} and work_date = ${t0}`;
    if (existing) reverseEffects(s, existing.outcome, me.id);
    if (next) {
      if (next.startsWith("diagnosis") && s.diagnosis_locked) throw new HttpError(409, "Diagnosis credit on this ticket is already claimed/closed");
      if (next.startsWith("repair") && s.repair_locked) throw new HttpError(409, "Repair credit on this ticket is already claimed");
      applyEffects(s, next, me.id, t0);
    }
    await tx`update ticket_state set
      diagnosis_claimed_by = ${s.diagnosis_claimed_by}, diagnosis_claimed_at = ${s.diagnosis_claimed_at}, diagnosis_locked = ${s.diagnosis_locked},
      repair_claimed_by = ${s.repair_claimed_by}, repair_claimed_at = ${s.repair_claimed_at}, repair_locked = ${s.repair_locked},
      updated_at = now()
      where ticket_id = ${id}`;
    if (existing && !next) {
      await tx`delete from work_log where id = ${existing.id}`;
    } else if (existing) {
      await tx`update work_log set outcome = ${next}, logged_at = now() where id = ${existing.id}`;
    } else if (next) {
      await tx`insert into work_log (ticket_id, person_id, work_date, outcome) values (${id}, ${me.id}, ${t0}, ${next})`;
    }
    await recomputeCredits(tx, id);
  });
  return { ok: true };
}

async function addNote(me, { ticketId, text }) {
  const id = ticketIdOf(ticketId);
  const body = String(text || "").trim().slice(0, 4000);
  if (!body) throw new HttpError(400, "Note is empty");
  const sql = db();
  const [n] = await sql`insert into notes (ticket_id, person_id, work_date, body) values (${id}, ${me.id}, ${today()}, ${body}) returning id`;
  let rsPosted = false, rsError = null;
  try {
    await postComment(id, me.name, body);
    rsPosted = true;
    await sql`update notes set rs_posted = true where id = ${n.id}`;
    await invalidate(`comments:${id}`);
  } catch (e) { rsError = e.message; }
  return { ok: true, rsPosted, rsError };
}

async function assign(me, { ticketId, personId }) {
  const id = ticketIdOf(ticketId);
  const sql = db();
  if (!me.is_admin && personId !== me.id) throw new HttpError(403, "You can only assign tickets to yourself");
  let rsUserId = null;
  if (personId) {
    const [p] = await sql`select * from people where id = ${personId} and active`;
    if (!p) throw new HttpError(400, "Unknown person");
    if (p.rs_user_id == null) throw new HttpError(400, `${p.name} isn't linked to a RepairShopr user yet (Admin Console → Users)`);
    rsUserId = Number(p.rs_user_id);
  }
  await assignTicket(id, rsUserId);
  await patchCachedTicket(id, { rsUserId });
  await sql`update ticket_state set rs_user_id = ${rsUserId} where ticket_id = ${id}`;
  if (personId) await sql`insert into assignment_log (ticket_id, person_id, work_date) values (${id}, ${personId}, ${today()}) on conflict do nothing`;
  return { ok: true };
}

// Changes the Issue Type on the RepairShopr ticket itself (only RS's own types allowed), and resets
// the model/repair picks since they belonged to the old type.
async function setIssueType(me, { ticketId, issueType }) {
  const id = ticketIdOf(ticketId);
  if (!RS_ISSUE_TYPES.includes(issueType)) throw new HttpError(400, "Not a RepairShopr Issue Type");
  await setTicketIssueType(id, issueType);
  await patchCachedTicket(id, { issueType });
  await db().begin(async tx => {
    await tx`insert into ticket_state (ticket_id, rs_problem_type) values (${id}, ${issueType})
             on conflict (ticket_id) do update set rs_problem_type = excluded.rs_problem_type,
               device_category = null, device_subtype = null, device_row = null, repair_type = null, updated_at = now()`;
    await recomputeCredits(tx, id);
  });
  return { ok: true };
}

/* ---------------- admin ---------------- */
async function setSetting(key, value) {
  const sql = db();
  await sql`insert into settings (key, value) values (${key}, ${sql.json(value)}) on conflict (key) do update set value = excluded.value`;
  return { ok: true };
}

async function setBookTimeCell({ cat, sub, rowIdx, colIdx, value }) {
  const sql = db();
  return sql.begin(async tx => {
    const [r] = await tx`select value from settings where key = 'book_times' for update`;
    const bt = r?.value || {};
    const g = bt?.[cat]?.subtypes?.[sub];
    if (!g) throw new HttpError(400, "Unknown category/sub-type");
    const row = g.rows[rowIdx], col = g.columns[colIdx];
    if (row == null || col == null) throw new HttpError(400, "Unknown cell");
    const trimmed = String(value ?? "").trim();
    g.data[row][col] = trimmed === "" ? null : Math.max(0, Math.round(Number(trimmed) || 0));
    await tx`update settings set value = ${tx.json(bt)} where key = 'book_times'`;
    return { ok: true, value: g.data[row][col] };
  });
}

// Add/remove a model (row) or repair type (column) in one Book Time Database sub-type.
async function editBookTimeStructure({ cat, sub, op, name, index }) {
  return db().begin(async tx => {
    const [r] = await tx`select value from settings where key = 'book_times' for update`;
    const bt = r?.value || {};
    const g = bt?.[cat]?.subtypes?.[sub];
    if (!g) throw new HttpError(400, "Unknown category/sub-type");
    const label = String(name ?? "").trim().slice(0, 60);
    if (op === "addRow" || op === "addCol") {
      if (!label) throw new HttpError(400, "Name is empty");
      const list = op === "addRow" ? g.rows : g.columns;
      if (list.some(x => x.toLowerCase() === label.toLowerCase())) throw new HttpError(400, `"${label}" already exists`);
      if (op === "addRow") { g.rows.push(label); g.data[label] = Object.fromEntries(g.columns.map(c => [c, null])); }
      else { g.columns.push(label); for (const row of g.rows) g.data[row][label] = null; }
    } else if (op === "delRow") {
      const row = g.rows[index];
      if (row == null) throw new HttpError(400, "Unknown model");
      g.rows.splice(index, 1); delete g.data[row];
    } else if (op === "delCol") {
      const col = g.columns[index];
      if (col == null) throw new HttpError(400, "Unknown repair type");
      g.columns.splice(index, 1); for (const row of g.rows) delete g.data[row][col];
    } else throw new HttpError(400, "Bad operation");
    await tx`update settings set value = ${tx.json(bt)} where key = 'book_times'`;
    return { ok: true };
  });
}

function slug(name) { return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "person"; }

async function upsertPerson(me, b) {
  const sql = db();
  if (b.create) {
    const name = String(b.name || "").trim();
    if (!name) throw new HttpError(400, "Name required");
    let id = slug(name.split(" ")[0]);
    const existing = new Set((await sql`select id from people`).map(r => r.id));
    for (let i = 2; existing.has(id); i++) id = `${slug(name.split(" ")[0])}${i}`;
    const initials = (b.initials || name.split(/\s+/).map(w => w[0]).join("").slice(0, 2)).toUpperCase();
    const [{ n }] = await sql`select count(*)::int as n from people`;
    await sql`insert into people (id, name, initials, color, positions, sort)
              values (${id}, ${name}, ${initials}, ${PERSON_COLORS[n % PERSON_COLORS.length]}, ${["Technician"]}::text[], ${n})`;
    return { ok: true, id };
  }
  const [p] = await sql`select * from people where id = ${b.id}`;
  if (!p) throw new HttpError(404, "Unknown person");
  if (b.positions !== undefined) {
    const pos = (b.positions || []).filter(x => POSITIONS.includes(x));
    await sql`update people set positions = ${pos}::text[] where id = ${p.id}`;
  }
  if (b.rsUserId !== undefined) {
    const v = b.rsUserId === null || b.rsUserId === "" ? null : Number(b.rsUserId);
    if (v != null) await sql`update people set rs_user_id = null where rs_user_id = ${v} and id <> ${p.id}`;
    await sql`update people set rs_user_id = ${v} where id = ${p.id}`;
  }
  if (b.name !== undefined && String(b.name).trim()) await sql`update people set name = ${String(b.name).trim()} where id = ${p.id}`;
  if (b.active !== undefined) {
    if (p.id === me.id && !b.active) throw new HttpError(400, "You can't deactivate yourself");
    await sql`update people set active = ${!!b.active} where id = ${p.id}`;
  }
  return { ok: true };
}

async function setPin({ personId, pin }) {
  try {
    await db()`select set_pin(${personId}, ${String(pin || "")})`;
  } catch (e) {
    throw new HttpError(400, e.message.replace(/^.*?ERROR:\s*/, ""));
  }
  return { ok: true };
}

async function rsCheck() {
  const out = { ok: false, errors: [] };
  try {
    const r = await getTickets({ force: true, maxWaitMs: 8000 });
    if (r.error) out.errors.push(r.error);
    const list = r.value.list;
    out.fetchMs = r.value.fetchMs ?? null;
    out.ticketCount = list.length;
    out.openMeta = r.value.openMeta;
    out.statuses = countBy(list, t => t.status || "(blank)");
    out.issueTypes = countBy(list, t => t.issueType || "(blank)");
    out.sampleRaw = r.value.sampleRaw;
    out.ok = true;
  } catch (e) { out.errors.push(e.message); }
  try {
    out.users = await getUsers({ force: true, maxWaitMs: 4000 });
  } catch (e) { out.errors.push(e.message); }
  return out;
}
function countBy(list, fn) {
  const m = {};
  for (const x of list) { const k = fn(x); m[k] = (m[k] || 0) + 1; }
  return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ value: k, count: n }));
}
