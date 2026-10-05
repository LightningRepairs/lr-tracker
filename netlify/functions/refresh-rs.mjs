// Background job: pulls tickets/users from RepairShopr every minute and saves them, so page loads
// read the saved copy instead of waiting on RepairShopr (which can take 10+ seconds).
import { syncFromRs } from "../../lib/sync.mjs";

export default async () => {
  const r = await syncFromRs({ force: true });
  console.log(`refresh-rs: ${r.list.length} tickets in ${r.fetchMs ?? "?"}ms${r.rsError ? ` — ${r.rsError}` : ""}`);
  return new Response("ok");
};

export const config = { schedule: "* * * * *" }; // every minute
