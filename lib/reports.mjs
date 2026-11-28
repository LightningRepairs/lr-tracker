// Reports: per-person revenue / profit / labor (from invoices) and book vs actual time, by day.
import { db } from "./db.mjs";
import { rs, cached } from "./rs.mjs";
import { shopDate, today } from "./time.mjs";

/** First day money is counted per line-added-day. Earlier days keep the old per-invoice numbers. */
export async function lineCreditSince() {
  const sql = db();
  const [row] = await sql`select value from settings where key = 'line_credit_since'`;
  if (row?.value) return String(row.value);
  const t0 = today();
  await sql`insert into settings (key, value) values ('line_credit_since', ${sql.json(t0)}) on conflict (key) do nothing`;
  return t0;
}
const isDepositLine = (userId, name) => userId == null || /bench\s*fee/i.test(name || "");

const num = v => (v == null || v === "" ? 0 : Number(v) || 0);
const norm = s => String(s || "").trim().toLowerCase();
export const DEFAULT_LABOR_CATEGORY = "Repair Service";

/** Product ids that count as labor: everything in the labor category and all its subcategories. Cached 6h. */
export async function laborProducts({ force = false } = {}) {
  const sql = db();
  const [row] = await sql`select value from settings where key = 'labor_category'`;
  const catName = (row?.value || DEFAULT_LABOR_CATEGORY);
  return (await cached("labor_products", force ? 0 : 6 * 3600, async () => {
    const r = await rs(`/products/categories`);
    const cats = r?.categories || [];
    const roots = cats.filter(c => norm(c.name) === norm(catName));
    const rootIds = new Set(roots.map(c => String(c.id)));
    // RS "ancestry" is the chain of parent ids, e.g. "12/40" → a descendant of 12 and 40.
    const inTree = cats.filter(c => rootIds.has(String(c.id)) || String(c.ancestry || "").split("/").some(a => rootIds.has(a)));
    const ids = new Set();
    for (const c of inTree) {
      for (let page = 1; page <= 20; page++) {
        const pr = await rs(`/products?category_id=${c.id}&page=${page}`);
        for (const p of pr?.products || []) ids.add(String(p.id));
        if (!(pr?.products || []).length || page >= (pr?.meta?.total_pages || 1)) break;
      }
    }
    return { category: catName, found: roots.length > 0, categories: inTree.map(c => c.names_depth_cache || c.name), productIds: [...ids] };
  })).value;
}

/** Snapshot today's invoices (line items fetched once per invoice change; max `maxFetch` per pass). */
export async function syncInvoiceSnaps(invoices, { maxFetch = 12 } = {}) {
  const sql = db();
  if (!invoices?.length) return { fetched: 0 };
  let labor = null;
  try { labor = await laborProducts(); } catch (e) { console.warn("labor products", e.message); }
  const laborSet = new Set(labor?.productIds || []);
  const ids = invoices.map(i => i.id);
  const have = new Map((await sql`select invoice_id, rs_updated_at, lines_ok, lines_v from invoice_snap where invoice_id = any(${ids}::bigint[])`)
    .map(r => [String(r.invoice_id), r]));
  const since = await lineCreditSince();
  const owner = i => (i.ticketId != null && i.ticketUserId != null ? i.ticketUserId : i.userId) ?? null;
  // Cheap fields every pass (invoice_snap = "which invoices we've read, and when"). day = the invoice's own date.
  for (const i of invoices) {
    await sql`insert into invoice_snap (invoice_id, day, number, ticket_id, creator_rs_user, owner_rs_user, subtotal, tax, total, legacy)
              values (${i.id}, ${i.date || today()}, ${i.number || null}, ${i.ticketId}, ${i.userId}, ${owner(i)}, ${i.subtotal}, ${i.tax}, ${i.total}, false)
              on conflict (invoice_id) do update set number = excluded.number, ticket_id = excluded.ticket_id,
                creator_rs_user = excluded.creator_rs_user, owner_rs_user = excluded.owner_rs_user, subtotal = excluded.subtotal,
                tax = excluded.tax, total = excluded.total, fetched_at = now()`;
  }
  // Line items only when the invoice changed since we last read it.
  const need = invoices.filter(i => { const h = have.get(String(i.id)); return !h || !h.lines_ok || (h.lines_v || 1) < 3 || (i.updatedAt && +new Date(h.rs_updated_at) !== +new Date(i.updatedAt)); }).slice(0, maxFetch);
  let fetched = 0;
  while (need.length) {
    await Promise.all(need.splice(0, 4).map(async i => {
      try {
        const r = await rs(`/invoices/${i.id}`);
        const inv = r?.invoice || r;
        const raw = inv?.line_items || [];
        const lines = raw.map(l => ({
          name: l.name || l.item || "", productId: l.product_id ?? null, qty: num(l.quantity), price: num(l.price), cost: num(l.cost),
          userId: l.user_id ?? null,   // who added this line (null for system lines like Bench Fee)
          labor: l.product_id != null && laborSet.has(String(l.product_id)),
        }));
        // Per line, on the day it was ADDED. Lines added before line-crediting started stay with the old per-invoice numbers.
        await sql.begin(async tx => {
          const keep = [];
          for (const l of raw) {
            if (l.id == null) continue;
            const created = l.created_at || inv?.created_at || null;
            const day = created ? shopDate(created) : today();
            if (day < since) continue;
            keep.push(l.id);
            const name = l.name || l.item || "", uid = l.user_id ?? null;
            await tx`insert into invoice_lines (line_id, invoice_id, ticket_id, day, user_id, name, product_id, qty, price, cost, labor, deposit, created_at, updated_at)
                     values (${l.id}, ${i.id}, ${inv?.ticket_id ?? i.ticketId ?? null}, ${day}, ${uid}, ${name}, ${l.product_id ?? null}, ${num(l.quantity)}, ${num(l.price)}, ${num(l.cost)},
                             ${l.product_id != null && laborSet.has(String(l.product_id))}, ${isDepositLine(uid, name)}, ${created}, ${l.updated_at || null})
                     on conflict (line_id) do update set invoice_id = excluded.invoice_id, ticket_id = excluded.ticket_id, user_id = excluded.user_id, name = excluded.name,
                       product_id = excluded.product_id, qty = excluded.qty, price = excluded.price, cost = excluded.cost, labor = excluded.labor,
                       deposit = excluded.deposit, updated_at = excluded.updated_at`;
          }
          // A line removed from the invoice in RepairShopr stops counting.
          await tx`delete from invoice_lines where invoice_id = ${i.id} and day >= ${since} and not (line_id = any(${keep}::bigint[]))`;
        });
        const cost = lines.reduce((a, l) => a + l.cost * l.qty, 0);
        const laborAmount = lines.filter(l => l.labor).reduce((a, l) => a + l.price * l.qty, 0);
        const laborQty = lines.filter(l => l.labor).reduce((a, l) => a + l.qty, 0);
        await sql`update invoice_snap set lines = ${sql.json(lines)}, cost = ${cost}, labor_amount = ${laborAmount}, labor_qty = ${laborQty},
                    lines_ok = true, lines_v = 3, rs_updated_at = ${inv?.updated_at || i.updatedAt}, subtotal = ${num(inv?.subtotal ?? i.subtotal)},
                    tax = ${num(inv?.tax ?? i.tax)}, total = ${num(inv?.total ?? i.total)} where invoice_id = ${i.id}`;
        fetched++;
      } catch (e) { console.warn("invoice lines", i.id, e.message); }
    }));
  }
  return { fetched };
}

