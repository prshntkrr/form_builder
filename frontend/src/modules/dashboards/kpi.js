/**
 * What a KPI shows: the number, formatted, and the icon beside it.
 *
 * Kept out of the page and free of JSX so both rules can be read — and
 * tested — on their own. Neither touches the stored value: a KPI is
 * calculated by the server and only presented here.
 */

/** The icon ids `getIconSymbol` knows, by what a KPI is likely to be about.
 *
 *  Order matters: "female" has to be tried before "male", because the word
 *  contains it. Everything else is first-match-wins down the list. */
const ICON_RULES = [
  ["female", /\bfemale|\bwomen\b|\bwoman\b|\bgirls?\b/],
  ["male", /\bmale|\bmen\b|\bman\b|\bboys?\b/],
  ["land", /\bland\b|\barea\b|\bplot|\bhectare|\bacre|\bfield/],
  ["production", /\bproduction\b|\byield\b|\bharvest|\boutput\b|\bproduced\b/],
  ["money", /\brevenue\b|\bincome\b|\bprice\b|\bcost\b|\bsold\b|\bsales?\b|\bprofit\b|\bwage/],
  ["students", /\bstudents?\b/],
  ["school", /\bschools?\b/],
  ["users", /\bfarmers?\b|\bpeople\b|\brespondents?\b|\bhouseholds?\b|\bmembers?\b|\busers?\b|\bsurveyed\b|\breached\b/],
  ["location", /\bvillages?\b|\bdistricts?\b|\bstates?\b|\bmunicipalit|\blocation/],
  ["calendar", /\bdates?\b|\byears?\b|\bseasons?\b|\bmonths?\b/],
  ["agriculture", /\bcrops?\b|\brice\b|\bwheat\b|\bmaize\b|\bseeds?\b|\bvariet/],
]

/** The icon id for a KPI, or null for none.
 *
 *  A chosen icon always wins: the widget's own `presentation.title_icon` is
 *  somebody's decision, and guessing over it would make the picker useless.
 *  Otherwise the title and the field being measured are read for a subject. */
export function kpiIconId(widget) {
  const chosen = widget?.presentation?.title_icon
  if (chosen) return chosen

  const measure = widget?.data_binding?.measures?.[0]
  // Underscores are word characters, so `total_production` holds no word
  // boundary before "production" and every rule below would miss it. Column
  // names are snake_case, so they are read as the words they are.
  const subject = `${widget?.title || ''} ${measure?.label || ''} ${measure?.field || ''}`
    .toLowerCase()
    .replace(/_/g, ' ')

  if (widget?.kpi?.format === 'percentage') return 'percent'

  for (const [id, pattern] of ICON_RULES) {
    if (pattern.test(subject)) return id
  }

  return 'chart'
}

/** A KPI value as somebody should read it.
 *
 *  An average arrives from Postgres as 6.125301204819277, which is precision
 *  nobody asked for and which pushes the number out of its card. Two decimals
 *  and thousands separators, and whole numbers stay whole.
 *
 *  A percentage arrives already finished ("50%") and is passed straight
 *  through — the percentage rule lives with the calculation, not here. */
export function formatKpiValue(raw) {
  if (raw === null || raw === undefined || raw === '') return '0'

  // Already formatted, or simply not a number: show what it is rather than
  // turning it into NaN.
  if (typeof raw === 'string' && raw.trim().endsWith('%')) return raw

  const value = Number(raw)
  if (!Number.isFinite(value)) return String(raw)

  if (Number.isInteger(value)) {
    return value.toLocaleString(undefined, { maximumFractionDigits: 0 })
  }

  // Two decimals would render a genuinely small number as "0.00", which reads
  // as nothing at all. Below that threshold, keep enough of it to be true.
  if (Math.abs(value) < 0.01) {
    return value.toLocaleString(undefined, { maximumSignificantDigits: 2 })
  }

  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}
