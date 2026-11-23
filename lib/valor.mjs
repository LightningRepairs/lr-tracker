// Valor PayTech (card terminal) — today's card sales. SERVER ONLY: these keys can void/refund sales,
// so they live in Netlify env vars and never reach the browser. Nothing here sends card numbers or
// transaction ids to the browser.
import crypto from "node:crypto";
import { db } from "./db.mjs";
import { cached } from "./rs.mjs";
import { shopDate, today } from "./time.mjs";

const BASE = process.env.VALOR_BASE_URL || "https://securelink.valorpaytech.com/api/v1"; // VALOR_BASE_URL: local testing only
export class ValorError extends Error {}

// Card readers, from Netlify env vars. Reader 1: VALOR_APP_ID / VALOR_APP_KEY / VALOR_EPI (+ optional VALOR_NAME).
// Reader 2: VALOR_APP_KEY_2 / VALOR_EPI_2 (+ optional VALOR_APP_ID_2 if it differs, VALOR_NAME_2). Same pattern for _3, _4.
export function valorReaders() {
  const env = process.env, out = [];
  for (let n = 1; n <= 4; n++) {
    const sfx = n === 1 ? "" : `_${n}`;
    const appid = env[`VALOR_APP_ID${sfx}`] || env.VALOR_APP_ID, appkey = env[`VALOR_APP_KEY${sfx}`], epi = env[`VALOR_EPI${sfx}`];
    if (appid && appkey && epi) out.push({ id: String(n), name: (env[`VALOR_NAME${sfx}`] || `Reader ${n}`).slice(0, 40), appid, appkey, epi });
  }
  return out;
}
export const valorConfigured = () => valorReaders().length > 0;
/** Readers with the names an admin gave them in the app (else VALOR_NAME… or "Reader N"). Safe for the browser. */
export async function namedReaders() {
  const [row] = await db()`select value from settings where key = 'card_reader_names'`;
  const custom = row?.value || {};
  return valorReaders().map(r => ({ id: r.id, name: String(custom[r.id] || r.name).slice(0, 40), defaultName: r.name }));
}
const readerById = id => valorReaders().find(r => r.id === String(id));

