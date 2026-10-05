// Small self-applying schema updates, so new features don't need you to paste SQL into Supabase.
// Runs once per server instance; every step is safe to repeat.
import { db } from "./db.mjs";

const OLD_DIAG_DEFAULT = ["Needs Called", "Awaiting Client", "Awaiting Parts", "Backburner", "Waiting on Customer", "Waiting for Parts"];
const NEW_DIAG_DEFAULT = ["Awaiting Client", "Awaiting Parts"];

// 4th Book Time Database category for RS Issue Types "Service/Consult" and "Other/Misc".
// Starts blank (N/A) — fill in minutes and add models/repair types in the Admin Console.
const MISC_CATEGORY = {
  label: "Consult/Misc Device Book Times",
  subtypes: {
    misc: {
      label: "Consult/Misc Device",
      rows: ["Service/Consult", "Other/Misc Device"],
      columns: ["Diagnostics"],
      data: { "Service/Consult": { "Diagnostics": null }, "Other/Misc Device": { "Diagnostics": null } },
      addOns: null,
    },
  },
};

let done = null;
export function ensureSchema() {
  if (!done) done = run().catch(e => { done = null; console.error("ensureSchema", e); });
  return done;
}
async function run() {
  const sql = db();
  // Who had a ticket in their queue (assigned to them + in an "in the queue" status), by day.
  try {
    await sql`create table if not exists queue_log (
      ticket_id bigint not null,
      person_id text not null references people(id),
      work_date date not null,
      primary key (ticket_id, person_id, work_date))`;
    await sql`alter table queue_log enable row level security`;
  } catch (e) { if (!/already exists/.test(e.message)) throw e; }
  // Diagnosis credit = was in your queue today, now Awaiting Client / Awaiting Parts (only if still on the old default list).
  await sql`update settings set value = ${sql.json(NEW_DIAG_DEFAULT)}
            where key = 'diagnosis_eligible_statuses' and value = ${sql.json(OLD_DIAG_DEFAULT)}`;
  await sql`update settings set value = jsonb_set(value, '{misc}', ${sql.json(MISC_CATEGORY)})
            where key = 'book_times' and not (value ? 'misc')`;
}
