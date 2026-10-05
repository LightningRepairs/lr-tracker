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
async function cached(key, ttlSec, loader) {
  const sql = db();
  const [row] = await sql`select value, extract(epoch from now() - fetched_at) as age from rs_cache where key = ${key}`;
  if (row && Number(row.age) < ttlSec) return { value: row.value, fresh: false };
  const value = await loader();
  await sql`insert into rs_cache (key, value, fetched_at) values (${key}, ${sql.json(value)}, now())
            on conflict (key) do update set value = excluded.value, fetched_at = now()`;
  return { value, fresh: true };
}
export async function invalidate(key) { await db()`delete from rs_cache where key = ${key}`; }

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
async function fetchAllPages(basePath, maxPages) {
  const sep = basePath.includes("?") ? "&" : "?";
  const first = await rs(`${basePath}${sep}page=1`);
  const out = [...(first?.tickets || [])];
  const total = Math.min(first?.meta?.total_pages || 1, maxPages);
  const rest = [];
  for (let p = 2; p <= total; p++) rest.push(rs(`${basePath}${sep}page=${p}`));
  for (const r of await Promise.all(rest)) out.push(...(r?.tickets || []));
  return { tickets: out, meta: first?.meta || null };
}

/** Open tickets + tickets resolved today, normalized. Cached 45s. */
export async function getTickets({ force = false } = {}) {
  if (force) await invalidate("tickets");
  return cached("tickets", 45, async () => {
    const open = await fetchAllPages(`/tickets?status=${encodeURIComponent("Not Closed")}`, 40);
    let resolved = { tickets: [] };
    try {
      resolved = await fetchAllPages(`/tickets?status=Resolved&since_updated_at=${encodeURIComponent(startOfShopDayISO())}`, 4);
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
    return { list, openMeta: open.meta, sampleRaw: open.tickets[0] || null };
  });
}

/** RS users, cached 10 min. */
export async function getUsers() {
  const { value } = await cached("users", 600, async () => {
    const r = await rs(`/users`);
    const raw = r?.users || (Array.isArray(r) ? r : []);
    return raw.map(normUser).filter(u => u.id != null);
  });
  return value;
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