async function valor(reader, path, params) {
  if (!reader) throw new ValorError("Valor isn't set up yet — add VALOR_APP_ID, VALOR_APP_KEY and VALOR_EPI in Netlify → Environment variables.");
  const qs = new URLSearchParams({ appid: reader.appid, appkey: reader.appkey, epi: reader.epi, ...params });
  let res;
  try { res = await fetch(`${BASE}/${path}?${qs}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(9000) }); }
  catch (e) { throw new ValorError(`Couldn't reach Valor: ${e.message}`); }
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  // Never echo the URL (it carries the keys).
  if (!res.ok) throw new ValorError(`Valor (${reader.name}) ${path} → HTTP ${res.status}${json?.message ? `: ${json.message}` : ""}`);
  return json;
}

const cents = v => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : 0; };
const yes = v => v === true || v === 1 || String(v).toLowerCase() === "1" || String(v).toLowerCase() === "true" || String(v).toLowerCase() === "yes";
// Shop-local day of a transaction: Valor's TIME is shop-local; TXN_ORIG_DATE is UTC.
function txnDay(t) {
  if (t.TXN_ORIG_DATE) { const d = new Date(String(t.TXN_ORIG_DATE).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(t.TXN_ORIG_DATE) ? "" : "Z")); if (!isNaN(d)) return shopDate(d); }
  const m = String(t.TIME || "").match(/(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const us = String(t.TIME || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  return null;
}
function txnClock(t) {
  const m = String(t.TIME || "").match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/);
  if (m) return m[3] ? `${Number(m[1])}:${m[2]} ${m[3].toUpperCase()}` : (() => { const h = Number(m[1]); return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? "AM" : "PM"}`; })();
  return "";
}
// Only what the report needs — no card numbers, names, auth codes or transaction ids.
function slim(t) {
  const type = String(t.TXN_TYPE || "").toUpperCase();
  const idSrc = t.TXN_ID ?? t.TRANSACTION_ID ?? t.RRN ?? t.REF_TXN_ID ?? t.TRAN_NO ?? JSON.stringify([t.TIME, t.TXN_ORIG_DATE, t.NET_AMOUNT, t.TXN_TYPE, t.CARD_SCHEME]);
  return {
    key: crypto.createHash("sha256").update(String(idSrc)).digest("hex").slice(0, 32), // for de-duplicating only
    day: txnDay(t), time: txnClock(t), sortAt: String(t.TXN_ORIG_DATE || t.TIME || ""),
    type: type.includes("REFUND") || type.includes("RETURN") ? "refund" : type.includes("VOID") ? "void" : "sale",
    rawType: type.slice(0, 30),
    amount: cents(t.NET_AMOUNT ?? t.BASE_AMOUNT), base: cents(t.BASE_AMOUNT ?? t.NET_AMOUNT),
    void: yes(t.IS_VOID) || type.includes("VOID"), reversal: yes(t.IS_REVERSAL),
    scheme: String(t.CARD_SCHEME || "").slice(0, 20), cardType: String(t.CARD_TYPE || "").slice(0, 20),
  };
}
async function fetchTxns(reader, dateFilter) {
  const out = [];
  for (let page = 0; page < 10; page++) {
    const r = await valor(reader, "txnfetch", { date_filter: String(dateFilter), transaction_status: "Approved", limit: "200", offset: String(page * 200), version: "2" });
    const list = Array.isArray(r?.data) ? r.data : [];
    out.push(...list.map(t => { const x = slim(t); x.reader = reader.id; x.key = crypto.createHash("sha256").update(reader.epi + ":" + x.key).digest("hex").slice(0, 32); return x; }));
    if (list.length < 200) break;
  }
  return out;
}
async function saveTxns(list) {
  const sql = db();
  for (const t of list) {
    if (!t.day) continue;
    await sql`insert into card_txns (txn_key, reader, day, time, sort_at, type, raw_type, amount_cents, base_cents, is_void, is_reversal, scheme, card_type)
              values (${t.key}, ${t.reader}, ${t.day}, ${t.time}, ${t.sortAt}, ${t.type}, ${t.rawType}, ${t.amount}, ${t.base}, ${t.void}, ${t.reversal}, ${t.scheme}, ${t.cardType})
              on conflict (txn_key) do update set day = excluded.day, time = excluded.time, type = excluded.type, raw_type = excluded.raw_type,
                amount_cents = excluded.amount_cents, base_cents = excluded.base_cents, is_void = excluded.is_void, is_reversal = excluded.is_reversal,
                fetched_at = now()`;
  }
}

/** Pull today's card transactions from one reader and save them (throttled: once per `maxAgeSec`). */
async function syncReader(reader, { maxAgeSec, maxWaitMs }) {
  return cached(`valor_today_${reader.id}`, maxAgeSec, async () => {
    const list = await fetchTxns(reader, 1);   // 1 = today
    await saveTxns(list);
    let batch = null;
    try {
      const b = await valor(reader, "openbatch", { limit: "1", offset: "0" });
      const d = b?.openBatchDetails?.[0];
      if (d) batch = { totalCents: cents(d.transaction_total_amount), count: Number(d.total_transactions) || 0 };
    } catch { /* optional cross-check */ }
    return { day: today(), count: list.length, batch, at: new Date().toISOString() };
  }, { maxWaitMs });
}
/** Every reader (or just one). One reader failing doesn't stop the others. */
export async function syncCardSales({ maxAgeSec = 300, maxWaitMs, reader = null } = {}) {
  const readers = valorReaders().filter(r => !reader || r.id === String(reader));
  const results = await Promise.all(readers.map(r => syncReader(r, { maxAgeSec, maxWaitMs }).then(v => ({ r, v }), e => ({ r, e }))));
  return {
    count: results.reduce((a, x) => a + (x.v?.value?.count || 0), 0),
    fresh: results.some(x => x.v?.fresh),
    batches: results.filter(x => x.v?.value?.batch).map(x => ({ reader: x.r.id, name: x.r.name, ...x.v.value.batch })),
    at: results.map(x => x.v?.value?.at).filter(Boolean).sort()[0] || null,
    errors: results.filter(x => x.e || x.v?.error).map(x => `${x.r.name}: ${x.e ? x.e.message : x.v.error}`),
  };
}
/** Yesterday straight from Valor (date_filter 2), saved — fills in a day the app didn't capture. */
export async function syncYesterday(reader = null) {
  let n = 0;
  for (const r of valorReaders().filter(r => !reader || r.id === String(reader))) { const list = await fetchTxns(r, 2); await saveTxns(list); n += list.length; }
  return n;
}

/** The previous business day (closed Sundays): Monday → Saturday. */
export function previousBusinessDay(day = today()) {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** One day's card sales from the saved snapshot. Voids are excluded; refunds subtract. */
export async function cardSalesFor(day, reader = null) {
  const rows = reader
    ? await db()`select * from card_txns where day = ${day} and reader = ${String(reader)} order by sort_at, time`
    : await db()`select * from card_txns where day = ${day} order by sort_at, time`;
  const names = Object.fromEntries((await namedReaders()).map(r => [r.id, r.name]));
  const txns = rows.map(r => ({ time: r.time, type: r.is_void || r.is_reversal ? "void" : r.type, amount: r.amount_cents, scheme: r.scheme, cardType: r.card_type,
    reader: names[r.reader] || `Reader ${r.reader}` }));
  const sales = txns.filter(t => t.type === "sale"), refunds = txns.filter(t => t.type === "refund"), voids = txns.filter(t => t.type === "void");
  const sum = l => l.reduce((a, t) => a + Math.abs(t.amount), 0);
  const byBrand = {};
  for (const t of sales) byBrand[t.scheme || "Other"] = (byBrand[t.scheme || "Other"] || 0) + Math.abs(t.amount);
  for (const t of refunds) byBrand[t.scheme || "Other"] = (byBrand[t.scheme || "Other"] || 0) - Math.abs(t.amount);
  return {
    day, txns,
    salesCount: sales.length, salesCents: sum(sales), refundCount: refunds.length, refundCents: sum(refunds), voidCount: voids.length,
    netCents: sum(sales) - sum(refunds),
    byBrand: Object.entries(byBrand).map(([brand, c]) => ({ brand, cents: c })).sort((a, b) => b.cents - a.cents),
  };
}
