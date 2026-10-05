// RepairShopr API client (server side only — the API key never reaches the browser).
// Docs: https://api-docs.repairshopr.com  — auth is "Authorization: Bearer <key>".
import { db } from "./db.mjs";
import { shopDate, today, startOfShopDayISO } from "./time.mjs";

export const RS_SUBDOMAIN = process.env.RS_SUBDOMAIN || "lightningrepair";
const BASE = process.env.RS_BASE_URL || `https://${RS_SUBDOMAIN}.repairshopr.com/api/v1`; // RS_BASE_URL: local testing only

export class RsError extends Error {}

export async function rs(path, { method = "GET", body } = {}) {
  const key = process.env.RS_API_KEY;
  if (!key) throw new RsError("RS_API_KEY is not set (Netlify → Site configuration → Environment variables)");
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
async function cached(key, ttlSec, loader, { maxWaitMs } = {}) {
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
    resolved = await fetchAllPages(`/tickets?status=Resolved&since_updated_at=${encodeURIComponent(startOfShopDayISO())}`, 2);
  } catch (e) { /* non-fatal: we just won't show resolved-today tickets */ }
  const t0 = today();
  const resolvedToday = resolved.tickets.filter(t => t.updated_at && shopDate(t.updated_at) === t0);
  const seen = new Set();
  const list = [];
  for (const t of [...open.tickets, ...resolvedToday]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    list.push(normTicket(t));
  }
  return { list, openMeta: open.meta, sampleRaw: open.tickets[0] || null, fetchMs: Date.now() - started };
}

/** Open tickets + tickets resolved today, normalized. Cached 90s (the scheduled refresh renews it every minute). */
export async function getTickets({ force = false, maxWaitMs } = {}) {
  // force = fetch now, but keep the old copy as a fallback if RS fails
  return cached("tickets", force ? 0 : 90, loadTickets, { maxWaitMs });
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

export async function setTicketIssueType(ticketId, issueType) {
  return rs(`/tickets/${ticketId}`, { method: "PUT", body: { problem_type: issueType } });
}

export async function assignTicket(ticketId, rsUserId) {
  return rs(`/tickets/${ticketId}`, { method: "PUT", body: { user_id: rsUserId } });
}

/** Posts a private (hidden, not emailed) comment. `tech` is the name RS shows on the comment. */
export async function postComment(ticketId, techName, body) {
  return rs(`/tickets/${ticketId}/comment`, {
    method: "POST",
    body: { subject: "Update", body, tech: techName, hidden: true, do_not_email: true },
  });
}
