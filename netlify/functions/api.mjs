// All server endpoints for the Lightning Repairs tech tool, served at /api/*.
// Secrets live in Netlify environment variables: DATABASE_URL, SESSION_SECRET, RS_API_KEY
// (optional: RS_SUBDOMAIN, SHOP_TZ).
import { db } from "../../lib/db.mjs";
import { signToken, verifyToken } from "../../lib/auth.mjs";
import { today, shopDate, shopOffset, shopTimeOfDay } from "../../lib/time.mjs";
import { effectiveDevice, creditedMinutes, repairMinutes } from "../../lib/booktime.mjs";
import {
  getTickets, getUsers, assignTicket, setTicketIssueType, postComment, invalidate, patchCachedTicket, probeRs, RsError, RS_SUBDOMAIN,
  whoIsKey, defaultKey, forgetDefaultKey, setTicketDueDate, getMoney, listTimers, timerOp, getNotesToday,
} from "../../lib/rs.mjs";
import { encryptSecret, decryptSecret, last4 } from "../../lib/secrets.mjs";

// The logged-in person's own RepairShopr key, if they have one — so RS records the change as them.
// undefined → the default key is used.
const keyFor = me => decryptSecret(me.rs_api_key_enc) || undefined;
import { syncFromRs, DEFAULT_QUEUE_STATUSES } from "../../lib/sync.mjs";
import { syncTimers, syncTimersThrottled, rsTimerAction, rsTimerTotals } from "../../lib/timers.mjs";
import { ensureSchema } from "../../lib/migrate.mjs";
import { RS_ISSUE_TYPES, ISSUE_TYPE_TO_DEVICE } from "../../lib/booktime.mjs";
import { buildReport, syncInvoiceSnaps, laborProducts } from "../../lib/reports.mjs";
import { getAutoSettings, cleanAutoSettings, webhookInfo, setWebhook, sendCardReport, lastAutoRun } from "../../lib/ccauto.mjs";
import { syncCardSales, syncPastDay, cardSalesFor, valorDiagnose, previousBusinessDay, valorConfigured, valorReaders, namedReaders, ValorError } from "../../lib/valor.mjs";

// Time budgets so a page load always answers well inside Netlify's ~10s function limit.
const TICKETS_WAIT_MS = 4500, USERS_WAIT_MS = 3000;

export const config = { path: "/api/*" };

const POSITIONS = ["Technician", "Float", "Sales", "Assistant Manager", "Manager"];
// Daily goals per position, in minutes (null = no goal). Admin can change them; these are the defaults.
const DEFAULT_GOALS = {
  "Technician":        { book: 360, actual: 360 },
  "Float":             { book: 240, actual: 240 },
  "Sales":             null,
  "Assistant Manager": { book: 120, actual: 120 },
  "Manager":           null,
};
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

    if (req.method === "GET" && route === "/state") return json(await buildState(me, { force: url.searchParams.get("refresh") === "1" }));
    if (req.method === "POST") {
      switch (route) {
        case "/position":      return json(await setPosition(me, body));
        case "/timer":         return json(await timerAction(me, body));
        case "/refurb":        return json(await refurbAction(me, body));
        case "/manual-time":   return json(await manualTime(me, body));
        case "/device":        return json(await setDevice(me, body));
        case "/outcome":       return json(await setOutcome(me, body));
        case "/note":          return json(await addNote(me, body));
        case "/assign":        return json(await assign(me, body));
        case "/issue-type":    return json(await setIssueType(me, body));
        case "/credit":        return json(await setCredit(me, body));
        case "/diagnosis":     return json(await answerDiagnosis(me, body));
        case "/due":           return json(await setDueDate(me, body));
      }
      if (route.startsWith("/admin/")) {
        if (!me.is_admin) throw new HttpError(403, "Admins only");
        switch (route) {
          case "/admin/booktime-cell":      return json(await setBookTimeCell(body));
          case "/admin/booktime-structure": return json(await editBookTimeStructure(body));
          case "/admin/threshold":          return json(await setSetting("over_book_threshold_pct", Math.max(0, Math.round(Number(body.value) || 0))));
          case "/admin/manual-time-note":   return json(await setSetting("manual_time_note", !!body.on));
          case "/admin/role-goal":          return json(await setRoleGoal(body));
          case "/admin/labor-category":     return json(await setLaborCategory(body));
          case "/admin/show-team-book":     return json(await setSetting("show_team_book", !!body.on));
          case "/admin/reader-name":        return json(await setReaderName(body));
          case "/admin/notifications-seen": return json(await markNotificationsSeen(me, body));
          case "/admin/cc-auto":            await setSetting("cc_auto", cleanAutoSettings(body || {})); return json({ ok: true, settings: await getAutoSettings() });
          case "/admin/cc-auto-webhook":    try { return json({ ok: true, webhook: await setWebhook(body.url) }); } catch (e) { throw new HttpError(400, e.message); }
          case "/admin/cc-auto-test":       try { return json(await sendCardReport({ reason: "test", settings: body && body.settings ? cleanAutoSettings(body.settings) : undefined })); } catch (e) { throw new HttpError(400, e.message); }
          case "/admin/show-money":         return json(await setSetting("show_money", !!body.on));
          case "/admin/diag-min-total":     return json(await setSetting("diag_min_repair_total", Math.max(0, Math.round(Number(body.value) || 0))));
          case "/admin/eligible-statuses":  return json(await setSetting("diagnosis_eligible_statuses", (body.statuses || []).map(String).slice(0, 50)));
          case "/admin/queue-statuses":     return json(await setSetting("queue_statuses", (body.statuses || []).map(String).slice(0, 50)));
          case "/admin/person":             return json(await upsertPerson(me, body));
          case "/admin/pin":                return json(await setPin(body));
          case "/admin/person-key":         return json(await setPersonKey(body));
          case "/admin/default-key":        return json(await setDefaultKey(body));
        }
      }
    }
    if (req.method === "GET" && route === "/admin/keys") {
      if (!me.is_admin) throw new HttpError(403, "Admins only");
      return json(await keysInfo());
    }
    if (req.method === "GET" && route === "/card-sales") return json(await cardSales(me, url.searchParams));
    if (req.method === "GET" && route === "/card-sales/info") return json(await cardSalesInfo(me));
    if (req.method === "GET" && route === "/admin/valor-test") {
      if (!me.is_admin) throw new HttpError(403, "Admins only");
      return json(await valorDiagnose());
    }
    if (req.method === "GET" && route === "/admin/report") {
      if (!me.is_admin) throw new HttpError(403, "Admins only");
      return json(await report(url.searchParams));
    }
    if (req.method === "GET" && route === "/admin/rs-check") {
      if (!me.is_admin) throw new HttpError(403, "Admins only");
      return json(await rsCheck());
    }
    throw new HttpError(404, `No route ${req.method} ${route}`);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    if (e instanceof RsError) return json({ error: e.message }, 502);
    if (e instanceof ValorError) return json({ error: e.message }, 502);
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
    // Repair total needed to earn diagnosis credit AND repair credit on the same ticket.
    diagMinRepairTotal: Number(s.diag_min_repair_total ?? 119),
    manualTimeNote: s.manual_time_note === true,
    showMoney: s.show_money !== false,
    showTeamBook: s.show_team_book === true, // Team tab "Team book time" bar (off unless turned on)
    positions: POSITIONS,
    roleGoals: Object.fromEntries(POSITIONS.map(p => [p, s.role_goals && p in s.role_goals ? s.role_goals[p] : DEFAULT_GOALS[p]])), // Team tab "Today's money" panel (on by default)
    // Statuses that count as "in the queue" — only these show under "Your assigned tickets".
    queueStatuses: s.queue_statuses || DEFAULT_QUEUE_STATUSES,
  };
}

