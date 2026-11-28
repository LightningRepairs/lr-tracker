// Book-time math, server side. Mirrors the same functions in public/index.html — keep the two in sync.

// RepairShopr "Issue Type" (ticket field problem_type) → Book Time Database category/subtype.
// "alt" = other sub-types whose models are also offered for that Issue Type (RS has no Handheld type,
// so Switch/Gameboy models are listed under Game Console).
export const ISSUE_TYPE_TO_DEVICE = {
  "Phone":           { category: "mobile",   subtype: "phone" },
  "Tablet":          { category: "mobile",   subtype: "tablet" },
  "Smart Watch":     { category: "mobile",   subtype: "watch" },
  "Laptop":          { category: "computer", subtype: "moduleLaptops" },
  "Desktop":         { category: "computer", subtype: "desktop" },
  "All-in-One":      { category: "computer", subtype: "allInOne" },
  "Game Console":    { category: "gaming",   subtype: "console", alt: ["handheld"] },
  "Game Controller": { category: "gaming",   subtype: "controller" },
  "Service/Consult": { category: "misc",     subtype: "misc" },
  "Other/Misc":      { category: "misc",     subtype: "misc" },
};
// The only Issue Types RepairShopr offers (Ticket → Type dropdown).
export const RS_ISSUE_TYPES = Object.keys(ISSUE_TYPE_TO_DEVICE);

/** Effective device: RS Issue Type decides the category; the picked model can switch to an "alt" sub-type. */
export function effectiveDevice(issueType, ts) {
  const mapped = issueType ? ISSUE_TYPE_TO_DEVICE[issueType] : null;
  if (!mapped) return { category: null, subtype: null, row: null, repairType: null };
  const subtype = ts?.device_subtype && (mapped.alt || []).includes(ts.device_subtype) ? ts.device_subtype : mapped.subtype;
  return { category: mapped.category, subtype, row: ts?.device_row || null, repairType: ts?.repair_type || null };
}

function gridFor(bookTimes, dev) {
  if (!dev.category || !dev.subtype) return null;
  return bookTimes?.[dev.category]?.subtypes?.[dev.subtype] || null;
}

export function diagnosticsMinutes(bookTimes, dev) {
  const g = gridFor(bookTimes, dev);
  if (!g) return null;
  const row = (dev.row && g.data[dev.row]) ? g.data[dev.row] : (g.rows.length ? g.data[g.rows[0]] : null);
  return row ? (row["Diagnostics"] ?? null) : null;
}

export function repairMinutes(bookTimes, dev, repairType) {
  const g = gridFor(bookTimes, dev);
  if (!g || !dev.row || !repairType || !g.data[dev.row]) return null;
  return g.data[dev.row][repairType] ?? null;
}

// Columns that aren't repair types you pick: Diagnostics (diagnosis credit) and Misc Repair ($ of profit per 1 minute,
// used by automatic book time when nothing else matches).
export const SPECIAL_COLS = ["Diagnostics", "Misc Repair"];
/** Minutes a repair type earns when done as an ADD-ON to another repair (null = can't be an add-on). */
export function addOnMinutes(bookTimes, dev, col) {
  const g = gridFor(bookTimes, dev);
  const v = g?.addOns?.[col];
  return v == null ? null : Number(v);
}
/** A ticket's repair book time: main repair + each add-on's add-on minutes. */
export function ticketBookMinutes(bookTimes, dev, repairType, addons = []) {
  let m = repairMinutes(bookTimes, dev, repairType) || 0;
  for (const a of addons || []) if (a && a !== repairType && !SPECIAL_COLS.includes(a)) m += addOnMinutes(bookTimes, dev, a) || 0;
  return Math.round(m);
}
/** Several repairs on one device (refurbs): the biggest is the main repair, the rest count as add-ons
 *  (full minutes if that repair has no add-on minutes set). */
export function multiRepairMinutes(bookTimes, dev, repairs = []) {
  const list = (repairs || []).filter(r => !SPECIAL_COLS.includes(r)).map(r => ({ r, full: repairMinutes(bookTimes, dev, r) || 0 })).sort((a, b) => b.full - a.full);
  return Math.round(list.reduce((sum, x, i) => sum + (i === 0 ? x.full : (addOnMinutes(bookTimes, dev, x.r) ?? x.full)), 0));
}

/** Book-time minutes a given outcome earns right now. */
export function creditedMinutes(bookTimes, dev, outcome) {
  if (outcome === "diagnosis_completed") return diagnosticsMinutes(bookTimes, dev) || 0;
  if (outcome === "repair_completed") return repairMinutes(bookTimes, dev, dev.repairType) || 0;
  return 0;
}
