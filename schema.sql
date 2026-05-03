-- =============================================
-- LIGHTNING REPAIRS - Daily Ticket Tracker
-- Run this entire file in Supabase SQL Editor
-- =============================================

-- TECHNICIANS
create table if not exists technicians (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  pin text not null,
  role text not null default 'tech', -- 'tech' or 'admin'
  active boolean default true,
  created_at timestamptz default now()
);

-- DEVICE TYPES
create table if not exists device_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort_order int default 0,
  active boolean default true
);

-- DEVICE MODELS
create table if not exists device_models (
  id uuid primary key default gen_random_uuid(),
  device_type_id uuid references device_types(id) on delete cascade,
  name text not null,
  sort_order int default 0,
  active boolean default true
);

-- REPAIR TYPES
create table if not exists repair_types (
  id uuid primary key default gen_random_uuid(),
  device_type_id uuid references device_types(id) on delete cascade,
  name text not null,
  is_labor boolean default false,
  is_diagnosis boolean default false,
  sort_order int default 0,
  active boolean default true
);

-- BOOK TIMES
create table if not exists book_times (
  id uuid primary key default gen_random_uuid(),
  repair_type_id uuid references repair_types(id) on delete cascade,
  device_model_id uuid references device_models(id) on delete cascade,
  minutes int,
  is_na boolean default false,
  updated_at timestamptz default now(),
  unique(repair_type_id, device_model_id)
);