// force = the ⟳ Refresh button: pull from RepairShopr right now (waits a bit longer for it).
async function buildState(me, { force = false } = {}) {
  const sql = db();
  const t0 = today();
  const [sync, settings, attendanceRows] = await Promise.all([
    syncFromRs({ force, ticketsWaitMs: force ? 7000 : TICKETS_WAIT_MS, usersWaitMs: USERS_WAIT_MS }),
    loadSettings(sql),
    sql`select person_id, position from attendance where work_date = ${t0}`,
  ]);
  const { peopleRows, rsUsers, personByRsUser } = sync;
  let rsError = sync.rsError;
  // Timers: ⟳ forces a sync; otherwise page loads sync with RS once it's 20s old (short wait, then carry on).
  if (!rsError) {
    try { await syncTimersThrottled(peopleRows, { maxAgeSec: force ? 0 : 20, maxWaitMs: force ? 6000 : 2500 }); }
    catch (e) { if (force) rsError = `Timers: ${e.message}`; }
  }
  const rsList = sync.list;

  // Tickets not on RS's open list but touched today (e.g. resolved) still need to show up.
  const openIds = new Set(rsList.map(t => t.id));
  const extraIdRows = await sql`
    select ticket_id from work_log where work_date = ${t0}
    union select ticket_id from time_entries where work_date = ${t0}
    union select ticket_id from timers where state in ('running','paused')
    union select ticket_id from notes where work_date = ${t0}
    union select ticket_id from completions where work_date = ${t0}
    union select ticket_id from diag_prompts where state = 'pending'`;
  const extraIds = extraIdRows.map(r => Number(r.ticket_id)).filter(id => id > 0 && !openIds.has(id));
  const ids = [...openIds, ...extraIds];

  const [stateRows, workRows, assignRows, noteRows, timerRows, totalRows, todayRows, bookTodayRows, spentTodayRows, runningRows, queueRows, promptRows, diagCreditRows, appNoteRows, moneyCache] = await Promise.all([
    sql`select * from ticket_state where ticket_id = any(${ids}::bigint[])`,
    sql`select * from work_log where ticket_id = any(${ids}::bigint[]) and work_date = ${t0}`,
    sql`select * from assignment_log where ticket_id = any(${ids}::bigint[]) and work_date = ${t0}`,
    sql`select ticket_id, person_id from notes where ticket_id = any(${ids}::bigint[]) and work_date = ${t0}`,
    sql`select * from timers where ticket_id = any(${ids}::bigint[]) and state <> 'idle'`,
    sql`select ticket_id, person_id, sum(seconds)::int as s from time_entries where ticket_id = any(${ids}::bigint[]) group by 1,2`,
    sql`select ticket_id, person_id, sum(seconds)::int as s from time_entries where ticket_id = any(${ids}::bigint[]) and work_date = ${t0} group by 1,2`,
    sql`select c.*, coalesce(json_agg(json_build_object('personId', s.person_id, 'pct', s.pct) order by s.pct desc) filter (where s.person_id is not null), '[]') as shares
        from completions c left join credit_shares s on s.ticket_id = c.ticket_id and s.work_date = c.work_date
        where c.work_date = ${t0} group by c.ticket_id, c.work_date`,
    sql`select person_id, sum(seconds)::int as s from time_entries where work_date = ${t0} group by 1`,
    sql`select person_id, ticket_id, running_since from timers where state = 'running'`,
    sql`select ticket_id, person_id from queue_log where ticket_id = any(${ids}::bigint[]) and work_date = ${t0}`,
    sql`select * from diag_prompts where state = 'pending'`,
    sql`select person_id, sum(credited_minutes)::int as m from work_log where work_date = ${t0} and outcome = 'diagnosis_completed' group by 1`,
    sql`select distinct person_id from notes where work_date = ${t0}`,
    sql`select value from rs_cache where key = 'money'`,
  ]);
  // Refurbs: mine (open + done today) with their timers; everyone's done-today minutes count as book time.
  const [myRefurbRows, refurbDoneRows] = await Promise.all([
    sql`select r.*, t.state as timer_state, t.running_since,
           (select coalesce(sum(seconds),0)::int from time_entries e where e.ticket_id = -r.id and e.person_id = r.person_id) as spent
        from refurbs r left join timers t on t.ticket_id = -r.id and t.person_id = r.person_id
        where r.person_id = ${me.id} and (r.state = 'open' or r.done_date = ${t0}) order by r.created_at`,
    sql`select person_id, count(*)::int as n, sum(book_minutes)::int as m from refurbs where state = 'done' and done_date = ${t0} group by 1`,
  ]);

  const stateById = new Map(stateRows.map(r => [Number(r.ticket_id), r]));
  // Today's completions: worth the picked repair type's minutes (0 until one is picked).
  const issueTypeById = new Map(rsList.map(t => [t.id, t.issueType]));
  // Pending diagnosis questions — only while the ticket still sits in a diagnosis status and diagnosis is unclaimed.
  const diagSet = new Set(settings.diagnosisEligibleStatuses.map(x => String(x).trim().toLowerCase()));
  const statusById = new Map(rsList.map(t => [t.id, t.status]));
  const promptBy = new Map();
  for (const pr of promptRows) {
    const id = Number(pr.ticket_id);
    if (stateById.get(id)?.diagnosis_locked) continue;
    if (!diagSet.has(String(statusById.get(id) || "").trim().toLowerCase())) continue;
    promptBy.set(id, { id: Number(pr.id), personId: pr.person_id, toStatus: pr.to_status });
  }
  const completionBy = new Map();
  for (const c of bookTodayRows) {
    const id = Number(c.ticket_id);
    const ts = stateById.get(id);
    const dev = effectiveDevice(issueTypeById.get(id) ?? ts?.rs_problem_type, ts);
    const mins = repairMinutes(settings.bookTimes, dev, dev.repairType) || 0;
    if (c.book_minutes !== mins) await sql`update completions set book_minutes = ${mins} where ticket_id = ${id} and work_date = ${t0}`;
    completionBy.set(id, {
      resolvedAt: ms(c.resolved_at), assignedPerson: c.assigned_person || null, primaryPerson: c.primary_person || null,
      assignedRsUser: c.assigned_rs_user != null ? Number(c.assigned_rs_user) : null,
      bookMinutes: mins, shares: c.shares || [],
    });
  }
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
      dueDay: t.dueDay || null, createdAt: t.createdAt || null,
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
      completion: completionBy.get(t.id) || null,
      diagPrompt: promptBy.get(t.id) || null,
      timers,
    };
  });

  // RepairShopr timers (mirrored in rs_timers) count toward time spent, same as the app's own timer.
  const ticketById = new Map(tickets.map(t => [t.id, t]));
  let rsTimerRows = [];
  try { rsTimerRows = await rsTimerTotals(ids); } catch (e) { console.warn("rs timers", e.message); }
  for (const r of rsTimerRows) {
    const pid = r.rsUserId != null ? personByRsUser.get(r.rsUserId) : null;
    const t = pid && ticketById.get(r.ticketId);
    if (!t) continue;
    const x = (t.timers[pid] ||= { state: "idle", runningSince: null, totalSec: 0, todaySec: 0 });
    x.totalSec += r.seconds; if (r.today) x.todaySec += r.seconds;
    x.rs = true;
    if (r.status === "running") { x.state = "running"; x.runningSince = ms(r.fetchedAt); }
    else if (r.status === "paused" && x.state !== "running") x.state = "paused";
    else if (r.status === "stopped" && x.state === "idle") x.state = "logged";
  }

  const personToday = {};
  for (const p of peopleRows) personToday[p.id] = { bookSec: 0, spentSec: 0, runningSince: null, runningTicketId: null };
  // + diagnosis credits claimed today
  for (const r of diagCreditRows) if (personToday[r.person_id]) personToday[r.person_id].bookSec += (r.m || 0) * 60;
  // Book time = each ticket resolved today, worth its repair type's minutes, split by credit shares.
  for (const c of completionBy.values()) {
    for (const sh of c.shares) if (personToday[sh.personId]) personToday[sh.personId].bookSec += Math.round((c.bookMinutes || 0) * 60 * sh.pct / 100);
  }
  for (const r of refurbDoneRows) if (personToday[r.person_id]) personToday[r.person_id].bookSec += (r.m || 0) * 60;
  for (const r of spentTodayRows) if (personToday[r.person_id]) personToday[r.person_id].spentSec = r.s;
  for (const r of runningRows) if (personToday[r.person_id]) { personToday[r.person_id].runningSince = ms(r.running_since); personToday[r.person_id].runningTicketId = Number(r.ticket_id); }
  for (const r of rsTimerRows) {
    const pid = r.rsUserId != null ? personByRsUser.get(r.rsUserId) : null;
    if (!pid || !personToday[pid]) continue;
    if (r.today) personToday[pid].spentSec += r.seconds;
    if (r.status === "running") { personToday[pid].runningSince = ms(r.fetchedAt); personToday[pid].runningTicketId = r.ticketId; }
  }

  // Who has shown up today (Team tab lists only them). Any one signal is enough.
  const activeToday = {};
  const mark = (pid, why) => { if (pid && personToday[pid]) (activeToday[pid] ||= new Set()).add(why); };
  for (const a of attendanceRows) mark(a.person_id, "logged in");
  for (const t of rsList) for (const uid of t.noteByToday || []) mark(personByRsUser.get(uid), "RepairShopr note");
  // 📝 Every ticket someone left a note on today (RepairShopr comment feed + notes made in the app).
  const notedToday = [];
  try {
    const nt = (await getNotesToday({ force, maxWaitMs: force ? 6000 : 2000 })).value;
    const byTicket = {};
    if (nt?.day === t0) for (const [tid, uids] of Object.entries(nt.notes)) {
      const set = (byTicket[tid] ||= { people: new Set(), others: new Set() });
      for (const uid of uids) { const pid = personByRsUser.get(String(uid)); if (pid) set.people.add(pid); else set.others.add(String(uid)); }
    }
    for (const t of rsList) for (const uid of t.noteByToday || []) {   // belt and braces: comments embedded in the ticket list
      const pid = personByRsUser.get(uid); const set = (byTicket[t.id] ||= { people: new Set(), others: new Set() });
      if (pid) set.people.add(pid); else set.others.add(uid);
    }
    for (const r of await sql`select distinct ticket_id, person_id from notes where work_date = ${t0}`) {
      (byTicket[r.ticket_id] ||= { people: new Set(), others: new Set() }).people.add(r.person_id);
    }
    const rsName = uid => rsUsers.find(u => String(u.id) === String(uid))?.name || `RS user ${uid}`;
    for (const [tid, v] of Object.entries(byTicket)) {
      if (!v.people.size) continue;
      for (const pid of v.people) mark(pid, "RepairShopr note");
      const ex = nt?.extra?.[tid];
      notedToday.push({ ticketId: Number(tid), people: [...v.people], others: [...v.others].map(rsName),
        ticket: ex ? { num: ex.num, subject: ex.subject, customer: ex.customer, status: ex.status,
                       assignedTo: ex.rsUserId != null ? (personByRsUser.get(String(ex.rsUserId)) || null) : null } : null });
    }
  } catch (e) { console.warn("notes today", e.message); }
  for (const r of appNoteRows) mark(r.person_id, "note");
  for (const [pid, p] of Object.entries(personToday)) if (p.spentSec > 0 || p.runningSince) mark(pid, "timer");
  for (const c of completionBy.values()) for (const sh of c.shares) mark(sh.personId, "credit");
  for (const r of diagCreditRows) mark(r.person_id, "credit");
  for (const r of refurbDoneRows) mark(r.person_id, "refurb");
  const mc = moneyCache[0]?.value;
  if (mc?.day === t0) for (const i of mc.invoices || []) mark(i.userId != null ? personByRsUser.get(String(i.userId)) : null, "invoice");
  mark(me.id, "logged in");

  // 💰 Today's money (Team tab): payments received + invoiced, split by who created each invoice.
  let money = null;
  if (settings.showMoney) try {
    const m = (await getMoney({ force, maxWaitMs: force ? 6000 : 2500 })).value;
    if (m && m.day === t0) {
      const nameOfRs = uid => {
        const pid = uid != null ? personByRsUser.get(String(uid)) : null;
        if (pid) return { personId: pid, name: peopleRows.find(p => p.id === pid)?.name || pid };
        const u = rsUsers.find(x => String(x.id) === String(uid));
        return { personId: null, name: u ? u.name : (uid != null ? `RS user ${uid}` : "Unknown") };
      };
      const byMethod = {}, byWho = {};
      for (const p of m.payments) byMethod[p.method] = (byMethod[p.method] || 0) + p.amount;
      // Credit: whoever the invoice's ticket is assigned to; no ticket (or unassigned ticket) → invoice creator.
      for (const i of m.invoices) {
        const w = nameOfRs(i.ticketId != null && i.ticketUserId != null ? i.ticketUserId : i.userId), k = w.personId || w.name;
        (byWho[k] ||= { ...w, total: 0, subtotal: 0, count: 0 });
        byWho[k].total += i.total; byWho[k].subtotal += i.subtotal; byWho[k].count++;
      }
      money = {
        paymentsTotal: m.payments.reduce((a, p) => a + p.amount, 0), paymentsCount: m.payments.length, paymentsError: m.paymentsError || null,
        byMethod: Object.entries(byMethod).map(([method, amount]) => ({ method, amount })).sort((a, b) => b.amount - a.amount),
        invoicedTotal: m.invoices.reduce((a, i) => a + i.total, 0), invoicedSubtotal: m.invoices.reduce((a, i) => a + i.subtotal, 0),
        invoicedTax: m.invoices.reduce((a, i) => a + i.tax, 0), invoiceCount: m.invoices.length,
        byWho: Object.values(byWho).sort((a, b) => b.total - a.total),
      };
    }
  } catch (e) { console.warn("money", e.message); }

  let cardReaders = [], notifications = null, ccAuto = null;
  if (me.is_admin) {
    try { cardReaders = await namedReaders(); } catch {}
    try { ccAuto = { settings: await getAutoSettings(), webhook: await webhookInfo(), last: await lastAutoRun() }; } catch (e) { console.warn("cc auto", e.message); }
    try { notifications = await notificationsFor(me); } catch (e) { console.warn("notifications", e.message); }
  }
  return {
    money,
    cardReaders,
    notifications,
    ccAuto,
    me: me.id,
    today: t0,
    serverNow: Date.now(),
    rsSubdomain: RS_SUBDOMAIN,
    rsError,
    people: peopleRows.map(p => ({
      id: p.id, name: p.name, initials: p.initials, color: p.color, isAdmin: p.is_admin,
      positions: p.positions || [],
      defaultPosition: (p.positions || []).includes(p.default_position) ? p.default_position : ((p.positions || [])[0] || null),
      rsUserId: p.rs_user_id != null ? Number(p.rs_user_id) : null,
      hasPin: !!p.pin_hash, active: p.active, hasKey: !!p.rs_api_key_enc,
      ...(me.is_admin ? { keyLast4: p.rs_api_key_last4 || null, keyOwner: p.rs_api_key_owner || null } : {}),
    })),
    attendance: attendanceRows.map(a => ({ personId: a.person_id, position: a.position })),
    settings,
    tickets,
    personToday,
    notedToday,
    refurbs: myRefurbRows.map(r => ({
      id: Number(r.id), label: r.label, issueType: r.issue_type, subtype: r.subtype, model: r.model, repairs: r.repairs || [],
      state: r.state, bookMinutes: r.book_minutes, doneAt: ms(r.done_at), createdAt: ms(r.created_at),
      timerState: r.timer_state || "idle", runningSince: ms(r.running_since), spentSec: r.spent || 0,
    })),
    activeToday: Object.fromEntries(Object.entries(activeToday).map(([k, v]) => [k, [...v]])),
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

// Close out the app's own (local) timer on a ticket — used when RepairShopr's timer takes over.
async function settleLocalTimers(me, { exceptTicket, onlyTicket, to }) {
  const t0 = today();
  await db().begin(async tx => {
    const rows = await tx`select ticket_id from timers where person_id = ${me.id} and state = 'running' for update`;
    for (const r of rows) {
      const tid = Number(r.ticket_id);
      if (exceptTicket != null && tid === exceptTicket) continue;
      if (onlyTicket != null && tid !== onlyTicket) continue;
      await finalizeRunning(tx, tid, me.id, t0);
      await tx`update timers set state = ${to}, running_since = null where ticket_id = ${tid} and person_id = ${me.id}`;
    }
  });
}

async function timerAction(me, { ticketId, action }) {
  if (!["start", "pause", "stop"].includes(action)) throw new HttpError(400, "Bad timer action");
  if (Number(ticketId) < 0) return refurbTimer(me, Number(ticketId), action);
  const id = ticketIdOf(ticketId);
  const myKey = keyFor(me);
  if (myKey && me.rs_user_id != null) {
    // RepairShopr's timer is the real one: drive it with this person's key.
    await rsTimerAction(me, myKey, id, action);
    if (action === "start") await settleLocalTimers(me, { to: "paused" });                 // nothing else may run
    else await settleLocalTimers(me, { onlyTicket: id, to: action === "stop" ? "logged" : "paused" });
    if (action === "stop") await db()`update timers set state = 'logged' where ticket_id = ${id} and person_id = ${me.id} and state = 'paused'`;
    return { ok: true, rs: true };
  }
  return localTimer(me, id, action);
}
// The app's own timer (people without a key, and every refurb). One running timer per person.
async function localTimer(me, id, action) {
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
// (Nothing is pushed to RepairShopr's timer. If the admin setting is on, a private note records it.)
async function manualTime(me, { ticketId, minutes }) {
  const isRefurb = Number(ticketId) < 0;
  const id = isRefurb ? Number(ticketId) : ticketIdOf(ticketId);
  if (isRefurb) await myRefurb(me, -id);
  const target = Math.round(Number(minutes) * 60);
  if (!Number.isFinite(target) || target < 0 || target > 24 * 3600) throw new HttpError(400, "Enter minutes between 0 and 1440");
  const t0 = today();
  const myKey = isRefurb ? null : keyFor(me);
  // Stop my RepairShopr timer on this ticket first, so its time is final.
  if (myKey && me.rs_user_id != null) { try { await rsTimerAction(me, myKey, id, "stop"); } catch (e) { console.warn("rs stop", e.message); } }
  const [{ rsSec }] = me.rs_user_id != null && !isRefurb
    ? await db()`select coalesce(sum(seconds),0)::int as "rsSec" from rs_timers where ticket_id = ${id} and rs_user_id = ${me.rs_user_id}`
    : [{ rsSec: 0 }];
  await db().begin(async tx => {
    await tx`insert into timers (ticket_id, person_id) values (${id}, ${me.id}) on conflict do nothing`;
    await tx`select 1 from timers where ticket_id = ${id} and person_id = ${me.id} for update`;
    const [{ s }] = await tx`select coalesce(sum(seconds),0)::int as s from time_entries where ticket_id = ${id} and person_id = ${me.id}`;
    const delta = target - (s + rsSec);  // running segment is discarded: the typed number IS the total
    if (delta !== 0) await tx`insert into time_entries (ticket_id, person_id, work_date, seconds, kind) values (${id}, ${me.id}, ${t0}, ${delta}, 'manual')`;
    await tx`update timers set state = 'logged', running_since = null where ticket_id = ${id} and person_id = ${me.id}`;
  });
  const [note] = await db()`select value from settings where key = 'manual_time_note'`;
  if (note?.value === true && !isRefurb) {
    try { await postComment(id, me.name, `${me.name} reports spending ${Math.round(target / 60)} minutes on this ticket (entered in the ticket tracker).`, myKey); }
    catch (e) { console.warn("manual-time note", e.message); }
  }
  return { ok: true };
}

async function recomputeCredits(tx, ticketId) {
  const [s] = await tx`select * from ticket_state where ticket_id = ${ticketId}`;
  const bookTimes = (await tx`select value from settings where key = 'book_times'`)[0]?.value || {};
  const dev = effectiveDevice(s?.rs_problem_type, s);
  const rows = await tx`select id, outcome from work_log where ticket_id = ${ticketId} and work_date = ${today()} and outcome <> 'diagnosis_completed'`;
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
    await postComment(id, me.name, body, keyFor(me));
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
  await assignTicket(id, rsUserId, keyFor(me));
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
  await setTicketIssueType(id, issueType, keyFor(me));
  await patchCachedTicket(id, { issueType });
  await db().begin(async tx => {
    await tx`insert into ticket_state (ticket_id, rs_problem_type) values (${id}, ${issueType})
             on conflict (ticket_id) do update set rs_problem_type = excluded.rs_problem_type,
               device_category = null, device_subtype = null, device_row = null, repair_type = null, updated_at = now()`;
    await recomputeCredits(tx, id);
  });
  return { ok: true };
}

// Set how a completed ticket's credit is split. Only the PRIMARY (or an admin) can do this. shares =
// [{ personId, pct }] in whole percents summing to 100; primary = who owns it from now on. Changing the
// primary also re-assigns the ticket to that person in RepairShopr.
async function setCredit(me, { ticketId, shares, primary }) {
  const id = ticketIdOf(ticketId);
  const t0 = today();
  const sql = db();
  const list = (Array.isArray(shares) ? shares : []).map(x => ({ personId: String(x.personId || ""), pct: Math.round(Number(x.pct)) }))
    .filter(x => x.personId && x.pct > 0);
  const merged = new Map();
  for (const x of list) merged.set(x.personId, (merged.get(x.personId) || 0) + x.pct);
  const total = [...merged.values()].reduce((a, b) => a + b, 0);
  if (merged.size && total !== 100) throw new HttpError(400, `Shares must add up to 100% (they add up to ${total}%)`);
  const [c] = await sql`select * from completions where ticket_id = ${id} and work_date = ${t0}`;
  if (!c) throw new HttpError(404, "That ticket isn't completed today");
  // Primary: as given; else keep the current primary if they still have a share; else the biggest share.
  let newPrimary = null;
  if (merged.size) {
    const biggest = [...merged].sort((a, b) => b[1] - a[1])[0][0];
    newPrimary = primary ? String(primary) : (merged.has(c.primary_person) ? c.primary_person : biggest);
    if (!merged.has(newPrimary)) throw new HttpError(400, "The primary has to be one of the people getting credit");
  }
  const owner = c.primary_person || c.assigned_person;
  if (!me.is_admin && owner !== me.id) throw new HttpError(403, "Only the primary on this ticket (or an admin) can change its credit");
  const people = new Map((await sql`select id, name, rs_user_id from people where active`).map(r => [r.id, r]));
  for (const pid of merged.keys()) if (!people.has(pid)) throw new HttpError(400, `Unknown person: ${pid}`);

  // New primary → re-assign the ticket in RepairShopr first (if that fails, nothing changes).
  if (newPrimary && newPrimary !== c.primary_person) {
    const p = people.get(newPrimary);
    if (p.rs_user_id == null) throw new HttpError(400, `${p.name} isn't linked to a RepairShopr user yet (Admin Console → Users)`);
    await assignTicket(id, Number(p.rs_user_id), keyFor(me));
    await patchCachedTicket(id, { rsUserId: Number(p.rs_user_id) });
    await sql`update ticket_state set rs_user_id = ${Number(p.rs_user_id)} where ticket_id = ${id}`;
  }
  await sql.begin(async tx => {
    await tx`delete from credit_shares where ticket_id = ${id} and work_date = ${t0}`;
    const rows = [...merged].map(([person_id, pct]) => ({ ticket_id: id, work_date: t0, person_id, pct }));
    if (rows.length) await tx`insert into credit_shares ${tx(rows, "ticket_id", "work_date", "person_id", "pct")}`;
    await tx`update completions set primary_person = ${newPrimary} where ticket_id = ${id} and work_date = ${t0}`;
  });
  return { ok: true, reassigned: !!newPrimary && newPrimary !== c.primary_person };
}

// Answer the "Is the diagnosis 100% completed?" question.
//  complete = false            → question goes away; diagnosis can still be claimed later (next queue → diagnosis move).
//  complete = true, big = true  → diagnosis credit = the ticket's Diagnostics book time (30m).
//  complete = true, big = false → diagnosis credit taken but worth 0m (repair credit still counts when resolved).
// Diagnosis can only ever be claimed ONCE per ticket — any person, any day.
async function answerDiagnosis(me, { ticketId, complete, bigRepair }) {
  const id = ticketIdOf(ticketId);
  const t0 = today();
  return db().begin(async tx => {
    const [pr] = await tx`select * from diag_prompts where ticket_id = ${id} and state = 'pending' for update`;
    if (!pr) throw new HttpError(404, "There's no diagnosis question open for this ticket");
    if (pr.person_id !== me.id && !me.is_admin) throw new HttpError(403, "That question belongs to whoever had the ticket");
    if (!complete) {
      await tx`update diag_prompts set state = 'declined', answered_at = now() where id = ${pr.id}`;
      return { ok: true, claimed: false };
    }
    await tx`insert into ticket_state (ticket_id) values (${id}) on conflict do nothing`;
    const [ts] = await tx`select * from ticket_state where ticket_id = ${id} for update`;
    if (ts.diagnosis_locked) {
      await tx`update diag_prompts set state = 'declined', answered_at = now() where id = ${pr.id}`;
      throw new HttpError(409, "Diagnosis credit on this ticket was already claimed");
    }
    const bookTimes = (await tx`select value from settings where key = 'book_times'`)[0]?.value || {};
    const dev = effectiveDevice(ts.rs_problem_type, ts);
    const minutes = bigRepair ? (creditedMinutes(bookTimes, dev, "diagnosis_completed") || 30) : 0;
    await tx`update ticket_state set diagnosis_claimed_by = ${pr.person_id}, diagnosis_claimed_at = ${t0}, diagnosis_locked = true, updated_at = now() where ticket_id = ${id}`;
    await tx`insert into work_log (ticket_id, person_id, work_date, outcome, credited_minutes)
             values (${id}, ${pr.person_id}, ${t0}, 'diagnosis_completed', ${minutes})
             on conflict (ticket_id, person_id, work_date) do update set outcome = 'diagnosis_completed', credited_minutes = ${minutes}, logged_at = now()`;
    await tx`update diag_prompts set state = 'claimed', answered_at = now() where id = ${pr.id}`;
    return { ok: true, claimed: true, minutes };
  });
}

// Change a ticket's due DATE in RepairShopr (made with the logged-in person's key). The time of day it
// already had is kept; a ticket with no due date gets 5:00 PM.
async function setDueDate(me, { ticketId, day }) {
  const id = ticketIdOf(ticketId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || "")) || isNaN(Date.parse(day))) throw new HttpError(400, "Pick a valid date");
  const [cache] = await db()`select value from rs_cache where key = 'tickets'`;
  const t = cache?.value?.list?.find(x => x.id === id);
  const time = t?.dueAt ? shopTimeOfDay(t.dueAt) : "17:00:00";
  const iso = `${day}T${time}${shopOffset(day)}`;
  await setTicketDueDate(id, iso, keyFor(me));
  await patchCachedTicket(id, { dueDay: day, dueAt: iso });
  return { ok: true, dueDay: day };
}

