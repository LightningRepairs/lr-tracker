// RepairShopr API client (server side only — the API key never reaches the browser).
// Docs: https://api-docs.repairshopr.com  — auth is "Authorization: Bearer <key>".
import { db } from "./db.mjs";
import { shopDate, today, startOfShopDayISO } from "./time.mjs";
import { decryptSecret } from "./secrets.mjs";

export const RS_SUBDOMAIN = process.env.RS_SUBDOMAIN || "lightningrepair";
const BASE = process.env.RS_BASE_URL || `https://${RS_SUBDOMAIN}.repairshopr.com/api/v1`; // RS_BASE_URL: local testing only

export class RsError extends Error {}

// The DEFAULT key: the one saved in Admin Console → RepairShopr connection, or else Netlify's RS_API_KEY.
// Used for all reading, and for writes by anyone who doesn't have their own key.
let defaultKeyCache = { at: 0, key: null };
export function forgetDefaultKey() { defaultKeyCache = { at: 0, key: null }; }
export async function defaultKey() {
  if (Date.now() - defaultKeyCache.at < 30000) return defaultKeyCache.key;
  let key = null;
  try {
    const [row] = await db()`select value from settings where key = 'default_rs_api_key'`;
    key = row ? decryptSecret(row.value.enc) : null;
  } catch {}
  key = key || process.env.RS_API_KEY || null;
  defaultKeyCache = { at: Date.now(), key };
  return key;
}

