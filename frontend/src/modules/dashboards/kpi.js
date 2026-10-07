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


/**
 * The character a title icon is drawn with.
 *
 * Moved here from the dashboard page so that a KPI card can be drawn
 * wherever one is needed — the builder, and a dashboard someone opened from
 * a public link — rather than only where this map happened to live.
 *
 * Every id here must also be an option in the Title Icon picker, or an icon
 * guessed for a KPI could not be changed by hand.
 */
const ICONS = {
  users: "\u{1F465}",
  user: "\u{1F464}",
  students: "\u{1F393}",
  school: "\u{1F3EB}",
  chart: "\u{1F4CA}",
  money: "\u{1F4B0}",
  location: "\u{1F4CD}",
  agriculture: "\u{1F33E}",
  farm: "\u{1F69C}",
  calendar: "\u{1F4C5}",
  male: "\u{1F468}",
  female: "\u{1F469}",
  land: "\u{1F5FA}\uFE0F",
  production: "\u{1F4E6}",
  percent: "\uFF05",
}

export function iconSymbol(iconId) {
  return ICONS[iconId] || null
}

/**
 * The one number a KPI card shows, as the card writes it.
 *
 * This was worked out inside the renderer, which was enough while drawing the
 * card was the only thing that needed it. Exporting a KPI's data has to
 * produce the figure somebody is looking at — not the raw row, which for a
 * percentage card is the denominator and reads as a wildly different number.
 * So the derivation lives here and the card calls it.
 *
 * Returns null when there is no row at all, which is the card's "No data
 * available." and an export with nothing to say.
 */
export function kpiDisplayValue(widget, rows = [], numRows = null) {
  const firstRow = rows?.[0]

  if (!firstRow) {
    return null
  }

  const measure = widget?.data_binding?.measures?.[0]

  if (widget?.kpi?.format === "percentage" && widget.kpi.numerator) {
    // A percentage card counts rows, so its denominator is a COUNT whatever
    // the measure's own aggregation says.
    const denomAlias = measure ? `${measure.field}_count` : null

    const denomValue = denomAlias
      ? Number(firstRow[denomAlias] || 0)
      : Number(Object.values(firstRow)[0] || 0)

    const numRow = numRows ? numRows[0] : null

    const numValue = numRow && denomAlias
      ? Number(numRow[denomAlias] || 0)
      : numRow
        ? Number(Object.values(numRow)[0] || 0)
        : 0

    return denomValue === 0
      ? "0%"
      : `${Math.round((numValue / denomValue) * 100)}%`
  }

  const measureAlias = measure
    ? `${measure.field}_${measure.aggregation.toLowerCase()}`
    : null

  // Formatted for reading, never rounded on the way in: the value the
  // server calculated is what the widget still holds.
  return formatKpiValue(
    measureAlias ? firstRow[measureAlias] : Object.values(firstRow)[0],
  )
}