/* ---------------- admin ---------------- */
// Reports tab: today's numbers are "live" (pulls RepairShopr first, within a few seconds); past days come from snapshots.
async function report(params) {
  const t0 = today();
  const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(v || "") && !isNaN(Date.parse(v));
  const from = isDay(params.get("from")) ? params.get("from") : t0;
  const to = isDay(params.get("to")) ? params.get("to") : from;
  if (from > to) throw new HttpError(400, "From must be before To");
  if ((Date.parse(to) - Date.parse(from)) / 86400e3 > 366) throw new HttpError(400, "Pick a range of a year or less");
  let warning = null;
  if (to >= t0) {
    const live = (async () => {
      const m = (await getMoney({ maxWaitMs: 5000 })).value;
      if (m?.day === t0) await syncInvoiceSnaps(m.invoices, { maxFetch: 8 });
    })();
    live.catch(e => { warning = `Couldn't refresh from RepairShopr: ${e.message}`; });
    await Promise.race([live.catch(() => {}), new Promise(r => setTimeout(r, 6000))]);
  }
  const r = await buildReport({ from, to: to > t0 ? t0 : to });
  let labor = null;
  try { const l = await laborProducts(); labor = { category: l.category, found: l.found, categories: l.categories, productCount: l.productIds.length }; }
  catch (e) { labor = { error: e.message }; }
  return { ...r, today: t0, labor, warning };
}
async function setLaborCategory({ name }) {
  const n = String(name || "").trim();
  if (!n || n.length > 80) throw new HttpError(400, "Enter a category name");
  await setSetting("labor_category", n);
  await invalidate("labor_products");
  try { const l = await laborProducts({ force: true }); return { ok: true, found: l.found, productCount: l.productIds.length, categories: l.categories }; }
  catch (e) { return { ok: true, error: e.message }; }
}
/* ---------------- 💳 card sales (Valor) ---------------- */
// Anyone who CAN work Sales / Float / Assistant Manager / Manager (whatever role they're in right now),
// or an admin. Only today + the previous business day.
const CARD_SALES_ROLES = ["Sales", "Float", "Assistant Manager", "Manager"];
async function canSeeCardSales(me) {
  return !!me.is_admin || (me.positions || []).some(p => CARD_SALES_ROLES.includes(p));
}
// What the Card sales tab needs to draw itself (no Valor call).
async function cardSalesInfo(me) {
  if (!(await canSeeCardSales(me))) throw new HttpError(403, "Card sales reports need the Sales, Float, Assistant Manager or Manager role (ask an admin)");
  const t0 = today();
  return { configured: valorConfigured(), today: t0, previous: previousBusinessDay(t0), readers: (await namedReaders()).map(r => ({ id: r.id, name: r.name })) };
}
// One report, pulled from Valor right now. reader = a reader id, or "all".
async function cardSales(me, params) {
  if (!(await canSeeCardSales(me))) throw new HttpError(403, "Card sales reports need the Sales, Float, Assistant Manager or Manager role (ask an admin)");
  const t0 = today(), prev = previousBusinessDay(t0);
  const day = params.get("day") || t0;
  if (day !== t0 && day !== prev) throw new HttpError(403, "Card sales can only be pulled for today and the previous business day");
  if (!valorConfigured()) throw new HttpError(400, "Valor isn't set up yet — add the VALOR_ keys in Netlify and redeploy");
  const readers = (await namedReaders()).map(r => ({ id: r.id, name: r.name }));
  const reader = params.get("reader") === "all" ? null : (readers.some(r => r.id === params.get("reader")) ? params.get("reader") : readers[0].id);
  let errors = [];
  if (day === t0) {
    const r = await syncCardSales({ maxAgeSec: 0, reader });
    errors = r.errors;
  } else {
    errors = await syncPastDay(day, reader);
  }
  const r = await cardSalesFor(day, reader);
  // Valor failed and the app has nothing saved for that day → say so instead of handing back an empty "$0.00" report.
  if (errors.length && !r.txns.length) throw new HttpError(502, errors.join(" · "));
  // 🔔 Let the admins know who pulled a report (and how often they've been doing it).
  try {
    const readerName = reader ? (readers.find(x => x.id === reader) || {}).name : "All readers";
    await db()`insert into notifications (kind, person_id, data) values ('cc_report', ${me.id}, ${db().json({ day, reader: readerName, position: (await db()`select position from attendance where person_id = ${me.id} and work_date = ${t0}`)[0]?.position || null })})`;
  } catch (e) { console.warn("notify", e.message); }
  return { today: t0, previous: prev, readers, reader, ...r, warning: errors.length ? errors.join(" · ") : null };
}

