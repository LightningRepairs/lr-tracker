// Background job, every minute: pulls tickets/users, ticket timers and today's payments/invoices from
// RepairShopr and saves them, so page loads never wait on RepairShopr — and enforces one running
// timer per person, even when nobody has the app open.
import { syncFromRs } from "../../lib/sync.mjs";
import { syncTimers } from "../../lib/timers.mjs";
import { getMoney } from "../../lib/rs.mjs";

export default async () => {
  const r = await syncFromRs({ force: true });
  let timers = "", money = "";
  try { const t = await syncTimers(r.peopleRows); timers = ` · timers: ${t.running} running, ${t.paused} paused${t.autoPaused ? `, auto-paused ${t.autoPaused}` : ""}`; }
  catch (e) { timers = ` · timers failed: ${e.message}`; }
  try { const m = (await getMoney({ force: true })).value; money = ` · today: ${m.payments.length} payments, ${m.invoices.length} invoices`; }
  catch (e) { money = ` · money failed: ${e.message}`; }
  console.log(`refresh-rs: ${r.list.length} tickets in ${r.fetchMs ?? "?"}ms${timers}${money}${r.rsError ? ` — ${r.rsError}` : ""}`);
  return new Response("ok");
};

export const config = { schedule: "* * * * *" }; // every minute