/** Split one saved invoice into per-person parts: each line counts at its own amount (price × qty) for whoever added it.
 *  Bench fees (and any line with no one recorded) are deposits, not services — they count for NO ONE. */
const isDeposit = l => l.userId == null || /bench\s*fee/i.test(l.name || "");
export function splitInvoice(i, subtotal) {
  const fallback = i.owner_rs_user ?? i.creator_rs_user ?? null;
  const lines = Array.isArray(i.lines) ? i.lines : [];
  if (!(i.lines_ok && (i.lines_v || 1) >= 2 && lines.length)) {   // older snapshot without line authors → whole invoice
    return [{ uid: fallback, revenue: subtotal, cost: num(i.cost), labor: num(i.labor_amount), laborQty: num(i.labor_qty) }];
  }
  const parts = {};
  for (const l of lines) {
    if (isDeposit(l)) continue;
    const uid = l.userId, key = String(uid);
    const p = (parts[key] ||= { uid, revenue: 0, cost: 0, labor: 0, laborQty: 0 });
    p.revenue += l.price * l.qty; p.cost += l.cost * l.qty;
    if (l.labor) { p.labor += l.price * l.qty; p.laborQty += l.qty; }
  }
  return Object.values(parts);
}

const dayList = (from, to) => { const out = []; for (let d = new Date(from + "T12:00:00Z"); shopDate(d) <= to && out.length < 400; d = new Date(+d + 86400e3)) out.push(d.toISOString().slice(0, 10)); return out; };

/**
 * Per day, per person: money (revenue, profit, labor) + time (book, actual) + tickets (resolved, total).
 * Money for RS users who aren't people in the app is listed under `others`.
 */
