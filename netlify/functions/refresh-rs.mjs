// Background job, every minute: pulls tickets/users, ticket timers and today's payments/invoices from
// RepairShopr and saves them, so page loads never wait on RepairShopr — and enforces one running
// timer per person, even when nobody has the app open.
import { syncFromRs } from "../../lib/sync.mjs";
import { syncTimersThrottled } from "../../lib/timers.mjs";
import { getMoney, getNotesToday } from "../../lib/rs.mjs";
import { syncInvoiceSnaps } from "../../lib/reports.mjs";
import { syncCardSales, valorConfigured } from "../../lib/valor.mjs";
import { runScheduledCardReport } from "../../lib/ccauto.mjs";

export default async () => {
  const r = await syncFromRs({ force: true });
  let timers = "", money = "";
  try { const t = (await syncTimersThrottled(r.peopleRows, { maxAgeSec: 0 })).value; timers = ` · timers: ${t.running} running, ${t.paused} paused${t.autoPaused ? `, auto-paused ${t.autoPaused}` : ""}`; }
  catch (e) { timers = ` · timers failed: ${e.message}`; }
  try { const m = (await getMoney({ force: true })).value; const s = await syncInvoiceSnaps(m.invoices); money = ` · today: ${m.paymentsError ? `payments blocked (${m.paymentsError})` : `${m.payments.length} payments`}, ${m.invoices.length} invoices (${s.fetched} line-item pulls)`; }
  catch (e) { money = ` · money failed: ${e.message}`; }
  try { const n = (await getNotesToday({ force: true })).value; money += ` · notes on ${Object.keys(n.notes).length} tickets today`; }
  catch (e) { money += ` · notes failed: ${e.message}`; }
  let cards = "";
  if (valorConfigured()) {
    try { const c = await syncCardSales({ maxAgeSec: 300 }); if (c.fresh) cards = ` · card sales: ${c.count} today`; if (c.errors.length) cards += ` (${c.errors.join("; ")})`; }
    catch (e) { cards = ` · card sales failed: ${e.message}`; }
  }
  try { const a = await runScheduledCardReport(); if (a) cards += ` · auto CC report ${a}`; }
  catch (e) { cards += ` · auto CC report error: ${e.message}`; }
  console.log(`refresh-rs: ${r.list.length} tickets in ${r.fetchMs ?? "?"}ms${timers}${money}${cards}${r.rsError ? ` — ${r.rsError}` : ""}`);
  return new Response("ok");
};

export const config = { schedule: "* * * * *" }; // every minute
