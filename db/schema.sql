-- Lightning Repairs Tech Tool — database schema
-- Run this ONCE in a fresh Supabase project: SQL Editor → New query → paste all → Run.
-- Safe to re-run: every statement is "if not exists" / "on conflict do nothing".
--
-- All access goes through the Netlify function using DATABASE_URL (server-side only).
-- Row Level Security is switched on with NO policies, so Supabase's public API keys can't read
-- or write any of this — only the server connection can.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------- People (techs, sales, managers) ----------
create table if not exists people (
  id           text primary key,              -- short slug, e.g. 'drew'
  name         text not null,
  initials     text not null,
  color        text not null default '#2a78d6',
  is_admin     boolean not null default false,
  positions    text[] not null default '{}',  -- Technician / Float / Sales / Manager
  rs_user_id   bigint unique,                 -- RepairShopr user id (links RS ticket assignment to this person)
  pin_hash     text,                          -- bcrypt hash; null = can't log in yet
  active       boolean not null default true,
  sort         int not null default 0
);

-- One row per person per day they logged in — which position they're working that day.
create table if not exists attendance (
  person_id    text not null references people(id) on delete cascade,
  work_date    date not null,
  position     text not null,
  first_login  timestamptz not null default now(),
  primary key (person_id, work_date)
);

