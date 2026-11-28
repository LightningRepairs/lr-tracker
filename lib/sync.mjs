// Pulls tickets + users from RepairShopr (through the cache), links people to RS users by name,
// and records who's assigned to what today. Used by page loads (with short time budgets) and by
// the scheduled background refresh (no budget).
import { db } from "./db.mjs";
import { today, shopDate } from "./time.mjs";
import { getTickets, getUsers } from "./rs.mjs";
import { ensureSchema } from "./migrate.mjs";

export const DEFAULT_QUEUE_STATUSES = ["New", "In Progress", "Customer Reply", "Needs Parts Ordered", "Needs Called", "Waiting on Process"];

export async function syncFromRs({ force = false, ticketsWaitMs, usersWaitMs } = {}) {
  const sql = db();
  await ensureSchema();
  const t0 = today();
  const peopleRows = await sql`select * from people order by sort, name`;
  const [qs] = await sql`select value from settings where key = 'queue_statuses'`;
  const queueStatuses = qs?.value || DEFAULT_QUEUE_STATUSES;
  const [ds] = await sql`select value from settings where key = 'diagnosis_eligible_statuses'`;
  const diagStatuses = ds?.value || [];

  let rsError = null, list = [], fresh = false, ageSec = null, rsUsers = [], fetchMs = null;
  const [tr, ur] = await Promise.allSettled([
    getTickets({ force, maxWaitMs: ticketsWaitMs }),
    getUsers({ force, maxWaitMs: usersWaitMs }),
  ]);
  if (tr.status === "fulfilled") {
    list = tr.value.value.list || [];
    fresh = tr.value.fresh;
    ageSec = tr.value.ageSec;
    fetchMs = tr.value.value.fetchMs ?? null;
    if (tr.value.error) rsError = `${tr.value.error} — showing tickets from ${Math.round(ageSec / 60)} min ago`;
  } else rsError = tr.reason?.message || String(tr.reason);
  if (ur.status === "fulfilled") rsUsers = ur.value;
  else rsError = rsError || ur.reason?.message || String(ur.reason);

  // Auto-link people to RS users by exact (case-insensitive) full name, if not linked yet.
  const linked = new Set(peopleRows.filter(p => p.rs_user_id != null).map(p => String(p.rs_user_id)));
  for (const p of peopleRows) {
    if (p.rs_user_id != null) continue;
    const match = rsUsers.find(u => u.name.trim().toLowerCase() === p.name.trim().toLowerCase() && !linked.has(String(u.id)));
    if (match) {
      await sql`update people set rs_user_id = ${match.id} where id = ${p.id} and rs_user_id is null`;
      p.rs_user_id = match.id; linked.add(String(match.id));
    }
  }
  const personByRsUser = new Map(peopleRows.filter(p => p.rs_user_id != null).map(p => [String(p.rs_user_id), p.id]));
  if (fresh) await snapshotTickets(sql, list, personByRsUser, t0, queueStatuses, diagStatuses);
  return { peopleRows, list, rsUsers, rsError, personByRsUser, ageSec, fetchMs };
}

// Keep a last-seen copy of each RS ticket + today's assignee (RS only exposes the current one).
const norm = s => String(s || "").trim().toLowerCase();

async function snapshotTickets(sql, list, personByRsUser, t0, queueStatuses, diagStatuses = []) {
  if (!list.length) return;
  // Status each ticket had at the LAST check — so we can spot a move from the queue into a diagnosis status.
  const before = new Map((await sql`select ticket_id, rs_status, diagnosis_locked from ticket_state
                                     where ticket_id = any(${list.map(t => t.id)}::bigint[])`)
    .map(r => [Number(r.ticket_id), r]));
  const rows = list.map(t => ({
    ticket_id: t.id, rs_number: t.num ?? null, rs_subject: t.subject, rs_status: t.status,
    rs_problem_type: t.issueType, rs_user_id: t.rsUserId ?? null,
  }));
  await sql`
    insert into ticket_state ${sql(rows, "ticket_id", "rs_number", "rs_subject", "rs_status", "rs_problem_type", "rs_user_id")}
    on conflict (ticket_id) do update set
      rs_number = excluded.rs_number, rs_subject = excluded.rs_subject, rs_status = excluded.rs_status,
      rs_problem_type = excluded.rs_problem_type, rs_user_id = excluded.rs_user_id, rs_synced_at = now()`;
  const assigned = list
    .map(t => ({ ticket_id: t.id, person_id: personByRsUser.get(String(t.rsUserId)), work_date: t0 }))
    .filter(r => r.person_id);
  if (assigned.length) {
    await sql`insert into assignment_log ${sql(assigned, "ticket_id", "person_id", "work_date")} on conflict do nothing`;
  }
  // "Was in your queue today": assigned to you while in an in-the-queue status. Diagnosis credit
  // later requires this (the ticket then moving on to Awaiting Client / Awaiting Parts).
  const inQueue = new Set(queueStatuses);
  const queued = list
    .filter(t => inQueue.has(t.status))
    .map(t => ({ ticket_id: t.id, person_id: personByRsUser.get(String(t.rsUserId)), work_date: t0 }))
    .filter(r => r.person_id);
  if (queued.length) {
    await sql`insert into queue_log ${sql(queued, "ticket_id", "person_id", "work_date")} on conflict do nothing`;
  }
  // Diagnosis credit question: assigned ticket moved from an in-the-queue status into a diagnosis
  // status since the last check, and nobody has ever claimed diagnosis on it.
  const inQ = new Set(queueStatuses.map(norm)), inDiag = new Set(diagStatuses.map(norm));
  for (const t of list) {
    const prev = before.get(t.id);
    const person = personByRsUser.get(String(t.rsUserId));
    if (!prev || !person) continue;
    if (inQ.has(norm(prev.rs_status)) && inDiag.has(norm(t.status))) {
      await sql`insert into push_log (ticket_id, person_id, work_date, from_status, to_status)
                values (${t.id}, ${person}, ${t0}, ${prev.rs_status}, ${t.status}) on conflict do nothing`;
      if (prev.diagnosis_locked) continue;
      await sql`insert into diag_prompts (ticket_id, person_id, from_status, to_status)
                values (${t.id}, ${person}, ${prev.rs_status}, ${t.status})
                on conflict (ticket_id) where state = 'pending' do nothing`;
    }
  }
  // Completed today: resolved today → credit whoever it was assigned to at that moment (first time
  // we see it resolved; later reassignments don't move it — use the credit editor for that).
  const done = list.filter(t => t.status === "Resolved" && t.resolvedAt && shopDate(t.resolvedAt) === t0);
  for (const t of done) {
    const person = personByRsUser.get(String(t.rsUserId)) || null;
    const [row] = await sql`
      insert into completions (ticket_id, work_date, resolved_at, assigned_person, assigned_rs_user, primary_person)
      values (${t.id}, ${t0}, ${t.resolvedAt}, ${person}, ${t.rsUserId ?? null}, ${person})
      on conflict (ticket_id, work_date) do nothing
      returning ticket_id`;
    if (row && person) {
      await sql`insert into credit_shares (ticket_id, work_date, person_id, pct) values (${t.id}, ${t0}, ${person}, 100) on conflict do nothing`;
    }
  }
}