/* ---------------- 🔔 notifications (admins) ---------------- */
// Business days back from `day` (Sundays skipped) on which this person pulled a CC report, counting `day`.
function ccStreak(daysSet, day) {
  let n = 0, d = new Date(day + "T12:00:00Z");
  for (let i = 0; i < 60; i++) {
    if (d.getUTCDay() !== 0) { if (daysSet.has(d.toISOString().slice(0, 10))) n++; else break; }
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return n;
}
async function notificationsFor(me) {
  const sql = db();
  const rows = await sql`select n.*, p.name from notifications n left join people p on p.id = n.person_id order by n.id desc limit 40`;
  if (!rows.length) return { items: [], unread: 0 };
  // For CC report pulls: on how many days (shop time) has each person pulled one recently?
  const ccPeople = [...new Set(rows.filter(r => r.kind === "cc_report").map(r => r.person_id))];
  const hist = ccPeople.length ? await sql`select person_id, created_at from notifications where kind = 'cc_report' and person_id = any(${ccPeople})
                                           and created_at > now() - interval '45 days'` : [];
  const daysBy = {};
  for (const h of hist) (daysBy[h.person_id] ||= []).push({ day: shopDate(h.created_at), at: +new Date(h.created_at) });
  const items = rows.map(r => {
    const x = { id: Number(r.id), kind: r.kind, personId: r.person_id, name: r.name || r.person_id, at: ms(r.created_at), data: r.data || {}, mine: r.person_id === me.id };
    if (r.kind === "cc_report") {
      const upTo = (daysBy[r.person_id] || []).filter(h => h.at <= x.at);
      const days = new Set(upTo.map(h => h.day));
      x.streak = ccStreak(days, shopDate(r.created_at));                              // business days in a row
      x.last7 = [...days].filter(d => d > shopDate(new Date(x.at - 7 * 86400e3))).length; // distinct days in the last week
    }
    return x;
  });
  return { items, unread: items.filter(i => i.id > Number(me.notif_seen_id || 0) && !i.mine).length };
}
async function markNotificationsSeen(me, { upTo }) {
  const id = Math.max(0, Math.floor(Number(upTo) || 0));
  await db()`update people set notif_seen_id = greatest(notif_seen_id, ${id}) where id = ${me.id}`;
  return { ok: true };
}

async function setReaderName({ id, name }) {
  if (!valorReaders().some(r => r.id === String(id))) throw new HttpError(400, "That card reader isn't set up in Netlify");
  const sql = db();
  const [row] = await sql`select value from settings where key = 'card_reader_names'`;
  const names = { ...(row?.value || {}) };
  const n = String(name || "").trim().slice(0, 40);
  if (n) names[String(id)] = n; else delete names[String(id)];   // blank = back to the default name
  await setSetting("card_reader_names", names);
  return { ok: true, readers: await namedReaders() };
}

/* ---------------- refurbs (app-only) ---------------- */
async function myRefurb(me, refurbId) {
  const [r] = await db()`select * from refurbs where id = ${refurbId}`;
  if (!r) throw new HttpError(404, "That refurb doesn't exist anymore");
  if (r.person_id !== me.id && !me.is_admin) throw new HttpError(403, "That refurb belongs to someone else");
  return r;
}
async function refurbMinutes(r) {
  const bookTimes = (await db()`select value from settings where key = 'book_times'`)[0]?.value || {};
  const mapped = ISSUE_TYPE_TO_DEVICE[r.issue_type];
  if (!mapped || !r.model) return 0;
  const subtype = r.subtype && (r.subtype === mapped.subtype || (mapped.alt || []).includes(r.subtype)) ? r.subtype : mapped.subtype;
  const dev = { category: mapped.category, subtype, row: r.model };
  return (r.repairs || []).reduce((a, rt) => a + (repairMinutes(bookTimes, dev, rt) || 0), 0);
}
async function refurbAction(me, b) {
  const sql = db();
  const text = (v, n) => String(v ?? "").trim().slice(0, n);
  if (b.action === "create") {
    const [{ n }] = await sql`select count(*)::int as n from refurbs where person_id = ${me.id} and state = 'open'`;
    if (n >= 30) throw new HttpError(400, "You already have 30 open refurbs — finish or delete some first");
    const [r] = await sql`insert into refurbs (person_id, label) values (${me.id}, ${text(b.label, 80)}) returning id`;
    return { ok: true, id: Number(r.id) };
  }
  const r = await myRefurb(me, Number(b.id));
  if (b.action === "update") {
    if (r.state === "done") throw new HttpError(400, "Undo the completion before changing it");
    const issueType = b.issueType !== undefined ? (RS_ISSUE_TYPES.includes(b.issueType) ? b.issueType : null) : r.issue_type;
    const typeChanged = issueType !== r.issue_type;
    const model = b.model !== undefined ? (text(b.model, 120) || null) : (typeChanged ? null : r.model);
    const subtype = b.subtype !== undefined ? (text(b.subtype, 40) || null) : (typeChanged ? null : r.subtype);
    const repairs = b.repairs !== undefined ? [...new Set((Array.isArray(b.repairs) ? b.repairs : []).map(x => text(x, 80)).filter(Boolean))].slice(0, 12)
                                            : (typeChanged || model !== r.model ? [] : r.repairs);
    const label = b.label !== undefined ? text(b.label, 80) : r.label;
    await sql`update refurbs set label = ${label}, issue_type = ${issueType}, subtype = ${subtype}, model = ${model}, repairs = ${sql.json(repairs)} where id = ${r.id}`;
    return { ok: true };
  }
  if (b.action === "complete") {
    if (r.state === "done") return { ok: true };
    const minutes = await refurbMinutes(r);
    if (!r.model || !(r.repairs || []).length) throw new HttpError(400, "Pick the model and at least one repair first");
    await localTimer({ id: r.person_id }, -Number(r.id), "stop").catch(() => {});
    await sql`update refurbs set state = 'done', book_minutes = ${minutes}, done_at = now(), done_date = ${today()} where id = ${r.id}`;
    return { ok: true, minutes };
  }
  if (b.action === "reopen") {
    if (r.state !== "done") return { ok: true };
    if (r.done_date && dstr(r.done_date) !== today()) throw new HttpError(400, "Only today's completed refurbs can be undone");
    await sql`update refurbs set state = 'open', book_minutes = null, done_at = null, done_date = null where id = ${r.id}`;
    return { ok: true };
  }
  if (b.action === "delete") {
    if (r.state === "done") throw new HttpError(400, "Undo the completion before deleting it");
    await sql.begin(async tx => {
      await tx`delete from timers where ticket_id = ${-Number(r.id)}`;
      await tx`delete from time_entries where ticket_id = ${-Number(r.id)}`;
      await tx`delete from refurbs where id = ${r.id}`;
    });
    return { ok: true };
  }
  throw new HttpError(400, "Unknown refurb action");
}
async function refurbTimer(me, negId, action) {
  const r = await myRefurb(me, -negId);
  if (r.person_id !== me.id) throw new HttpError(403, "Only the person doing the refurb runs its timer");
  if (r.state === "done" && action === "start") throw new HttpError(400, "Undo the completion to start its timer again");
  if (action === "start") {
    // Never two timers: pause my RepairShopr timer if one is running (the app's own ones are paused by localTimer).
    const myKey = keyFor(me);
    if (myKey && me.rs_user_id != null) {
      try {
        const running = await listTimers({ user_id: me.rs_user_id, status: "running" }, { maxPages: 2, key: myKey });
        for (const t of running) await timerOp(t.id, "pause", myKey);
        if (running.length) await syncTimers(await db()`select * from people`).catch(() => {});
      } catch (e) { console.warn("refurb: pause RS timer", e.message); }
    }
  }
  return localTimer(me, negId, action);
}

async function setRoleGoal({ position, book, actual }) {
  if (!POSITIONS.includes(position)) throw new HttpError(400, "Unknown position");
  const mins = v => { const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < 0 || n > 1440) throw new HttpError(400, "Goals must be between 0 and 24 hours"); return n; };
  const sql = db();
  const [row] = await sql`select value from settings where key = 'role_goals'`;
  const goals = { ...(row?.value || {}) };
  goals[position] = book == null ? null : { book: mins(book), actual: mins(actual ?? book) };
  return setSetting("role_goals", goals);
}
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

