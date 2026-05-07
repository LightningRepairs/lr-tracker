-- Migration 10: Add work day and pace settings
insert into settings (key, value, label, description) values
  ('work_day_start', '09:00', 'Work day start time', 'Start of work day for the pace tracker (24h format, e.g. 09:00)'),
  ('work_day_end', '18:00', 'Work day end time', 'End of work day for the pace tracker (24h format, e.g. 18:00)'),
  ('pace_yellow_threshold', '45', 'Yellow pace threshold (min)', 'How many minutes behind expected before turning yellow. Beyond this = red.')
on conflict (key) do nothing;
