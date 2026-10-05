// Book-time math, server side. Mirrors the same functions in public/index.html — keep the two in sync.

// RepairShopr "Issue Type" (ticket field problem_type) → Book Time Database category/subtype.
// Service/Consult and Other/Misc have no device standard, so they're intentionally unmapped.
export const ISSUE_TYPE_TO_DEVICE = {
  "Phone":           { category: "mobile",   subtype: "phone" },
  "Tablet":          { category: "mobile",   subtype: "tablet" },
  "Smart Watch":     { category: "mobile",   subtype: "watch" },
  "Laptop":          { category: "computer", subtype: "moduleLaptops" },
  "Desktop":         { category: "computer", subtype: "desktop" },
  "All-in-One":      { category: "computer", subtype: "allInOne" },
  "Game Console":    { category: "gaming",   subtype: "console" },
  "Game Controller": { category: "gaming",   subtype: "controller" },
};

/** Effective device for a ticket: a manual override in ticket_state wins, else Issue Type mapping. */
export function effectiveDevice(issueType, ts) {
  const mapped = issueType ? ISSUE_TYPE_TO_DEVICE[issueType] : null;
  const category = ts?.device_category || mapped?.category || null;
  const subtype = ts?.device_category ? (ts.device_subtype || null) : (ts?.device_subtype || mapped?.subtype || null);
  return { category, subtype, row: ts?.device_row || null, repairType: ts?.repair_type || null };
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

/** Book-time minutes a given outcome earns right now. */
export function creditedMinutes(bookTimes, dev, outcome) {
  if (outcome === "diagnosis_completed") return diagnosticsMinutes(bookTimes, dev) || 0;
  if (outcome === "repair_completed") return repairMinutes(bookTimes, dev, dev.repairType) || 0;
  return 0;
}
