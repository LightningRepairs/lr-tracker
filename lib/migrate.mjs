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
  // Diagnosis-credit questions: created when a ticket assigned to someone moves from an in-the-queue
  // status into a diagnosis status. pending → claimed (Yes) or declined (No).
  try {
    await sql`create table if not exists diag_prompts (
      id           bigserial primary key,
      ticket_id    bigint not null,
      person_id    text not null references people(id),
      from_status  text,
      to_status    text,
      state        text not null default 'pending',
      created_at   timestamptz not null default now(),
      answered_at  timestamptz)`;
    await sql`alter table diag_prompts enable row level security`;
    await sql`create unique index if not exists diag_prompts_one_pending on diag_prompts (ticket_id) where state = 'pending'`;
  } catch (e) { if (!/already exists/.test(e.message)) throw e; }
  // Mirror of RepairShopr ticket timers (synced every minute + after every timer button press).
  try {
    await sql`create table if not exists rs_timers (
      id            bigint primary key,
      ticket_id     bigint not null,
      rs_user_id    bigint,
      status        text not null,          -- running | paused | stopped
      start_time    timestamptz,
      end_time      timestamptz,
      seconds       int not null default 0, -- active seconds as of fetched_at
      rs_updated_at timestamptz,
      fetched_at    timestamptz not null default now())`;
    await sql`alter table rs_timers enable row level security`;
    await sql`create index if not exists rs_timers_user_status on rs_timers (rs_user_id, status)`;
    await sql`create index if not exists rs_timers_ticket on rs_timers (ticket_id)`;
  } catch (e) { if (!/already exists/.test(e.message)) throw e; }
  // Each person's own RepairShopr API key (encrypted) — changes they push to RS are made as them.
  await sql`alter table people add column if not exists rs_api_key_enc text`;
  await sql`alter table people add column if not exists rs_api_key_last4 text`;
  await sql`alter table people add column if not exists rs_api_key_owner text`;
  // Role used on the Team tab for anyone who hasn't logged in and picked one today.
  await sql`alter table people add column if not exists default_position text`;
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
  // Reports: one row per invoice (snapshotted from RepairShopr while it's that invoice's day), with
  // revenue / cost / labor worked out from its line items. Past days stay frozen.
  try {
    await sql`create table if not exists invoice_snap (
      invoice_id     bigint primary key,
      day            date not null,
      number         text,
      ticket_id      bigint,
      creator_rs_user bigint,
      owner_rs_user  bigint,          -- who gets credit: the ticket's assignee, else the invoice creator
      subtotal       numeric not null default 0,
      tax            numeric not null default 0,
      total          numeric not null default 0,
      cost           numeric not null default 0,
      labor_amount   numeric not null default 0,
      labor_qty      numeric not null default 0,
      lines          jsonb,
      lines_ok       boolean not null default false,
      rs_updated_at  timestamptz,
      fetched_at     timestamptz not null default now())`;
    await sql`alter table invoice_snap enable row level security`;
    await sql`create index if not exists invoice_snap_day on invoice_snap (day)`;
    // One row per invoice LINE: money counts on the day the line was added, for whoever added it.
    await sql`create table if not exists invoice_lines (
      line_id     bigint primary key,
      invoice_id  bigint not null,
      ticket_id   bigint,
      day         date not null,           -- shop day the line was ADDED
      user_id     bigint,                  -- who added it (null = system line, e.g. Bench Fee)
      name        text,
      product_id  bigint,
      qty         numeric not null default 0,
      price       numeric not null default 0,
      cost        numeric not null default 0,
      labor       boolean not null default false,
      deposit     boolean not null default false,  -- bench fee / no one recorded → counts for no one
      created_at  timestamptz,
      updated_at  timestamptz)`;
    await sql`alter table invoice_lines enable row level security`;
    await sql`create index if not exists invoice_lines_day on invoice_lines (day)`;
    await sql`create index if not exists invoice_lines_invoice on invoice_lines (invoice_id)`;
    // legacy = saved under the old "whole invoice on its own date" rule (only those feed reports before line crediting began).
    await sql`alter table invoice_snap add column if not exists legacy boolean not null default true`;
    // 2 = line items saved WITH who added each line (user_id) — older snapshots get re-pulled.
    await sql`alter table invoice_snap add column if not exists lines_v int not null default 1`;
  } catch (e) { if (!/already exists/.test(e.message)) throw e; }
  // 📤 Pushed to the next stage: a ticket assigned to someone moved from the queue to a waiting status
  // (Awaiting Parts / Client …) — logged whether or not diagnosis credit was (or could be) claimed.
  try {
    await sql`create table if not exists push_log (
      ticket_id   bigint not null,
      person_id   text not null,
      work_date   date not null,
      from_status text,
      to_status   text,
      created_at  timestamptz not null default now(),
      primary key (ticket_id, person_id, work_date))`;
    await sql`alter table push_log enable row level security`;
  } catch (e) { if (!/already exists/.test(e.message)) throw e; }
  // 📌 Needs-your-input reminders someone answered "No invoice needed" / "Skip" on.
  try {
    await sql`create table if not exists input_dismiss (
      ticket_id  bigint not null,
      kind       text not null,             -- invoice | actual
      person_id  text,
      created_at timestamptz not null default now(),
      primary key (ticket_id, kind))`;
    await sql`alter table input_dismiss enable row level security`;
  } catch (e) { if (!/already exists/.test(e.message)) throw e; }
  // Refurbs: app-only work items (RepairShopr's API has no refurbs). Book time comes from the
  // Book Time Database; the timer uses ticket_id = -refurb id in timers / time_entries.
  try {
    await sql`create table if not exists refurbs (
      id           bigserial primary key,
      person_id    text not null references people(id),
      label        text not null default '',
      issue_type   text,
      subtype      text,
      model        text,
      repairs      jsonb not null default '[]',
      state        text not null default 'open',   -- open | done
      book_minutes int,                             -- frozen when completed
      created_at   timestamptz not null default now(),
      done_at      timestamptz,
      done_date    date)`;
    await sql`alter table refurbs enable row level security`;
    await sql`create index if not exists refurbs_person_state on refurbs (person_id, state)`;
    await sql`create index if not exists refurbs_done_date on refurbs (done_date)`;
  } catch (e) { if (!/already exists/.test(e.message)) throw e; }
  // Card sales from Valor, saved as they happen so the previous business day can still be reported.
  // No card numbers / transaction ids — txn_key is a hash used only to avoid duplicates.
  try {
    await sql`create table if not exists card_txns (
      txn_key      text primary key,
      day          date not null,
      time         text,
      sort_at      text,
      type         text not null,          -- sale | refund | void
      raw_type     text,
      amount_cents bigint not null default 0,
      base_cents   bigint not null default 0,
      is_void      boolean not null default false,
      is_reversal  boolean not null default false,
      scheme       text,
      card_type    text,
      fetched_at   timestamptz not null default now())`;
    await sql`alter table card_txns enable row level security`;
    await sql`create index if not exists card_txns_day on card_txns (day)`;
    await sql`alter table card_txns add column if not exists reader text not null default '1'`;  // which card reader
    // One-time: rows saved before update 34 used a different duplicate-check key (reader EPI + id), so
    // re-pulls saved every sale a second time. Clear them; Valor is re-read on the next report.
    const [cv] = await sql`select value from settings where key = 'card_txns_version'`;
    if (!cv || Number(cv.value) < 2) {
      await sql`delete from card_txns`;
      await sql`insert into settings (key, value) values ('card_txns_version', ${sql.json(2)}) on conflict (key) do update set value = excluded.value`;
    }
  } catch (e) { if (!/already exists/.test(e.message)) throw e; }
  // 🔔 Notifications for admins (e.g. someone downloaded a CC report). Each admin's "seen up to" id lives on people.
  try {
    await sql`create table if not exists notifications (
      id          bigserial primary key,
      kind        text not null,
      person_id   text references people(id),
      data        jsonb not null default '{}',
      created_at  timestamptz not null default now())`;
    await sql`alter table notifications enable row level security`;
    await sql`create index if not exists notifications_kind_person on notifications (kind, person_id, created_at)`;
  } catch (e) { if (!/already exists/.test(e.message)) throw e; }
  await sql`alter table people add column if not exists notif_seen_id bigint not null default 0`;
  // Add-ons on tickets (repair types done on top of the main repair).
  await sql`alter table ticket_state add column if not exists addons jsonb not null default '[]'`;
  // Book Time Database v2: an editable "Add-on" row (addOns keyed by repair type) and a "Misc Repair" column
  // ($ of profit per 1 minute) right after Diagnostics on every sheet. Drops add-ons that aren't repairs anymore.
  try {
    const [v] = await sql`select value from settings where key = 'book_times_v'`;
    if (!v || Number(v.value) < 2) {
      await sql.begin(async tx => {
        const [row] = await tx`select value from settings where key = 'book_times' for update`;
        const bt = row?.value;
        if (bt) {
          const RENAME = { "Camera Lens Only": "Camera Lens", "Lvl 1 Cleaning": "Cleaning Lvl 1", "Lvl 2 Cleaning": "Cleaning Lvl 2" };
          for (const cat of Object.values(bt)) for (const g of Object.values(cat.subtypes || {})) {
            const ao = {};
            for (const [k, val] of Object.entries(g.addOns || {})) {
              const name = g.columns.includes(k) ? k : (RENAME[k] && g.columns.includes(RENAME[k]) ? RENAME[k] : null);
              if (name && !/tune\s*up|backup/i.test(name)) ao[name] = val;   // tuneups/backups → software tiers; SSD clone, Second Repair → dropped
            }
            g.addOns = ao;
            if (!g.columns.includes("Misc Repair")) {
              const at = g.columns[0] === "Diagnostics" ? 1 : 0;
              g.columns.splice(at, 0, "Misc Repair");
              for (const r of g.rows) (g.data[r] ||= {})["Misc Repair"] = 5;
            }
          }
          await tx`update settings set value = ${tx.json(bt)} where key = 'book_times'`;
        }
        await tx`insert into settings (key, value) values ('book_times_v', ${tx.json(2)}) on conflict (key) do update set value = excluded.value`;
      });
    }
  } catch (e) { console.error("book_times v2", e.message); }
  await sql`update settings set value = jsonb_set(value, '{misc}', ${sql.json(MISC_CATEGORY)})
            where key = 'book_times' and not (value ? 'misc')`;
}