-- App-side info about a RepairShopr ticket (RS doesn't store any of this).
create table if not exists ticket_state (
  ticket_id             bigint primary key,   -- RS internal ticket id
  device_category       text,                 -- override only; normally derived from RS Issue Type
  device_subtype        text,
  device_row            text,                 -- Model
  repair_type           text,
  diagnosis_claimed_by  text references people(id),
  diagnosis_claimed_at  date,
  diagnosis_locked      boolean not null default false,
  repair_claimed_by     text references people(id),
  repair_claimed_at     date,
  repair_locked         boolean not null default false,
  -- last-seen copy of the RS ticket, so tickets that drop off RS's open list (e.g. Resolved)
  -- can still show up in "Tickets I worked on today"
  rs_number             bigint,
  rs_subject            text,
  rs_status             text,
  rs_problem_type       text,
  rs_user_id            bigint,
  rs_synced_at          timestamptz,
  updated_at            timestamptz not null default now()
);

-- Outcome a person logged for a ticket on a given day (max one per person/ticket/day).
-- credited_minutes is the book time this outcome earned, snapshotted so later edits to the
-- Book Time Database don't rewrite history.
create table if not exists work_log (
  id                bigserial primary key,
  ticket_id         bigint not null,
  person_id         text not null references people(id),
  work_date         date not null,
  outcome           text not null check (outcome in ('diagnosis_completed','diagnosis_incomplete','repair_completed','repair_incomplete')),
  credited_minutes  int not null default 0,
  repair_type       text,
  logged_at         timestamptz not null default now(),
  unique (ticket_id, person_id, work_date)
);

-- Live timer state per person per ticket (idle | running | paused | logged).
create table if not exists timers (
  ticket_id      bigint not null,
  person_id      text not null references people(id),
  state          text not null default 'idle',
  running_since  timestamptz,
  primary key (ticket_id, person_id)
);

-- Every chunk of time: a finished timer segment, or a manual-SET adjustment.
-- A ticket's total for a person = sum(seconds); a day's total = sum where work_date = that day.
create table if not exists time_entries (
  id          bigserial primary key,
  ticket_id   bigint not null,
  person_id   text not null references people(id),
  work_date   date not null,
  seconds     int not null,
  kind        text not null default 'timer',   -- timer | manual
  created_at  timestamptz not null default now()
);
create index if not exists time_entries_person_date on time_entries (person_id, work_date);
create index if not exists time_entries_ticket_person on time_entries (ticket_id, person_id);

-- Quick notes written in the app (also posted to RS as a hidden comment when possible).
create table if not exists notes (
  id           bigserial primary key,
  ticket_id    bigint not null,
  person_id    text not null references people(id),
  work_date    date not null,
  body         text not null,
  rs_posted    boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists notes_ticket on notes (ticket_id);

-- Who a ticket was assigned to, by day (RS only exposes the CURRENT assignee, so we record it as we see it).
create table if not exists assignment_log (
  ticket_id   bigint not null,
  person_id   text not null references people(id),
  work_date   date not null,
  primary key (ticket_id, person_id, work_date)
);

-- Who had a ticket in their queue (assigned to them + in an "in the queue" status), by day.
create table if not exists queue_log (
  ticket_id   bigint not null,
  person_id   text not null references people(id),
  work_date   date not null,
  primary key (ticket_id, person_id, work_date)
);

-- App settings + Book Time Database (json).
create table if not exists settings (
  key    text primary key,
  value  jsonb not null
);

-- Short-lived cache of RepairShopr responses so we don't hammer their API.
create table if not exists rs_cache (
  key         text primary key,
  value       jsonb not null,
  fetched_at  timestamptz not null default now()
);

-- Failed PIN attempts, for lockout.
create table if not exists login_attempts (
  id            bigserial primary key,
  ip            text not null,
  attempted_at  timestamptz not null default now()
);
create index if not exists login_attempts_ip on login_attempts (ip, attempted_at);

-- Lock everything down from Supabase's public API.
alter table people          enable row level security;
alter table attendance      enable row level security;
alter table ticket_state    enable row level security;
alter table work_log        enable row level security;
alter table timers          enable row level security;
alter table time_entries    enable row level security;
alter table notes           enable row level security;
alter table assignment_log  enable row level security;
alter table queue_log       enable row level security;
alter table settings        enable row level security;
alter table rs_cache        enable row level security;
alter table login_attempts  enable row level security;

-- ---------- PIN helpers ----------
-- Set someone's PIN. Refuses a PIN that another active person already uses (login is PIN-only).
create or replace function set_pin(p_person text, p_pin text) returns void
language plpgsql as $$
declare clash text;
begin
  if p_pin !~ '^[0-9]{4}$' then raise exception 'PIN must be exactly 4 digits'; end if;
  select id into clash from people
   where id <> p_person and active and pin_hash is not null
     and pin_hash = extensions.crypt(p_pin, pin_hash)
   limit 1;
  if clash is not null then raise exception 'That PIN is already used by someone else'; end if;
  update people set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf')) where id = p_person;
  if not found then raise exception 'No person with id %', p_person; end if;
end $$;

-- Returns the person id whose PIN matches, or null.
create or replace function verify_pin(p_pin text) returns text
language sql stable as $$
  select id from people
   where active and pin_hash is not null and pin_hash = extensions.crypt(p_pin, pin_hash)
   limit 1
$$;

-- Supabase exposes public functions over its REST API to the anon/authenticated roles by default.
-- These two must only ever be called by the server, so take that away.
revoke execute on function set_pin(text, text) from public;
revoke execute on function verify_pin(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function set_pin(text, text) from anon, authenticated';
    execute 'revoke execute on function verify_pin(text) from anon, authenticated';
  end if;
end $$;

-- ---------- Seed data ----------
insert into people (id, name, initials, color, is_admin, positions, sort) values
  ('samuel', 'Samuel Lansberry', 'SL', 'var(--brand-navy)', true,  '{Technician,Float,Sales,Manager}', 0),
  ('drew',   'Drew Waggoner',    'DW', 'var(--s1)',         false, '{Technician,Float,Sales}',         1),
  ('aaron',  'Aaron Bagsby',     'AB', 'var(--s2)',         false, '{Sales}',                          2),
  ('chase',  'Chase Sullins',    'CS', 'var(--s3)',         false, '{Technician}',                     3),
  ('zach',   'Zach Mull',        'ZM', 'var(--s4)',         false, '{Technician,Float}',               4),
  ('nathan', 'Nathan Stumph',    'NS', 'var(--s5)',         false, '{Technician}',                     5)
on conflict (id) do nothing;

insert into settings (key, value) values
  ('over_book_threshold_pct', '15'),
  ('diagnosis_eligible_statuses', '["Awaiting Client","Awaiting Parts"]'),
  ('book_times', $json${
 "mobile": {
  "label": "Mobile Book Times",
  "subtypes": {
   "phone": {
    "label": "Phone",
    "rows": [
     "iPhone",
     "Samsung Flagship",
     "Misc Android"
    ],
    "columns": [
     "Diagnostics",
     "Screen",
     "Battery",
     "Port",
     "Back Only",
     "Back + Frame",
     "Camera Lens",
     "Modular Part",
     "Device Tuneup",
     "Tier 1 Software",
     "Tier 2 Software",
     "Tier 3 Software",
     "Tier 4 Software",
     "Tier 5 Software"
    ],
    "data": {
     "iPhone": {
      "Diagnostics": 30,
      "Screen": 30,
      "Battery": 35,
      "Port": 45,
      "Back Only": 30,
      "Back + Frame": 60,
      "Camera Lens": 15,
      "Modular Part": 35,
      "Device Tuneup": 15,
      "Tier 1 Software": 15,
      "Tier 2 Software": 30,
      "Tier 3 Software": 45,
      "Tier 4 Software": 60,
      "Tier 5 Software": 75
     },
     "Samsung Flagship": {
      "Diagnostics": 30,
      "Screen": 45,
      "Battery": 30,
      "Port": 30,
      "Back Only": 20,
      "Back + Frame": null,
      "Camera Lens": 15,
      "Modular Part": 30,
      "Device Tuneup": 15,
      "Tier 1 Software": 15,
      "Tier 2 Software": 30,
      "Tier 3 Software": 45,
      "Tier 4 Software": 60,
      "Tier 5 Software": 75
     },
     "Misc Android": {
      "Diagnostics": 30,
      "Screen": 30,
      "Battery": 30,
      "Port": 30,
      "Back Only": 20,
      "Back + Frame": null,
      "Camera Lens": 15,
      "Modular Part": 30,
      "Device Tuneup": 15,
      "Tier 1 Software": 15,
      "Tier 2 Software": 30,
      "Tier 3 Software": 45,
      "Tier 4 Software": 60,
      "Tier 5 Software": 75
     }
    },
    "addOns": {
     "Battery": 15,
     "Modular Part": 15,
     "Device Tuneup": 5,
     "Software Tuneup": 15,
     "Device Backup": 20,
     "Camera Lens Only": 10,
     "Back Only": 15,
     "Back + Frame": 30
    }
   },
   "tablet": {
    "label": "Tablet",
    "rows": [
     "iPad Base Model",
     "iPad Pro / Air",
     "Misc Android"
    ],
    "columns": [
     "Diagnostics",
     "Screen",
     "Battery",
     "Soldered Part",
     "Modular Part",
     "Device Tuneup",
     "Tier 1 Software",
     "Tier 2 Software",
     "Tier 3 Software",
     "Tier 4 Software",
     "Tier 5 Software"
    ],
    "data": {
     "iPad Base Model": {
      "Diagnostics": 30,
      "Screen": 40,
      "Battery": 40,
      "Soldered Part": 60,
      "Modular Part": 40,
      "Device Tuneup": 15,
      "Tier 1 Software": 15,
      "Tier 2 Software": 30,
      "Tier 3 Software": 45,
      "Tier 4 Software": 60,
      "Tier 5 Software": 75
     },
     "iPad Pro / Air": {
      "Diagnostics": 30,
      "Screen": 40,
      "Battery": 45,
      "Soldered Part": 60,
      "Modular Part": 45,
      "Device Tuneup": 15,
      "Tier 1 Software": 15,
      "Tier 2 Software": 30,
      "Tier 3 Software": 45,
      "Tier 4 Software": 60,
      "Tier 5 Software": 75
     },
     "Misc Android": {
      "Diagnostics": 30,
      "Screen": 35,
      "Battery": 35,
      "Soldered Part": 45,
      "Modular Part": 35,
      "Device Tuneup": 15,
      "Tier 1 Software": 15,
      "Tier 2 Software": 30,
      "Tier 3 Software": 45,
      "Tier 4 Software": 60,
      "Tier 5 Software": 75
     }
    },
    "addOns": {
     "Battery": 15,
     "Modular Part": 15,
     "Software Tuneup": 15,
     "Device Backup": 20
    }
   },
   "watch": {
    "label": "Watch",
    "rows": [
     "Apple Watch",
     "Misc Android"
    ],
    "columns": [
     "Diagnostics",
     "Screen",
     "Battery",
     "Modular Part",
     "Device Tuneup"
    ],
    "data": {
     "Apple Watch": {
      "Diagnostics": 30,
      "Screen": 30,
      "Battery": 25,
      "Modular Part": 30,
      "Device Tuneup": 15
     },
     "Misc Android": {
      "Diagnostics": 30,
      "Screen": 30,
      "Battery": 30,
      "Modular Part": 30,
      "Device Tuneup": 15
     }
    },
    "addOns": {
     "Battery": 10,
     "Device Tuneup": 5
    }
   }
  }
 },
 "computer": {
  "label": "Computer Book Times",
  "subtypes": {
   "moduleLaptops": {
    "label": "Laptop",
    "rows": [
     "Laptop",
     "Glass Digitizer Laptop",
     "<2015 Macbook",
     "2016> Macbook"
    ],
    "columns": [
     "Diagnostics",
     "Screen",
     "Rivets/Lid",
     "Battery",
     "Palmrest",
     "SSD + OS",
     "PCB Repair",
     "MOBO Replacement",
     "Modular Part",
     "Lvl 1 Cleaning",
     "Lvl 2 Cleaning",
     "Tier 1 Software",
     "Tier 2 Software",
     "Tier 3 Software",
     "Tier 4 Software",
     "Tier 5 Software"
    ],
    "data": {
     "Laptop": {
      "Diagnostics": 30,
      "Screen": 30,
      "Rivets/Lid": 45,
      "Battery": 20,
      "Palmrest": 50,
      "SSD + OS": 45,
      "PCB Repair": 90,
      "MOBO Replacement": 60,
      "Modular Part": 25,
      "Lvl 1 Cleaning": 15,
      "Lvl 2 Cleaning": 30,
      "Tier 1 Software": 15,
      "Tier 2 Software": 30,
      "Tier 3 Software": 45,
      "Tier 4 Software": 60,
      "Tier 5 Software": 75
     },
     "Glass Digitizer Laptop": {
      "Diagnostics": 30,
      "Screen": 35,
      "Rivets/Lid": 60,
      "Battery": 20,
      "Palmrest": 50,
      "SSD + OS": 45,
      "PCB Repair": 90,
      "MOBO Replacement": 60,
      "Modular Part": 25,
      "Lvl 1 Cleaning": 15,
      "Lvl 2 Cleaning": 30,
      "Tier 1 Software": 15,
      "Tier 2 Software": 30,
      "Tier 3 Software": 45,
      "Tier 4 Software": 60,
      "Tier 5 Software": 75
     },
     "<2015 Macbook": {
      "Diagnostics": 30,
      "Screen": 40,
      "Rivets/Lid": 40,
      "Battery": 30,
      "Palmrest": 60,
      "SSD + OS": 45,
      "PCB Repair": 90,
      "MOBO Replacement": 60,
      "Modular Part": 25,
      "Lvl 1 Cleaning": 15,
      "Lvl 2 Cleaning": 30,
      "Tier 1 Software": 15,
      "Tier 2 Software": 30,
      "Tier 3 Software": 45,
      "Tier 4 Software": 60,
      "Tier 5 Software": 75
     },
     "2016> Macbook": {
      "Diagnostics": 30,
      "Screen": 60,
      "Rivets/Lid": 60,
      "Battery": 30,
      "Palmrest": 75,
      "SSD + OS": null,
      "PCB Repair": 90,
      "MOBO Replacement": 60,
      "Modular Part": 30,
      "Lvl 1 Cleaning": 15,
      "Lvl 2 Cleaning": 60,
      "Tier 1 Software": 15,
      "Tier 2 Software": 30,
      "Tier 3 Software": 45,
      "Tier 4 Software": 60,
      "Tier 5 Software": 75
     }
    },
    "addOns": {
     "Battery": 15,
     "Modular Part": 15,
     "Software Tuneup": 15,
     "Device Backup": 15,
     "SSD Upgrade + Clone": 40,
     "Lvl 1 Cleaning": 5,
     "Lvl 2 Cleaning": 10
    }
   },
   "desktop": {
    "label": "Desktop",
    "rows": [
     "Name-Brand",
     "Custom Build",
     "Mac Mini"
    ],
    "columns": [
     "Diagnostics",
     "CPU",
     "CPU Cooler",
     "RAM",
     "SSD + OS",
     "Motherboard",
     "PSU",
     "Modular Part",
     "Lvl 1 Cleaning",
     "Lvl 2 Cleaning",
     "Tier 1 Software",
     "Tier 2 Software",
     "Tier 3 Software",
     "Tier 4 Software",
     "Tier 5 Software"
    ],
    "data": {
     "Name-Brand": {
      "Diagnostics": 30,
      "CPU": 30,
      "CPU Cooler": 30,
      "RAM": 25,
      "SSD + OS": 45,
      "Motherboard": 60,
      "PSU": 45,
      "Modular Part": 30,
      "Lvl 1 Cleaning": 15,
      "Lvl 2 Cleaning": 30,
      "Tier 1 Software": 15,
      "Tier 2 Software": 30,
      "Tier 3 Software": 45,
      "Tier 4 Software": 60,
      "Tier 5 Software": 75
     },
     "Custom Build": {
      "Diagnostics": 30,
      "CPU": 30,
      "CPU Cooler": 30,
      "RAM": 25,
      "SSD + OS": 45,
      "Motherboard": 60,
      "PSU": 45,
      "Modular Part": 30,
      "Lvl 1 Cleaning": 15,
      "Lvl 2 Cleaning": 30,
      "Tier 1 Software": 15,
      "Tier 2 Software": 30,
      "Tier 3 Software": 45,
      "Tier 4 Software": 60,
      "Tier 5 Software": 75
     },
     "Mac Mini": {
      "Diagnostics": 30,
      "CPU": null,
      "CPU Cooler": 60,
      "RAM": null,
      "SSD + OS": 45,
      "Motherboard": 60,
      "PSU": 60,
      "Modular Part": 60,
      "Lvl 1 Cleaning": 15,
      "Lvl 2 Cleaning": 30,
      "Tier 1 Software": 15,
      "Tier 2 Software": 30,
      "Tier 3 Software": 45,
      "Tier 4 Software": 60,
      "Tier 5 Software": 75
     }
    },
    "addOns": {
     "Modular Part": 15,
     "Software Tuneup": 15,
     "Device Backup": 15,
     "SSD Upgrade + Clone": 40,
     "Lvl 1 Cleaning": 5,
     "Lvl 2 Cleaning": 10
    }
   },
   "allInOne": {
    "label": "All-in-One",
    "rows": [
     "Windows All-in-One",
     "iMac"
    ],
    "columns": [
     "Diagnostics",
     "Screen",
     "SSD + OS",
     "PCB Repair",
     "MOBO Replacement",
     "Modular Part",
     "Lvl 1 Cleaning",
     "Lvl 2 Cleaning",
     "Tier 1 Software",
     "Tier 2 Software",
     "Tier 3 Software",
     "Tier 4 Software",
     "Tier 5 Software"
    ],
    "data": {
     "Windows All-in-One": {
      "Diagnostics": 30,
      "Screen": 75,
      "SSD + OS": 60,
      "PCB Repair": 90,
      "MOBO Replacement": 75,
      "Modular Part": 30,
      "Lvl 1 Cleaning": 15,
      "Lvl 2 Cleaning": 45,
      "Tier 1 Software": 15,
      "Tier 2 Software": 30,
      "Tier 3 Software": 45,
      "Tier 4 Software": 60,
      "Tier 5 Software": 75
     },
     "iMac": {
      "Diagnostics": 30,
      "Screen": 60,
      "SSD + OS": 75,
      "PCB Repair": 90,
      "MOBO Replacement": 75,
      "Modular Part": 30,
      "Lvl 1 Cleaning": 15,
      "Lvl 2 Cleaning": 60,
      "Tier 1 Software": 15,
      "Tier 2 Software": 30,
      "Tier 3 Software": 45,
      "Tier 4 Software": 60,
      "Tier 5 Software": 75
     }
    },
    "addOns": {
     "Modular Part": 15,
     "Software Tuneup": 15,
     "Device Backup": 15,
     "SSD Upgrade + Clone": 40,
     "Lvl 1 Cleaning": 5,
     "Lvl 2 Cleaning": 15
    }
   }
  }
 },
 "gaming": {
  "label": "Gaming Book Times",
  "subtypes": {
   "handheld": {
    "label": "Handheld",
    "rows": [
     "Switch",
     "Switch Lite",
     "Switch OLED",
     "Switch 2",
     "Gameboy (Any)"
    ],
    "columns": [
     "Diagnostics",
     "Port",
     "PCB Repair",
     "Battery",
     "Modular Part",
     "Lvl 1 Cleaning",
     "Lvl 2 Cleaning"
    ],
    "data": {
     "Switch": {
      "Diagnostics": 30,
      "Port": 45,
      "PCB Repair": 60,
      "Battery": 30,
      "Modular Part": 30,
      "Lvl 1 Cleaning": 15,
      "Lvl 2 Cleaning": 30
     },
     "Switch Lite": {
      "Diagnostics": 30,
      "Port": 45,
      "PCB Repair": 60,
      "Battery": 30,
      "Modular Part": 30,
      "Lvl 1 Cleaning": 15,
      "Lvl 2 Cleaning": 30
     },
     "Switch OLED": {
      "Diagnostics": 30,
      "Port": 45,
      "PCB Repair": 60,
      "Battery": 30,
      "Modular Part": 30,
      "Lvl 1 Cleaning": 15,
      "Lvl 2 Cleaning": 30
     },
     "Switch 2": {
      "Diagnostics": 30,
      "Port": 45,
      "PCB Repair": 60,
      "Battery": 30,
      "Modular Part": 30,
      "Lvl 1 Cleaning": 15,
      "Lvl 2 Cleaning": 30
     },
     "Gameboy (Any)": {
      "Diagnostics": 30,
      "Port": 45,
      "PCB Repair": 60,
      "Battery": null,
      "Modular Part": 30,
      "Lvl 1 Cleaning": 15,
      "Lvl 2 Cleaning": 30
     }
    },
    "addOns": {
     "Lvl 1 Cleaning": 5,
     "Lvl 2 Cleaning": 10,
     "Modular Part": 10
    }
   },
   "console": {
    "label": "Console",
    "rows": [
     "Xbox Series X",
     "Xbox Series S",
     "Xbox One",
     "PS5",
     "PS5 Slim",
     "PS5 Pro",
     "Retro Console"
    ],
    "columns": [
     "Diagnostics",
     "Port",
     "PSU",
     "PCB Repair",
     "Modular Part",
     "Cleaning Lvl 1",
     "Cleaning Lvl 2"
    ],
    "data": {
     "Xbox Series X": {
      "Diagnostics": 30,
      "Port": 45,
      "PSU": 30,
      "PCB Repair": 75,
      "Modular Part": 30,
      "Cleaning Lvl 1": 15,
      "Cleaning Lvl 2": 30
     },
     "Xbox Series S": {
      "Diagnostics": 30,
      "Port": 40,
      "PSU": 30,
      "PCB Repair": 60,
      "Modular Part": 30,
      "Cleaning Lvl 1": 15,
      "Cleaning Lvl 2": 30
     },
     "Xbox One": {
      "Diagnostics": 30,
      "Port": 40,
      "PSU": 30,
      "PCB Repair": 60,
      "Modular Part": 30,
      "Cleaning Lvl 1": 15,
      "Cleaning Lvl 2": 30
     },
     "PS5": {
      "Diagnostics": 30,
      "Port": 45,
      "PSU": 30,
      "PCB Repair": 75,
      "Modular Part": 30,
      "Cleaning Lvl 1": 15,
      "Cleaning Lvl 2": 30
     },
     "PS5 Slim": {
      "Diagnostics": 30,
      "Port": 45,
      "PSU": 30,
      "PCB Repair": 75,
      "Modular Part": 30,
      "Cleaning Lvl 1": 15,
      "Cleaning Lvl 2": 30
     },
     "PS5 Pro": {
      "Diagnostics": 30,
      "Port": 45,
      "PSU": 30,
      "PCB Repair": 75,
      "Modular Part": 30,
      "Cleaning Lvl 1": 15,
      "Cleaning Lvl 2": 30
     },
     "Retro Console": {
      "Diagnostics": 30,
      "Port": 45,
      "PSU": 30,
      "PCB Repair": 60,
      "Modular Part": 30,
      "Cleaning Lvl 1": 15,
      "Cleaning Lvl 2": 30
     }
    },
    "addOns": {
     "Port": 15,
     "Lvl 1 Cleaning": 5,
     "Lvl 2 Cleaning": 15
    }
   },
   "controller": {
    "label": "Controller",
    "rows": [
     "Xbox",
     "Playstation",
     "SCUF",
     "Switch Pro",
     "Joycon x1",
     "Joycon x2",
     "Other/Misc"
    ],
    "columns": [
     "TMR Mod",
     "Misc Solder",
     "Misc Module"
    ],
    "data": {
     "Xbox": {
      "TMR Mod": 20,
      "Misc Solder": 20,
      "Misc Module": 15
     },
     "Playstation": {
      "TMR Mod": 20,
      "Misc Solder": 20,
      "Misc Module": 15
     },
     "SCUF": {
      "TMR Mod": 40,
      "Misc Solder": 40,
      "Misc Module": 30
     },
     "Switch Pro": {
      "TMR Mod": 20,
      "Misc Solder": 20,
      "Misc Module": 15
     },
     "Joycon x1": {
      "TMR Mod": 15,
      "Misc Solder": 15,
      "Misc Module": 10
     },
     "Joycon x2": {
      "TMR Mod": 30,
      "Misc Solder": 30,
      "Misc Module": 20
     },
     "Other/Misc": {
      "TMR Mod": null,
      "Misc Solder": 30,
      "Misc Module": 20
     }
    },
    "addOns": {
     "Second Repair": 5
    }
   }
  }
 }
}$json$)
on conflict (key) do nothing;
