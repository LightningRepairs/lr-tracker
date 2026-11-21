// Shop-local dates. "Today" always means today in the shop's timezone, not the server's (UTC).
export const SHOP_TZ = process.env.SHOP_TZ || "America/Indiana/Indianapolis";

const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: SHOP_TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** YYYY-MM-DD in the shop's timezone for a Date / ISO string / ms. */
export function shopDate(d = new Date()) {
  return dateFmt.format(d instanceof Date ? d : new Date(d));
}
export function today() { return shopDate(new Date()); }

/** ISO timestamp for local midnight of the shop's current day (good enough for RS since_updated_at). */
/** "-05:00"-style UTC offset of the shop timezone on a given day (handles daylight saving). */
export function shopOffset(day) {
  const at = day ? new Date(day + "T12:00:00Z") : new Date();
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: SHOP_TZ, timeZoneName: "longOffset" }).formatToParts(at);
  return (parts.find(p => p.type === "timeZoneName")?.value || "GMT").replace("GMT", "") || "+00:00";
}
/** Time of day (HH:MM:SS) of an ISO timestamp, in shop time. */
export function shopTimeOfDay(iso) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: SHOP_TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}
export function startOfShopDayISO() {
  const now = new Date();
  // Find the UTC offset of the shop timezone right now.
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: SHOP_TZ, timeZoneName: "longOffset" }).formatToParts(now);
  const off = (parts.find(p => p.type === "timeZoneName")?.value || "GMT").replace("GMT", "") || "+00:00";
  return `${today()}T00:00:00${off}`;
}