-- DAILY TICKETS
create table if not exists tickets (
  id uuid primary key default gen_random_uuid(),
  technician_id uuid references technicians(id),
  ticket_number text,
  device_type_id uuid references device_types(id),
  device_model_id uuid references device_models(id),
  repair_type_id uuid references repair_types(id),
  book_minutes int,
  actual_minutes int,
  labor_cost numeric(10,2),
  is_full_set boolean default false,
  notes text,
  efficiency_pct int,
  work_date date default current_date,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- =============================================
-- SEED DATA
-- =============================================

-- Technicians (PIN-based login)
insert into technicians (name, pin, role) values
  ('Samuel', '1111', 'admin'),
  ('Zach',   '2222', 'tech'),
  ('Drew',   '3333', 'tech'),
  ('Chase',  '4444', 'tech'),
  ('Aaron',  '5555', 'tech')
on conflict (name) do nothing;

-- Device Types
insert into device_types (name, sort_order) values
  ('Phone', 1),
  ('Tablet', 2),
  ('Desktop', 3),
  ('Game Console', 4),
  ('Game Controller / Cartridge', 5),
  ('Laptop', 6),
  ('All-in-One', 7),
  ('Misc Device', 8)
on conflict (name) do nothing;

-- Phone Models
insert into device_models (device_type_id, name, sort_order)
select id, m.name, m.ord from device_types, (values
  ('iPhone', 1), ('Samsung S-series', 2), ('Misc Phone', 3)
) as m(name, ord) where device_types.name = 'Phone'
on conflict do nothing;

-- Tablet Models
insert into device_models (device_type_id, name, sort_order)
select id, m.name, m.ord from device_types, (values
  ('iPad', 1), ('Misc Tablet', 2)
) as m(name, ord) where device_types.name = 'Tablet'
on conflict do nothing;

-- Desktop Models
insert into device_models (device_type_id, name, sort_order)
select id, m.name, m.ord from device_types, (values
  ('Desktop', 1)
) as m(name, ord) where device_types.name = 'Desktop'
on conflict do nothing;

-- Game Console Models
insert into device_models (device_type_id, name, sort_order)
select id, m.name, m.ord from device_types, (values
  ('PS5', 1), ('PS4', 2), ('PS3/PS2', 3),
  ('Xbox Series X', 4), ('Xbox Series S', 5), ('Xbox One', 6)
) as m(name, ord) where device_types.name = 'Game Console'
on conflict do nothing;

-- Game Controller Models
insert into device_models (device_type_id, name, sort_order)
select id, m.name, m.ord from device_types, (values
  ('DS5', 1), ('DS4', 2), ('DS Edge', 3),
  ('Xbox Core', 4), ('Xbox One Controller', 5),
  ('Xbox Elite S1', 6), ('Xbox Elite S2', 7),
  ('SCUF (Any)', 8), ('1/2 S1 Joycons', 9),
  ('1/2 S2 Joycons', 10), ('Retro Cart (NES/SNES/N64/GB/GBA)', 11)
) as m(name, ord) where device_types.name = 'Game Controller / Cartridge'
on conflict do nothing;

-- Laptop Models
insert into device_models (device_type_id, name, sort_order)
select id, m.name, m.ord from device_types, (values ('Misc Laptop', 1))
as m(name, ord) where device_types.name = 'Laptop' on conflict do nothing;

-- All-in-One Models
insert into device_models (device_type_id, name, sort_order)
select id, m.name, m.ord from device_types, (values ('Misc All-in-One', 1))
as m(name, ord) where device_types.name = 'All-in-One' on conflict do nothing;

-- Misc Device Models
insert into device_models (device_type_id, name, sort_order)
select id, m.name, m.ord from device_types, (values ('Misc Device', 1))
as m(name, ord) where device_types.name = 'Misc Device' on conflict do nothing;

-- Phone Repair Types
insert into repair_types (device_type_id, name, is_diagnosis, is_labor, sort_order)
select id, r.name, r.diag, r.labor, r.ord from device_types,
(values
  ('Misc Diagnosis', true, false, 1),
  ('Liquid Diagnosis', true, false, 2),
  ('Device Tuneup', false, false, 3),
  ('Soft Restart', false, false, 4),
  ('Depower Board', false, false, 5),
  ('Screen', false, false, 6),
  ('Battery', false, false, 7),
  ('Port', false, false, 8),
  ('Back (Modular)', false, false, 9),
  ('Back (Frame)', false, false, 10),
  ('Back (Laser)', false, false, 11),
  ('OS Reinstall', false, false, 12),
  ('Malware Removal', false, false, 13),
  ('Misc Modular (Labor x 0.3)', false, true, 14),
  ('Misc Soldering (Labor x 0.3)', false, true, 15)
) as r(name, diag, labor, ord)
where device_types.name = 'Phone' on conflict do nothing;

-- Tablet Repair Types
insert into repair_types (device_type_id, name, is_diagnosis, is_labor, sort_order)
select id, r.name, r.diag, r.labor, r.ord from device_types,
(values
  ('Misc Diagnosis', true, false, 1),
  ('Liquid Diagnosis', true, false, 2),
  ('Device Tuneup', false, false, 3),
  ('Soft Restart', false, false, 4),
  ('Depower Board', false, false, 5),
  ('Screen', false, false, 6),
  ('Battery', false, false, 7),
  ('Port', false, false, 8),
  ('Back (Modular)', false, false, 9),
  ('Back (Frame)', false, false, 10),
  ('Back (Laser)', false, false, 11),
  ('OS Reinstall', false, false, 12),
  ('Malware Removal', false, false, 13),
  ('Misc Modular (Labor x 0.3)', false, true, 14),
  ('Misc Soldering (Labor x 0.3)', false, true, 15)
) as r(name, diag, labor, ord)
where device_types.name = 'Tablet' on conflict do nothing;

-- Desktop Repair Types
insert into repair_types (device_type_id, name, is_diagnosis, is_labor, sort_order)
select id, r.name, r.diag, r.labor, r.ord from device_types,
(values
  ('Misc Diagnosis', true, false, 1),
  ('Liquid Diagnosis', true, false, 2),
  ('Motherboard', false, false, 3),
  ('CPU', false, false, 4),
  ('CPU Fan Cooler', false, false, 5),
  ('CPU Liquid Cooler', false, false, 6),
  ('RAM', false, false, 7),
  ('GPU', false, false, 8),
  ('PSU', false, false, 9),
  ('Fan', false, false, 10),
  ('Re-case', false, false, 11),
  ('Full Build', false, false, 12),
  ('Software Repair ($119, Simple)', false, false, 13),
  ('Software Repair ($169, Medium)', false, false, 14),
  ('Software Repair ($219, Advanced)', false, false, 15),
  ('Misc Modular (Labor x 0.3)', false, true, 16),
  ('Misc Soldering (Labor x 0.3)', false, true, 17)
) as r(name, diag, labor, ord)
where device_types.name = 'Desktop' on conflict do nothing;

-- Game Console Repair Types
insert into repair_types (device_type_id, name, is_diagnosis, is_labor, sort_order)
select id, r.name, r.diag, r.labor, r.ord from device_types,
(values
  ('Misc Diagnosis', true, false, 1),
  ('Liquid Diagnosis', true, false, 2),
  ('HDMI Port', false, false, 3),
  ('HDMI Encoder', false, false, 4),
  ('Misc Port (USB/LAN/Etc)', false, false, 5),
  ('Replacement Thermals', false, false, 6),
  ('PSU', false, false, 7),
  ('Misc Board Fault', false, false, 8),
  ('Misc Modular (Labor x 0.3)', false, true, 9),
  ('Misc Soldering (Labor x 0.3)', false, true, 10)
) as r(name, diag, labor, ord)
where device_types.name = 'Game Console' on conflict do nothing;

-- Game Controller Repair Types
insert into repair_types (device_type_id, name, is_diagnosis, is_labor, sort_order)
select id, r.name, r.diag, r.labor, r.ord from device_types,
(values
  ('Misc Diagnosis', true, false, 1),
  ('Liquid Diagnosis', true, false, 2),
  ('Battery Replacement', false, false, 3),
  ('Stick Drift', false, false, 4),
  ('Port/Rail Repair', false, false, 5),
  ('Bumper Repair', false, false, 6),
  ('Trigger Repair', false, false, 7),
  ('Button Fix', false, false, 8),
  ('Clean/Tuneup', false, false, 9),
  ('Misc Modular (Labor x 0.3)', false, true, 10),
  ('Misc Soldering (Labor x 0.3)', false, true, 11)
) as r(name, diag, labor, ord)
where device_types.name = 'Game Controller / Cartridge' on conflict do nothing;

-- =============================================
-- BOOK TIMES (Phone)
-- =============================================
insert into book_times (repair_type_id, device_model_id, minutes)
select rt.id, dm.id, bt.mins
from repair_types rt
join device_types dty on rt.device_type_id = dty.id
join device_models dm on dm.device_type_id = dty.id
join (values
  ('iPhone','Misc Diagnosis',30),('iPhone','Liquid Diagnosis',45),
  ('iPhone','Device Tuneup',15),('iPhone','Soft Restart',15),
  ('iPhone','Depower Board',20),('iPhone','Screen',30),
  ('iPhone','Battery',30),('iPhone','Port',60),
  ('iPhone','Back (Modular)',30),('iPhone','Back (Frame)',90),
  ('iPhone','Back (Laser)',90),('iPhone','OS Reinstall',15),
  ('iPhone','Malware Removal',15),
  ('Samsung S-series','Misc Diagnosis',30),('Samsung S-series','Liquid Diagnosis',45),
  ('Samsung S-series','Device Tuneup',15),('Samsung S-series','Soft Restart',15),
  ('Samsung S-series','Depower Board',20),('Samsung S-series','Screen',45),
  ('Samsung S-series','Battery',30),('Samsung S-series','Port',30),
  ('Samsung S-series','Back (Modular)',20),('Samsung S-series','OS Reinstall',20),
  ('Samsung S-series','Malware Removal',20),
  ('Misc Phone','Misc Diagnosis',30),('Misc Phone','Liquid Diagnosis',45),
  ('Misc Phone','Device Tuneup',15),('Misc Phone','Soft Restart',15),
  ('Misc Phone','Depower Board',20),('Misc Phone','Screen',45),
  ('Misc Phone','Battery',30),('Misc Phone','Port',30),
  ('Misc Phone','Back (Modular)',20),('Misc Phone','OS Reinstall',20),
  ('Misc Phone','Malware Removal',20)
) as bt(model, repair, mins)
on bt.model = dm.name and bt.repair = rt.name and dty.name = 'Phone'
on conflict (repair_type_id, device_model_id) do nothing;

-- Book Times (Tablet)
insert into book_times (repair_type_id, device_model_id, minutes)
select rt.id, dm.id, bt.mins
from repair_types rt
join device_types dty on rt.device_type_id = dty.id
join device_models dm on dm.device_type_id = dty.id
join (values
  ('iPad','Misc Diagnosis',30),('iPad','Liquid Diagnosis',45),
  ('iPad','Device Tuneup',45),('iPad','Soft Restart',45),
  ('iPad','Depower Board',45),('iPad','Screen',45),
  ('iPad','Battery',60),('iPad','Port',60),
  ('iPad','Back (Modular)',75),('iPad','Back (Frame)',15),
  ('iPad','Back (Laser)',15),('iPad','OS Reinstall',30),
  ('iPad','Malware Removal',20),
  ('Misc Tablet','Misc Diagnosis',30),('Misc Tablet','Liquid Diagnosis',45),
  ('Misc Tablet','Device Tuneup',30),('Misc Tablet','Soft Restart',30),
  ('Misc Tablet','Depower Board',30),('Misc Tablet','Screen',45),
  ('Misc Tablet','Battery',45),('Misc Tablet','Back (Frame)',15),
  ('Misc Tablet','Back (Laser)',15),('Misc Tablet','OS Reinstall',30),
  ('Misc Tablet','Malware Removal',20)
) as bt(model, repair, mins)
on bt.model = dm.name and bt.repair = rt.name and dty.name = 'Tablet'
on conflict (repair_type_id, device_model_id) do nothing;

-- Book Times (Desktop)
insert into book_times (repair_type_id, device_model_id, minutes)
select rt.id, dm.id, bt.mins
from repair_types rt
join device_types dty on rt.device_type_id = dty.id
join device_models dm on dm.device_type_id = dty.id
join (values
  ('Desktop','Misc Diagnosis',30),('Desktop','Liquid Diagnosis',60),
  ('Desktop','Motherboard',45),('Desktop','CPU',30),
  ('Desktop','CPU Fan Cooler',30),('Desktop','CPU Liquid Cooler',40),
  ('Desktop','RAM',20),('Desktop','GPU',30),('Desktop','PSU',40),
  ('Desktop','Fan',20),('Desktop','Re-case',120),('Desktop','Full Build',135),
  ('Desktop','Software Repair ($119, Simple)',15),
  ('Desktop','Software Repair ($169, Medium)',30),
  ('Desktop','Software Repair ($219, Advanced)',60)
) as bt(model, repair, mins)
on bt.model = dm.name and bt.repair = rt.name and dty.name = 'Desktop'
on conflict (repair_type_id, device_model_id) do nothing;

-- Book Times (Game Console)
insert into book_times (repair_type_id, device_model_id, minutes)
select rt.id, dm.id, bt.mins
from repair_types rt
join device_types dty on rt.device_type_id = dty.id
join device_models dm on dm.device_type_id = dty.id
join (values
  ('PS5','Misc Diagnosis',30),('PS5','Liquid Diagnosis',30),
  ('PS5','HDMI Port',60),('PS5','HDMI Encoder',75),
  ('PS5','Misc Port (USB/LAN/Etc)',60),('PS5','Replacement Thermals',45),
  ('PS5','PSU',45),('PS5','Misc Board Fault',75),
  ('PS4','Misc Diagnosis',30),('PS4','Liquid Diagnosis',30),
  ('PS4','HDMI Port',60),('PS4','HDMI Encoder',75),
  ('PS4','Misc Port (USB/LAN/Etc)',60),('PS4','Replacement Thermals',45),
  ('PS4','PSU',30),('PS4','Misc Board Fault',75),
  ('PS3/PS2','Misc Diagnosis',30),('PS3/PS2','Liquid Diagnosis',30),
  ('PS3/PS2','HDMI Port',60),('PS3/PS2','HDMI Encoder',75),
  ('PS3/PS2','Misc Port (USB/LAN/Etc)',60),('PS3/PS2','Replacement Thermals',45),
  ('PS3/PS2','PSU',30),('PS3/PS2','Misc Board Fault',75),
  ('Xbox Series X','Misc Diagnosis',30),('Xbox Series X','Liquid Diagnosis',30),
  ('Xbox Series X','HDMI Port',60),('Xbox Series X','HDMI Encoder',60),
  ('Xbox Series X','Misc Port (USB/LAN/Etc)',60),('Xbox Series X','Replacement Thermals',45),
  ('Xbox Series X','PSU',30),('Xbox Series X','Misc Board Fault',75),
  ('Xbox Series S','Misc Diagnosis',30),('Xbox Series S','Liquid Diagnosis',30),
  ('Xbox Series S','HDMI Port',60),('Xbox Series S','HDMI Encoder',60),
  ('Xbox Series S','Misc Port (USB/LAN/Etc)',60),('Xbox Series S','Replacement Thermals',30),
  ('Xbox Series S','PSU',30),('Xbox Series S','Misc Board Fault',60),
  ('Xbox One','Misc Diagnosis',30),('Xbox One','Liquid Diagnosis',30),
  ('Xbox One','HDMI Port',60),('Xbox One','HDMI Encoder',60),
  ('Xbox One','Misc Port (USB/LAN/Etc)',60),('Xbox One','Replacement Thermals',30),
  ('Xbox One','PSU',30),('Xbox One','Misc Board Fault',60)
) as bt(model, repair, mins)
on bt.model = dm.name and bt.repair = rt.name and dty.name = 'Game Console'
on conflict (repair_type_id, device_model_id) do nothing;

-- Book Times (Game Controller)
insert into book_times (repair_type_id, device_model_id, minutes)
select rt.id, dm.id, bt.mins
from repair_types rt
join device_types dty on rt.device_type_id = dty.id
join device_models dm on dm.device_type_id = dty.id
join (values
  ('DS5','Battery Replacement',15),('DS5','Stick Drift',30),
  ('DS5','Port/Rail Repair',30),('DS5','Bumper Repair',20),
  ('DS5','Trigger Repair',20),('DS5','Button Fix',20),('DS5','Clean/Tuneup',30),
  ('DS4','Battery Replacement',15),('DS4','Stick Drift',30),
  ('DS4','Port/Rail Repair',20),('DS4','Bumper Repair',20),
  ('DS4','Trigger Repair',20),('DS4','Button Fix',20),('DS4','Clean/Tuneup',30),
  ('DS Edge','Battery Replacement',15),('DS Edge','Stick Drift',30),
  ('DS Edge','Port/Rail Repair',40),('DS Edge','Bumper Repair',30),
  ('DS Edge','Trigger Repair',30),('DS Edge','Button Fix',30),('DS Edge','Clean/Tuneup',30),
  ('Xbox Core','Stick Drift',30),('Xbox Core','Port/Rail Repair',30),
  ('Xbox Core','Bumper Repair',20),('Xbox Core','Trigger Repair',25),
  ('Xbox Core','Button Fix',20),('Xbox Core','Clean/Tuneup',30),
  ('Xbox One Controller','Stick Drift',30),('Xbox One Controller','Port/Rail Repair',30),
  ('Xbox One Controller','Bumper Repair',20),('Xbox One Controller','Trigger Repair',25),
  ('Xbox One Controller','Button Fix',20),('Xbox One Controller','Clean/Tuneup',30),
  ('Xbox Elite S1','Misc Diagnosis',30),('Xbox Elite S1','Stick Drift',30),
  ('Xbox Elite S1','Port/Rail Repair',30),('Xbox Elite S1','Bumper Repair',20),
  ('Xbox Elite S1','Trigger Repair',25),('Xbox Elite S1','Button Fix',20),
  ('Xbox Elite S1','Clean/Tuneup',30),
  ('Xbox Elite S2','Misc Diagnosis',30),('Xbox Elite S2','Stick Drift',45),
  ('Xbox Elite S2','Port/Rail Repair',40),('Xbox Elite S2','Bumper Repair',30),
  ('Xbox Elite S2','Trigger Repair',30),('Xbox Elite S2','Button Fix',30),
  ('Xbox Elite S2','Clean/Tuneup',30),
  ('SCUF (Any)','Misc Diagnosis',30),('SCUF (Any)','Battery Replacement',20),
  ('SCUF (Any)','Stick Drift',60),('SCUF (Any)','Port/Rail Repair',60),
  ('SCUF (Any)','Bumper Repair',45),('SCUF (Any)','Trigger Repair',45),
  ('SCUF (Any)','Button Fix',45),('SCUF (Any)','Clean/Tuneup',45),
  ('1/2 S1 Joycons','Battery Replacement',15),('1/2 S1 Joycons','Stick Drift',20),
  ('1/2 S1 Joycons','Port/Rail Repair',20),('1/2 S1 Joycons','Bumper Repair',30),
  ('1/2 S1 Joycons','Trigger Repair',20),('1/2 S1 Joycons','Button Fix',20),
  ('1/2 S1 Joycons','Clean/Tuneup',20),
  ('1/2 S2 Joycons','Battery Replacement',15),('1/2 S2 Joycons','Stick Drift',20),
  ('1/2 S2 Joycons','Port/Rail Repair',20),('1/2 S2 Joycons','Bumper Repair',30),
  ('1/2 S2 Joycons','Trigger Repair',20),('1/2 S2 Joycons','Button Fix',20),
  ('1/2 S2 Joycons','Clean/Tuneup',20),
  ('Retro Cart (NES/SNES/N64/GB/GBA)','Misc Diagnosis',30),
  ('Retro Cart (NES/SNES/N64/GB/GBA)','Liquid Diagnosis',30),
  ('Retro Cart (NES/SNES/N64/GB/GBA)','Battery Replacement',20)
) as bt(model, repair, mins)
on bt.model = dm.name and bt.repair = rt.name and dty.name = 'Game Controller / Cartridge'
on conflict (repair_type_id, device_model_id) do nothing;

-- =============================================
-- ROW LEVEL SECURITY
-- =============================================
alter table technicians enable row level security;
alter table device_types enable row level security;
alter table device_models enable row level security;
alter table repair_types enable row level security;
alter table book_times enable row level security;
alter table tickets enable row level security;

-- Allow anon to read reference data
create policy "Public read device_types" on device_types for select using (true);
create policy "Public read device_models" on device_models for select using (true);
create policy "Public read repair_types" on repair_types for select using (true);
create policy "Public read book_times" on book_times for select using (true);
create policy "Public read technicians" on technicians for select using (true);

-- Allow anon to read/write tickets (PIN controls identity)
create policy "Public read tickets" on tickets for select using (true);
create policy "Public insert tickets" on tickets for insert with check (true);
create policy "Public update tickets" on tickets for update using (true);
create policy "Public delete tickets" on tickets for delete using (true);

-- Allow anon to update book_times (admin panel)
create policy "Public update book_times" on book_times for update using (true);
create policy "Public insert book_times" on book_times for insert with check (true);

-- Allow anon to manage reference data (admin panel)
create policy "Public insert device_types" on device_types for insert with check (true);
create policy "Public update device_types" on device_types for update using (true);
create policy "Public insert device_models" on device_models for insert with check (true);
create policy "Public update device_models" on device_models for update using (true);
create policy "Public insert repair_types" on repair_types for insert with check (true);
create policy "Public update repair_types" on repair_types for update using (true);
create policy "Public insert technicians" on technicians for insert with check (true);
create policy "Public update technicians" on technicians for update using (true);
