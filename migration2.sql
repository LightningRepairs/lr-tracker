-- Run this in Supabase SQL Editor

-- Settings table
create table if not exists settings (
  key text primary key,
  value text not null,
  label text,
  description text,
  updated_at timestamptz default now()
);

-- Default settings
insert into settings (key, value, label, description) values
  ('efficiency_green', '90', 'Green threshold (%)', 'At or above this % = green (on pace)'),
  ('efficiency_yellow', '79', 'Yellow threshold (%)', 'At or above this % = yellow (moderate). Below = red.'),
  ('default_rows', '10', 'Default rows', 'How many blank rows to start with on a fresh sheet'),
  ('default_labor_multiplier', '0.3', 'Default labor multiplier', 'Default multiplier when adding a new Labor repair type (e.g. 0.3 = Labor x 0.3)'),
  ('shop_name', 'Lightning Repairs', 'Shop name', 'Displayed in the app header and on reports')
on conflict (key) do nothing;

-- RLS
alter table settings enable row level security;
create policy "Public read settings" on settings for select using (true);
create policy "Public update settings" on settings for update using (true);
create policy "Public insert settings" on settings for insert with check (true);

-- Also add labor_multiplier column if not already there
alter table repair_types add column if not exists labor_multiplier numeric(6,4) default 0.3;
update repair_types set labor_multiplier = 0.3 where is_labor = true and labor_multiplier is null;