// Save (or remove, key = null) a person's own RepairShopr API key. The key is checked with RS first:
// it has to work, and it has to belong to the RS user this person is linked to (or it links them).
async function setPersonKey({ personId, key }) {
  const sql = db();
  const [p] = await sql`select * from people where id = ${personId}`;
  if (!p) throw new HttpError(404, "Unknown person");
  const k = String(key || "").trim();
  if (!k) {
    await sql`update people set rs_api_key_enc = null, rs_api_key_last4 = null, rs_api_key_owner = null where id = ${p.id}`;
    return { ok: true, removed: true };
  }
  let who;
  try { who = await whoIsKey(k); }
  catch (e) { throw new HttpError(400, `RepairShopr didn't accept that key (${e.message.replace(/^RepairShopr /, "").slice(0, 120)})`); }
  if (p.rs_user_id != null && who.id != null && String(p.rs_user_id) !== String(who.id)) {
    throw new HttpError(400, `That key belongs to ${who.name} in RepairShopr, not ${p.name}. Check you copied the right key (or fix ${p.name}'s RepairShopr link first).`);
  }
  if (p.rs_user_id == null && who.id != null) {
    const [other] = await sql`select name from people where rs_user_id = ${who.id} and id <> ${p.id}`;
    if (other) throw new HttpError(400, `That key belongs to ${who.name} in RepairShopr, who is already ${other.name} in this app — not ${p.name}.`);
    await sql`update people set rs_user_id = ${who.id} where id = ${p.id}`;
  }
  await sql`update people set rs_api_key_enc = ${encryptSecret(k)}, rs_api_key_last4 = ${last4(k)}, rs_api_key_owner = ${who.name} where id = ${p.id}`;
  return { ok: true, owner: who.name };
}