// `key` = a specific person's API key (so RepairShopr records the change as them); omitted = default key.
export async function rs(path, { method = "GET", body, key } = {}) {
  key = key || await defaultKey();
  if (!key) throw new RsError("No RepairShopr API key — set the default key in Admin Console → RepairShopr connection (or RS_API_KEY in Netlify)");
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new RsError(`RepairShopr ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

// ---------- cache (rs_cache table) ----------
// Returns cached data if younger than ttlSec. Otherwise fetches — but if maxWaitMs is given and
// RepairShopr is slow, stops waiting and returns the older cached copy (marked stale) instead,
// so a page load never hangs on RepairShopr. (The scheduled refresh function keeps it current.)
const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function cached(key, ttlSec, loader, { maxWaitMs } = {}) {
  const sql = db();
  const [row] = await sql`select value, extract(epoch from now() - fetched_at)::int as age from rs_cache where key = ${key}`;
  if (row && ttlSec > 0 && row.age < ttlSec) return { value: row.value, fresh: false, ageSec: row.age };
  const job = (async () => {
    const value = await loader();
    await sql`insert into rs_cache (key, value, fetched_at) values (${key}, ${sql.json(value)}, now())
              on conflict (key) do update set value = excluded.value, fetched_at = now()`;
    return value;
  })();
  job.catch(() => {}); // handled below; avoids unhandled-rejection noise if we stop waiting
  let outcome;
  try {
    outcome = await (maxWaitMs ? Promise.race([job.then(v => ({ v })), sleep(maxWaitMs).then(() => null)]) : job.then(v => ({ v })));
  } catch (e) {
    if (row) return { value: row.value, fresh: false, ageSec: row.age, stale: true, error: e.message };
    throw e;
  }
  if (outcome) return { value: outcome.v, fresh: true, ageSec: 0 };
  if (row) return { value: row.value, fresh: false, ageSec: row.age, stale: true, error: `RepairShopr took longer than ${maxWaitMs / 1000}s to answer` };
  throw new RsError(`RepairShopr took longer than ${maxWaitMs / 1000}s to answer — tickets will appear once the background refresh finishes (within a minute)`);
}
export async function invalidate(key) { await db()`delete from rs_cache where key = ${key}`; }

/** After we change a ticket in RS (e.g. assign), patch our cached copy instead of re-pulling everything. */
export async function patchCachedTicket(ticketId, patch) {
  await db().begin(async tx => {
    const [row] = await tx`select value from rs_cache where key = 'tickets' for update`;
    if (!row) return;
    const t = (row.value.list || []).find(x => x.id === ticketId);
    if (!t) return;
    Object.assign(t, patch);
    await tx`update rs_cache set value = ${tx.json(row.value)} where key = 'tickets'`;
  });
}

// ---------- normalizers (defensive — field names confirmed where noted) ----------
export function normTicket(t) {
  return {
    id: t.id,                                   // internal id (used in RS URLs) — confirmed
    num: t.number,                              // public ticket number — confirmed
    subject: t.subject || "(no subject)",
    status: t.status || "",
    issueType: t.problem_type || null,          // RS "Issue Type" field
    rsUserId: t.user_id ?? t.user?.id ?? null,  // assigned tech
    customer: t.customer_business_then_name || t.customer?.business_then_name || t.customer?.fullname || "",
    updatedAt: t.updated_at || null,
    resolvedAt: t.resolved_at || null,          // set by RS when the ticket goes to Resolved
    dueDay: t.due_date ? shopDate(t.due_date) : null, // YYYY-MM-DD in shop time (day only — time of day ignored)
    dueAt: t.due_date || null,
    createdAt: t.created_at || null,
  };
}
export function normUser(u) {
  if (Array.isArray(u)) return { id: u[0], name: String(u[1] ?? "") };          // /users returns [id, name] pairs
  return { id: u.id, name: u.full_name || [u.firstname, u.lastname].filter(Boolean).join(" ") || u.email || `User ${u.id}` };
}

// ---------- tickets ----------
// Page 1 first (to learn how many pages), then the rest 4 at a time so RS isn't hit all at once.
async function fetchAllPages(basePath, maxPages) {
  const sep = basePath.includes("?") ? "&" : "?";
  const first = await rs(`${basePath}${sep}page=1`);
  const out = [...(first?.tickets || [])];
  const total = Math.min(first?.meta?.total_pages || 1, maxPages);
  const pages = [];
  for (let p = 2; p <= total; p++) pages.push(p);
  while (pages.length) {
    const batch = pages.splice(0, 4);
    for (const r of await Promise.all(batch.map(p => rs(`${basePath}${sep}page=${p}`)))) out.push(...(r?.tickets || []));
  }
  return { tickets: out, meta: first?.meta || null };
}

async function loadTickets() {
  const started = Date.now();
  const open = await fetchAllPages(`/tickets?status=${encodeURIComponent("Not Closed")}`, 20);
  let resolved = { tickets: [] };
  try {
    resolved = await fetchAllPages(`/tickets?status=Resolved&resolved_after=${encodeURIComponent(startOfShopDayISO())}`, 4);
  } catch (e) { /* non-fatal: we just won't show resolved-today tickets */ }
  const t0 = today();
  const resolvedToday = resolved.tickets.filter(t => t.resolved_at && shopDate(t.resolved_at) === t0);
  const seen = new Set();
  const list = [];
  for (const t of [...open.tickets, ...resolvedToday]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    list.push(normTicket(t));
  }
  return { list, openMeta: open.meta, sampleRaw: open.tickets[0] || null, fetchMs: Date.now() - started };
}

/** Open tickets + tickets resolved today, normalized. Page loads re-pull it once it's 20s old (the every-minute job also renews it). */
export const FRESH_SEC = 20;
export async function getTickets({ force = false, maxWaitMs } = {}) {
  // force = fetch now, but keep the old copy as a fallback if RS fails
  return cached("tickets", force ? 0 : FRESH_SEC, loadTickets, { maxWaitMs });
}

// ---------- money: today's payments + invoices ----------
// Neither endpoint has a "today" filter, so we read from the newest backwards until we're past today.
const num = v => (v == null || v === "" ? 0 : Number(v) || 0);
async function todaysPayments(t0) {
  const out = [];
  for (let page = 1; page <= 8; page++) {
    const r = await rs(`/payments?page=${page}`);
    const list = r?.payments || [];
    const dayOf = p => shopDate(p.applied_at && /^\d{4}-\d{2}-\d{2}$/.test(p.applied_at) ? p.applied_at + "T12:00:00Z" : (p.applied_at || p.created_at));
    const today = list.filter(p => dayOf(p) === t0);
    out.push(...today);
    // stop once a whole page is older than today (newest-first), or we ran out
    if (!list.length || list.every(p => dayOf(p) < t0) || page >= (r?.meta?.total_pages || 1)) break;
  }
  return out.map(p => ({ id: p.id, amount: num(p.payment_amount), method: p.payment_method || "Other", customer: p.customer?.fullname || p.customer?.business_then_name || "" }));
}
async function todaysInvoices(t0) {
  const out = [];
  for (let page = 1; page <= 8; page++) {
    const r = await rs(`/invoices?since_updated_at=${encodeURIComponent(startOfShopDayISO())}&page=${page}`);
    const list = r?.invoices || [];
    out.push(...list.filter(i => (i.date ? String(i.date).slice(0, 10) : shopDate(i.created_at)) === t0));
    if (!list.length || page >= (r?.meta?.total_pages || 1)) break;
  }
  return out.map(i => ({ id: i.id, number: i.number, total: num(i.total), subtotal: num(i.subtotal), tax: num(i.tax), userId: i.user_id ?? null, ticketId: i.ticket_id ?? null }));
}
// Who each invoice's ticket is assigned to. Open + resolved-today tickets come from the tickets cache;
// older tickets invoiced today are looked up one by one (max 15 per pass) and remembered for the day.
async function invoiceTicketOwners(invoices, t0) {
  const sql = db();
  const [tc] = await sql`select value from rs_cache where key = 'tickets'`;
  const [mc] = await sql`select value from rs_cache where key = 'money'`;
  const fromList = new Map((tc?.value?.list || []).map(t => [String(t.id), t.rsUserId ?? null]));
  const remembered = mc?.value?.day === t0 ? (mc.value.extraOwners || {}) : {};
  const extraOwners = {};
  const missing = [];
  for (const i of invoices) {
    if (i.ticketId == null) continue;
    const k = String(i.ticketId);
    if (fromList.has(k)) continue;
    if (k in remembered) extraOwners[k] = remembered[k]; else if (!missing.includes(k)) missing.push(k);
  }
  const lookups = missing.slice(0, 15);
  while (lookups.length) {
    await Promise.all(lookups.splice(0, 5).map(async k => {
      try { const r = await rs(`/tickets/${k}`); const t = r?.ticket || r; extraOwners[k] = t?.user_id ?? t?.user?.id ?? null; } catch { /* next pass */ }
    }));
  }
  for (const i of invoices) {
    if (i.ticketId == null) continue;
    const k = String(i.ticketId);
    i.ticketUserId = fromList.has(k) ? fromList.get(k) : (extraOwners[k] ?? null);
  }
  return extraOwners;
}
/** Today's payments + invoices; page loads re-pull once 20s old (the every-minute job keeps it fresh too). */
export async function getMoney({ force = false, maxWaitMs } = {}) {
  return cached("money", force ? 0 : FRESH_SEC, async () => {
    const t0 = today();
    const [payments, invoices] = await Promise.all([todaysPayments(t0), todaysInvoices(t0)]);
    const extraOwners = await invoiceTicketOwners(invoices, t0);
    return { day: t0, payments, invoices, extraOwners };
  }, { maxWaitMs });
}

/** RS users, cached 10 min. */
export async function getUsers({ force = false, maxWaitMs } = {}) {
  const r = await cached("users", force ? 0 : 600, async () => {
    const res = await rs(`/users`);
    const raw = res?.users || (Array.isArray(res) ? res : []);
    return raw.map(normUser).filter(u => u.id != null);
  }, { maxWaitMs });
  return r.value;
}

/** Times single calls to RS — for /api/health?rs=1. Returns counts/timing only, no ticket data. */
export async function probeRs() {
  const out = {};
  let t = Date.now();
  try {
    const r = await rs(`/tickets?status=${encodeURIComponent("Not Closed")}&page=1`);
    out.notClosedPage1 = { ms: Date.now() - t, ticketsOnPage: (r?.tickets || []).length, meta: r?.meta || null };
  } catch (e) { out.notClosedPage1 = { ms: Date.now() - t, error: e.message }; }
  t = Date.now();
  try {
    const r = await rs(`/users`);
    out.users = { ms: Date.now() - t, count: (r?.users || []).length };
  } catch (e) { out.users = { ms: Date.now() - t, error: e.message }; }
  return out;
}

/** A ticket's comments (for "left a note today"). Cached 60s per ticket. */
export async function getTicketComments(ticketId) {
  const { value } = await cached(`comments:${ticketId}`, 60, async () => {
    const r = await rs(`/tickets/${ticketId}`);
    const t = r?.ticket || r || {};
    return (t.comments || []).map(c => ({
      createdAt: c.created_at, userId: c.user_id ?? null, tech: c.tech || "", hidden: !!c.hidden,
    }));
  });
  return value;
}

export async function setTicketIssueType(ticketId, issueType, key) {
  return rs(`/tickets/${ticketId}`, { method: "PUT", body: { problem_type: issueType }, key });
}

export async function setTicketDueDate(ticketId, dueIso, key) {
  return rs(`/tickets/${ticketId}`, { method: "PUT", body: { due_date: dueIso }, key });
}

export async function assignTicket(ticketId, rsUserId, key) {
  return rs(`/tickets/${ticketId}`, { method: "PUT", body: { user_id: rsUserId }, key });
}

// ---------- RepairShopr ticket timers ----------
// A timer always belongs to whoever owns the key that started it.
export async function listTimers(params = {}, { maxPages = 8, key } = {}) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await rs(`/ticket_timers?${qs}${qs ? "&" : ""}page=${page}`, { key });
    out.push(...(r?.ticket_timers || []));
    if (!r?.meta || page >= (r.meta.total_pages || 1)) break;
  }
  return out;
}
export async function createTimer(ticketId, key) {        // starts (or resumes) MY timer on a ticket
  const r = await rs(`/ticket_timers`, { method: "POST", body: { ticket_id: ticketId }, key });
  return r?.ticket_timer || r;
}
export async function timerOp(timerId, op, key) {          // op: start | pause | stop
  const r = await rs(`/ticket_timers/${timerId}/${op}`, { method: "POST", key });
  return r?.ticket_timer || r;
}

/** Which RepairShopr user an API key belongs to. */
export async function whoIsKey(key) {
  const r = await rs(`/me`, { key });
  return { id: r?.user_id ?? null, name: r?.user_name || r?.user_email || "Unknown user" };
}

/** Posts a private (hidden, not emailed) comment. `tech` is the name RS shows on the comment. */
export async function postComment(ticketId, techName, body, key) {
  return rs(`/tickets/${ticketId}/comment`, {
    method: "POST",
    body: { subject: "Update", body, tech: techName, hidden: true, do_not_email: true },
    key,
  });
}
