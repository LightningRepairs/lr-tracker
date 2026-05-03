import { supabase } from './supabase';

let cache = null;

export async function getSettings() {
  if (cache) return cache;
  const { data } = await supabase.from('settings').select('*');
  if (data) {
    cache = {};
    data.forEach(s => { cache[s.key] = s.value; });
  }
  return cache || getDefaults();
}

export function getDefaults() {
  return {
    efficiency_green: '90',
    efficiency_yellow: '79',
    default_rows: '10',
    default_labor_multiplier: '0.3',
    shop_name: 'Lightning Repairs',
  };
}

export function clearSettingsCache() {
  cache = null;
}