// The default key (used for reading, and for anyone without their own key). key = null → go back to Netlify's RS_API_KEY.
async function setDefaultKey({ key }) {
  const sql = db();
  const k = String(key || "").trim();
  if (!k) {
    await sql`delete from settings where key = 'default_rs_api_key'`;
    forgetDefaultKey();
    return { ok: true, removed: true };
  }
  let who;
  try { who = await whoIsKey(k); }
  catch (e) { throw new HttpError(400, `RepairShopr didn't accept that key (${e.message.replace(/^RepairShopr /, "").slice(0, 120)})`); }
  const value = { enc: encryptSecret(k), last4: last4(k), owner: who.name };
  await sql`insert into settings (key, value) values ('default_rs_api_key', ${sql.json(value)}) on conflict (key) do update set value = excluded.value`;
  forgetDefaultKey();
  await invalidate("tickets");
  return { ok: true, owner: who.name };
}

async function keysInfo() {
  const [row] = await db()`select value from settings where key = 'default_rs_api_key'`;
  if (row) return { default: { source: "admin", last4: row.value.last4, owner: row.value.owner } };
  if (process.env.RS_API_KEY) {
    let owner = null;
    try { owner = (await whoIsKey(process.env.RS_API_KEY)).name; } catch {}
    return { default: { source: "netlify", last4: last4(process.env.RS_API_KEY), owner } };
  }
  return { default: { source: "none" } };
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
  if (b.defaultPosition !== undefined) {
    const cur = b.positions !== undefined ? (b.positions || []) : (p.positions || []);
    if (!cur.includes(b.defaultPosition)) throw new HttpError(400, "Pick one of their assigned positions as the default");
    await sql`update people set default_position = ${b.defaultPosition} where id = ${p.id}`;
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
