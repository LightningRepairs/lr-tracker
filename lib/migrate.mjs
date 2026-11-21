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
  // A ticket resolved on a given day, and who was assigned at that moment.
  try {
    await sql`create table if not exists completions (
      ticket_id         bigint not null,
      work_date         date not null,
      resolved_at       timestamptz,
      assigned_person   text references people(id),
      assigned_rs_user  bigint,
      book_minutes      int,          -- frozen once the day is over
      created_at        timestamptz not null default now(),
      primary key (ticket_id, work_date))`;
    await sql`alter table completions enable row level security`;
    // How a completion's book-time credit is split (percent; rows for one completion sum to 100).
    await sql`create table if not exists credit_shares (
      ticket_id   bigint not null,
      work_date   date not null,
      person_id   text not null references people(id),
      pct         int not null check (pct between 1 and 100),
      primary key (ticket_id, work_date, person_id))`;
    await sql`alter table credit_shares enable row level security`;
    // The "primary" owns the ticket's credit (decides the split) and is who it's assigned to in RS.
    await sql`alter table completions add column if not exists primary_person text references people(id)`;
    await sql`update completions c set primary_person = (
                select s.person_id from credit_shares s where s.ticket_id = c.ticket_id and s.work_date = c.work_date
                order by (s.person_id = c.assigned_person) desc, s.pct desc limit 1)
              where c.primary_person is null`;
  } catch (e) { if (!/already exists/.test(e.message)) throw e; }
  // Each person's own RepairShopr API key (encrypted) — changes they push to RS are made as them.
  await sql`alter table people add column if not exists rs_api_key_enc text`;
  await sql`alter table people add column if not exists rs_api_key_last4 text`;
  await sql`alter table people add column if not exists rs_api_key_owner text`;
  // RepairShopr's status is "Waiting on Process", not "Awaiting Process".
  await sql`update settings set value = (
              select coalesce(jsonb_agg(case when v = 'Awaiting Process' then 'Waiting on Process' else v end), '[]'::jsonb)
              from jsonb_array_elements_text(value) as v)
            where key = 'queue_statuses' and value ? 'Awaiting Process'`;
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
