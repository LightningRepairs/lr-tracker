// 📤 Automatic "so far today" card sales report → Discord, on a schedule the admin sets.
// Runs from the every-minute background job; also "Send a test now" from Admin Console.
import { jsPDF } from "jspdf";
import { applyPlugin } from "jspdf-autotable";
import { db } from "./db.mjs";
import { SHOP_TZ, today } from "./time.mjs";
import { encryptSecret, decryptSecret, last4 } from "./secrets.mjs";
import { syncCardSales, cardSalesFor, namedReaders, valorConfigured } from "./valor.mjs";
applyPlugin(jsPDF);

export const DEFAULT_MESSAGE = "Here's today's card sales so far: **{net}** from {sales} sales.";
export const DEFAULT_AUTO = { enabled: false, mode: "times", times: ["18:00"], hourlyFrom: "10:00", hourlyTo: "18:00", days: [1, 2, 3, 4, 5, 6], readers: "all", message: DEFAULT_MESSAGE };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function getAutoSettings() {
  const [row] = await db()`select value from settings where key = 'cc_auto'`;
  return { ...DEFAULT_AUTO, ...(row?.value || {}) };
}
export function cleanAutoSettings(b) {
  const s = { ...DEFAULT_AUTO };
  s.enabled = !!b.enabled;
  s.mode = b.mode === "hourly" ? "hourly" : "times";
  s.times = [...new Set((Array.isArray(b.times) ? b.times : []).map(String).filter(t => HHMM.test(t)))].sort().slice(0, 24);
  if (!s.times.length) s.times = ["18:00"];
  s.message = typeof b.message === "string" ? b.message.replace(/\r/g, "").trim().slice(0, 1500) : DEFAULT_MESSAGE;
  s.hourlyFrom = HHMM.test(b.hourlyFrom) ? b.hourlyFrom : DEFAULT_AUTO.hourlyFrom;
  s.hourlyTo = HHMM.test(b.hourlyTo) ? b.hourlyTo : DEFAULT_AUTO.hourlyTo;
  if (s.hourlyTo < s.hourlyFrom) [s.hourlyFrom, s.hourlyTo] = [s.hourlyTo, s.hourlyFrom];
  s.days = [...new Set((Array.isArray(b.days) ? b.days : []).map(Number).filter(d => d >= 0 && d <= 6))].sort();
  s.readers = ["all", "each"].includes(b.readers) ? b.readers : (/^\d$/.test(String(b.readers)) ? String(b.readers) : "all");
  return s;
}

// ---- Discord webhook (saved encrypted; Netlify's DISCORD_WEBHOOK_URL is the fallback) ----
const isWebhook = u => /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(u);
export async function webhookInfo() {
  const [row] = await db()`select value from settings where key = 'discord_webhook'`;
  if (row?.value?.enc) return { source: "admin", last4: row.value.last4 };
  if (process.env.DISCORD_WEBHOOK_URL) return { source: "netlify", last4: last4(process.env.DISCORD_WEBHOOK_URL.trim()) };
  return null;
}
async function webhookUrl() {
  const [row] = await db()`select value from settings where key = 'discord_webhook'`;
  try { if (row?.value?.enc) return decryptSecret(row.value.enc); } catch {}
  return (process.env.DISCORD_WEBHOOK_URL || "").trim() || null;
}
export async function setWebhook(url) {
  const sql = db();
  if (url == null || url === "") { await sql`delete from settings where key = 'discord_webhook'`; return webhookInfo(); }
  const u = String(url).trim().split("?")[0];
  if (!isWebhook(u)) throw new Error("That doesn't look like a Discord webhook URL — it should start with https://discord.com/api/webhooks/");
  await sql`insert into settings (key, value) values ('discord_webhook', ${sql.json({ enc: encryptSecret(u), last4: last4(u) })})
            on conflict (key) do update set value = excluded.value`;
  return webhookInfo();
}