export async function buildReport({ from, to }) {
  const sql = db();
  const people = await sql`select id, name, rs_user_id, active from people order by sort, name`;
  const byRs = new Map(people.filter(p => p.rs_user_id != null).map(p => [String(p.rs_user_id), p.id]));
  const days = dayList(from, to);
  const blank = () => ({ revenue: 0, profit: 0, cost: 0, labor: 0, laborQty: 0, invoices: 0, bookSec: 0, actualSec: 0, resolved: 0, total: 0, pushed: 0, diagnosed: 0, tickets: new Set() });
  const out = Object.fromEntries(days.map(d => [d, { people: {}, others: {} }]));
  const cell = (d, pid) => (out[d].people[pid] ||= blank());

  const since = await lineCreditSince();
  const [inv, shares, diags, entries, timers, firstSnap] = await Promise.all([
    sql`select * from invoice_snap where day between ${from} and ${to} and day < ${since} and legacy`,   // days before line crediting started
    sql`select c.ticket_id, c.work_date, c.book_minutes, c.primary_person, s.person_id, s.pct from completions c
          join credit_shares s on s.ticket_id = c.ticket_id and s.work_date = c.work_date where c.work_date between ${from} and ${to}`,
    sql`select ticket_id, person_id, work_date, credited_minutes from work_log where outcome = 'diagnosis_completed' and work_date between ${from} and ${to}`,
    sql`select person_id, work_date, sum(seconds)::int as s from time_entries where work_date between ${from} and ${to} group by 1,2`,
    sql`select rs_user_id, start_time, seconds from rs_timers where start_time >= (${from}::date - 1) and start_time < (${to}::date + 2)`,
    sql`select coalesce((select min(day) from invoice_snap where legacy), ${since}::date) as d`,
  ]);
  const pushRows = await sql`select ticket_id, person_id, work_date from push_log where work_date between ${from} and ${to}`;
  const dkey = d => (typeof d === "string" ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10));
  const rsNames = Object.fromEntries((await sql`select value from rs_cache where key = 'users'`)[0]?.value?.map?.(u => [String(u.id), u.name]) || []);
  const cellFor = (d, uid) => {
    const pid = uid != null ? byRs.get(String(uid)) : null;
    return pid ? cell(d, pid) : (out[d].others[uid != null ? (rsNames[String(uid)] || `RS user ${uid}`) : "Unknown"] ||= blank());
  };
  for (const i of inv) {
    const d = dkey(i.day); if (!out[d]) continue;
    const sub = num(i.subtotal);
    // Per line: each line counts for whoever added it; lines with nobody recorded → the ticket's assignee
    // (else the invoice creator). Older snapshots without line authors count whole, as before.
    for (const part of splitInvoice(i, sub)) {
      const c = cellFor(d, part.uid);
      c.revenue += part.revenue; c.cost += part.cost; c.profit += part.revenue - part.cost;
      c.labor += part.labor; c.laborQty += part.laborQty;
      (c._inv ||= new Set()).add(String(i.invoice_id));
      if (!i.lines_ok) c.partial = true;
    }
  }
  // From line-crediting day on: each line counts on the day it was added, for whoever added it. Bench fees count for no one.
  const lineRows = await sql`select * from invoice_lines where day between ${from} and ${to} and day >= ${since} and not deposit`;
  for (const l of lineRows) {
    const d = dkey(l.day); if (!out[d]) continue;
    const c = cellFor(d, l.user_id), amt = num(l.price) * num(l.qty), cost = num(l.cost) * num(l.qty);
    c.revenue += amt; c.cost += cost; c.profit += amt - cost;
    if (l.labor) { c.labor += amt; c.laborQty += num(l.qty); }
    (c._inv ||= new Set()).add(String(l.invoice_id));
  }
  for (const d of days) for (const set of [out[d].people, out[d].others]) for (const c of Object.values(set)) if (c._inv) { c.invoices = c._inv.size; delete c._inv; }
  for (const r of shares) {
    const d = dkey(r.work_date); if (!out[d]) continue;
    const c = cell(d, r.person_id);
    c.bookSec += Math.round((r.book_minutes || 0) * 60 * r.pct / 100);
    c.tickets.add(String(r.ticket_id));
    if (r.primary_person === r.person_id) { c.resolved++; (c._pushed ||= new Set()).add(String(r.ticket_id)); }
    if (Number(r.ticket_id) < 0 && r.primary_person === r.person_id) c.refurbs = (c.refurbs || 0) + 1;
  }
  for (const r of diags) {
    const d = dkey(r.work_date); if (!out[d]) continue;
    const c = cell(d, r.person_id);
    c.bookSec += (r.credited_minutes || 0) * 60;
    c.tickets.add(String(r.ticket_id));
    c.diagnosed = (c.diagnosed || 0) + 1; (c._pushed ||= new Set()).add(String(r.ticket_id));
  }
  // Pushed = resolved + diagnosed + moved from the queue to a waiting status (each ticket once).
  for (const r of pushRows) { const d = dkey(r.work_date); if (out[d]) (cell(d, r.person_id)._pushed ||= new Set()).add(String(r.ticket_id)); }
  for (const r of entries) { const d = dkey(r.work_date); if (out[d]) cell(d, r.person_id).actualSec += r.s; }
  for (const r of timers) {
    const pid = r.rs_user_id != null ? byRs.get(String(r.rs_user_id)) : null;
    const d = r.start_time ? shopDate(r.start_time) : null;
    if (pid && d && out[d]) cell(d, pid).actualSec += r.seconds || 0;
  }
  for (const d of days) for (const set of [out[d].people, out[d].others]) for (const c of Object.values(set)) { c.total = c.tickets.size; delete c.tickets; c.pushed = c._pushed ? c._pushed.size : 0; delete c._pushed; c.diagnosed ||= 0; }
  return {
    from, to, days: days.map(d => ({ day: d, ...out[d] })),
    people: people.map(p => ({ id: p.id, name: p.name, active: p.active })),
    salesSince: firstSnap[0]?.d ? dkey(firstSnap[0].d) : null,
  };
}