// ---- schedule ----
function shopNow(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: SHOP_TZ, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(d).map(x => [x.type, x.value]));
  return { day: today(), dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday), hhmm: `${p.hour}:${p.minute}` };
}
export function slotsFor(s) {
  if (s.mode === "hourly") {
    const out = [], [fh, fm] = s.hourlyFrom.split(":").map(Number), th = Number(s.hourlyTo.split(":")[0]), tm = Number(s.hourlyTo.split(":")[1]);
    for (let h = fh; h <= 23; h++) { const t = `${String(h).padStart(2, "0")}:${String(fm).padStart(2, "0")}`; if (h > th || (h === th && fm > tm)) break; out.push(t); }
    return out;
  }
  return s.times;
}
const minutes = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
/** The slot that's due right now (at most 15 minutes late), or null. */
export function dueSlot(s, now = shopNow()) {
  if (!s.enabled || !s.days.includes(now.dow)) return null;
  const n = minutes(now.hhmm);
  const due = slotsFor(s).filter(t => minutes(t) <= n && n - minutes(t) <= 15).pop();
  return due ? `${now.day}T${due}` : null;
}

// ---- the report ----
const usd = c => "$" + ((Number(c) || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortDay = day => new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric", timeZone: "UTC" });
const nowLabel = () => new Date().toLocaleString("en-US", { timeZone: SHOP_TZ, month: "numeric", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const TABLE = { theme: "grid", styles: { fontSize: 9, cellPadding: 4 }, headStyles: { fillColor: [22, 50, 92] }, footStyles: { fillColor: [235, 240, 248], textColor: 20, fontStyle: "bold" }, margin: { left: 40, right: 40 } };
export function cardPdfBuffer(d, label) {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.text("Lightning Repairs - Card sales (so far today)", 40, 48);
  doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(90);
  doc.text(`${shortDay(d.day)} - ${label} - automatic report, generated ${nowLabel()}`, 40, 64);
  doc.setTextColor(0);
  doc.autoTable({ ...TABLE, startY: 80, head: [["", "Count", "Amount"]], tableWidth: 300,
    body: [["Sales", String(d.salesCount), usd(d.salesCents)], ["Refunds", String(d.refundCount), d.refundCount ? "-" + usd(d.refundCents) : usd(0)], ["Voided (not counted)", String(d.voidCount), ""]],
    foot: [["Net card sales", "", usd(d.netCents)]] });
  if (d.byBrand.length) doc.autoTable({ ...TABLE, startY: doc.lastAutoTable.finalY + 14, head: [["Card", "Net"]], body: d.byBrand.map(b => [b.brand, usd(b.cents)]), tableWidth: 300 });
  doc.setFontSize(11); doc.setFont("helvetica", "bold"); doc.text("Transactions", 40, doc.lastAutoTable.finalY + 24); doc.setFont("helvetica", "normal");
  const multi = label === "All readers";
  doc.autoTable({ ...TABLE, startY: doc.lastAutoTable.finalY + 30, head: [["Time", ...(multi ? ["Reader"] : []), "Type", "Card", "Card type", "Amount"]],
    body: d.txns.length ? d.txns.map(t => [t.time || "", ...(multi ? [t.reader] : []), t.type === "sale" ? "Sale" : t.type === "refund" ? "Refund" : "Voided", t.scheme || "", t.cardType || "", (t.type === "refund" ? "-" : "") + usd(Math.abs(t.amount)) + (t.type === "void" ? " (void)" : "")])
      : [["No card transactions yet today", ...(multi ? [""] : []), "", "", "", ""]],
    columnStyles: { [multi ? 5 : 4]: { halign: "right" } } });
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(120);
    doc.text("From the Valor card terminal. Voids are left out of the total; refunds are subtracted. No card numbers or transaction ids.", 40, doc.internal.pageSize.getHeight() - 24, { maxWidth: 440 });
    doc.text(`Page ${i} of ${pages}`, doc.internal.pageSize.getWidth() - 40, doc.internal.pageSize.getHeight() - 24, { align: "right" }); }
  return Buffer.from(doc.output("arraybuffer"));
}
async function postDiscord(url, content, files) {
  const form = new FormData();
  form.append("payload_json", JSON.stringify({ content, allowed_mentions: { parse: ["users", "roles"] } })); // @people / @roles ping; never @everyone
  files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.buf], { type: "application/pdf" }), f.name));
  const target = process.env.DISCORD_TEST_SINK || url;   // DISCORD_TEST_SINK: local testing only
  const res = await fetch(target + "?wait=true", { method: "POST", body: form, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Discord said HTTP ${res.status}${res.status === 404 ? " (that webhook was deleted — make a new one)" : ""}`);
}

/** Build + send the report now. Returns a short result for the admin screen. */
export async function sendCardReport({ reason = "scheduled", settings } = {}) {
  const s = settings || await getAutoSettings();
  const url = await webhookUrl();
  if (!url) throw new Error("No Discord webhook saved yet");
  if (!valorConfigured()) throw new Error("Valor isn't set up (VALOR_ keys in Netlify)");
  const readers = await namedReaders();
  const picks = s.readers === "each" ? readers.map(r => ({ id: r.id, label: r.name }))
    : s.readers === "all" || readers.length < 2 ? [{ id: s.readers !== "all" && readers.some(r => r.id === s.readers) ? s.readers : (readers.length < 2 ? readers[0].id : null), label: readers.length < 2 ? readers[0].name : "All readers" }]
    : [{ id: s.readers, label: (readers.find(r => r.id === s.readers) || {}).name || "Reader" }];
  const day = today();
  const sync = await syncCardSales({ maxAgeSec: 0 });
  const lines = [], files = [], tot = { net: 0, sales: 0, refunds: 0 };
  for (const p of picks) {
    const d = await cardSalesFor(day, p.id);
    tot.net += d.netCents; tot.sales += d.salesCount; tot.refunds += d.refundCount;
    lines.push(`**${p.label}:** net **${usd(d.netCents)}** · ${d.salesCount} sale${d.salesCount === 1 ? "" : "s"}${d.refundCount ? ` · ${d.refundCount} refund${d.refundCount === 1 ? "" : "s"} (${usd(d.refundCents)})` : ""}${d.voidCount ? ` · ${d.voidCount} voided` : ""}`);
    files.push({ name: `LR-card-sales-${day}-${p.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.pdf`, buf: cardPdfBuffer(d, p.label) });
  }
  const head = `💳 **Card sales so far today** — ${shortDay(day)}, as of ${new Date().toLocaleTimeString("en-US", { timeZone: SHOP_TZ, hour: "numeric", minute: "2-digit" })}${reason === "test" ? " _(test)_" : ""}`;
  const warn = sync.errors.length ? `\n⚠️ ${sync.errors.join(" · ").slice(0, 300)}` : "";
  // The admin's own message on top, with {placeholders} filled in.
  const asOf = new Date().toLocaleTimeString("en-US", { timeZone: SHOP_TZ, hour: "numeric", minute: "2-digit" });
  const vars = { net: usd(tot.net), sales: String(tot.sales), refunds: String(tot.refunds), date: shortDay(day), time: asOf, readers: picks.map(p => p.label).join(", ") };
  const custom = String(s.message ?? DEFAULT_MESSAGE).replace(/\{(net|sales|refunds|date|time|readers)\}/g, (_, k) => vars[k]).replace(/@(everyone|here)/g, "@\u200b$1");
  const content = [custom, custom ? "" : null, head, ...lines].filter(x => x !== null).join("\n") + warn;
  await postDiscord(url, content.slice(0, 1990), files);
  return { ok: true, lines };
}

/** Called every minute by the background job. Sends at most once per slot. */
export async function runScheduledCardReport() {
  const s = await getAutoSettings();
  const slot = dueSlot(s);
  if (!slot) return null;
  const sql = db();
  // Claim the slot atomically so two overlapping runs can't both send it.
  const claimed = await sql`insert into settings (key, value) values ('cc_auto_last', ${sql.json({ slot })})
    on conflict (key) do update set value = excluded.value
    where (settings.value->>'slot') is null or (settings.value->>'slot') < ${slot} returning key`;
  if (!claimed.length) return null;
  try {
    await sendCardReport({ settings: s });
    await sql`update settings set value = value || ${sql.json({ ok: true, at: new Date().toISOString(), error: null })} where key = 'cc_auto_last'`;
    return `sent ${slot}`;
  } catch (e) {
    await sql`update settings set value = value || ${sql.json({ ok: false, at: new Date().toISOString(), error: e.message.slice(0, 300) })} where key = 'cc_auto_last'`;
    await sql`insert into notifications (kind, data) values ('cc_auto_failed', ${sql.json({ slot, error: e.message.slice(0, 300) })})`;
    return `FAILED ${slot}: ${e.message}`;
  }
}
export async function lastAutoRun() {
  const [row] = await db()`select value from settings where key = 'cc_auto_last'`;
  return row?.value || null;
}
