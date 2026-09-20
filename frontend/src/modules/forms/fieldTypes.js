/** Field types, in the order they're offered, with the names people see. */
export const TYPES = [
  ['text', 'Short text'],
  ['textarea', 'Paragraph'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['url', 'Link'],
  ['number', 'Whole number'],
  ['decimal', 'Decimal'],
  ['rating', 'Rating'],
  ['date', 'Date'],
  ['datetime', 'Date & time'],
  ['time', 'Time'],
  ['boolean', 'Yes / no'],
  ['select', 'Dropdown'],
  ['radio', 'Single choice'],
  ['multiselect', 'Multiple choice'],
  ['image', 'Photo'],
  ['audio', 'Audio recording'],
  ['file', 'File'],
  ['signature', 'Signature'],
  ['location', 'Location'],
  ['polygon', 'Polygon'],
]

const NAMES = Object.fromEntries(TYPES)

export const typeName = (type) => NAMES[type] || type

export const WITH_OPTIONS = new Set(['select', 'radio', 'multiselect'])

/** Have a value worth bounding with a smallest / largest. */
export const NUMERIC = new Set(['number', 'decimal', 'rating'])

/** Length limits count digits here, not characters — mirrors the backend registry. */
export const DIGITS = new Set(['number', 'decimal', 'rating', 'phone'])

export const TEXTUAL = new Set(['text', 'textarea', 'email', 'phone', 'url'])

/**
 * How each answer is represented once it is stored, and the column its value
 * takes in the flat `<form>_tabular` mirror.
 *
 * Presentational only — the Variable tab shows it so a designer can see what a
 * question actually becomes. `backend/app/modules/forms/field_types.py` is the
 * authority; this mirrors it and nothing reads it to make a decision.
 */
export const STORAGE = {
  text: ['string', 'VARCHAR(255)'],
  textarea: ['string', 'TEXT'],
  email: ['string', 'VARCHAR(255)'],
  phone: ['string', 'VARCHAR(20)'],
  url: ['string', 'TEXT'],
  number: ['number', 'INTEGER'],
  decimal: ['number', 'NUMERIC(18,4)'],
  rating: ['number', 'INTEGER'],
  date: ['string (YYYY-MM-DD)', 'DATE'],
  datetime: ['string (ISO 8601)', 'TIMESTAMP'],
  time: ['string (HH:MM:SS)', 'TIME'],
  boolean: ['boolean', 'BOOLEAN'],
  select: ['string', 'VARCHAR(255)'],
  radio: ['string', 'VARCHAR(255)'],
  multiselect: ['array', 'TEXT'],
  // Three media types, one behaviour: the answer is the id of the uploaded
  // object's row. The object itself is in S3, never in form_data.
  image: ['string (media id)', 'TEXT'],
  audio: ['string (media id)', 'TEXT'],
  file: ['string (media id)', 'TEXT'],
  signature: ['string', 'TEXT'],
  location: ['object {lat, lng}', 'TEXT'],
  // A ring of [longitude, latitude] pairs — GeoJSON order, the same order the
  // geofence rings use. Stored the way a location is: in form_data, mirrored
  // as TEXT. Mirrors backend/app/modules/forms/field_types.py.
  polygon: ['array [[lng, lat], …]', 'TEXT'],
}

/**
 * A question's key, from whatever it is called.
 *
 * The mirror of `slugify_identifier` in backend/app/modules/forms/form_schema.py,
 * **including its length**: a key becomes a Postgres column, and Postgres stops
 * at 63 bytes, so the backend has always cut one at 55 characters. This did
 * not, so a question written as a sentence — or a form with a long title —
 * produced a key the server then refused with "String should have at most 55
 * characters", about a property nobody had typed.
 */
export const MAX_IDENTIFIER = 55

/**
 * How long a question's key may be.
 *
 * Longer than a Postgres name, because it is not one: the key is where the
 * answer sits in `form_data`, what a rule names and what the layout points at.
 * The one place it used to have to be a column — the flat reporting mirror —
 * maps a long key to a short column server-side, so 150 is safe here.
 * A *table* name is still a Postgres name: pass MAX_IDENTIFIER for that.
 */
export const MAX_FIELD_NAME = 150

export const identifier = (text, limit = MAX_FIELD_NAME) => {
  let ident = String(text || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
  if (!ident) return ''
  // Postgres identifiers may not start with a digit.
  if (/^[0-9]/.test(ident)) ident = `f_${ident}`
  return ident.slice(0, limit).replace(/_+$/, '')
}

/**
 * Whether a question is hidden outright — `config.hide`.
 *
 * A flat `hide` is read too, for a definition written that way by an import or
 * a model. Everything that decides what to *show* goes through
 * `conditions.hidden`, which folds this in with the rules; this is the one
 * place that reads the flag itself.
 */
export const fieldHidden = (field) => {
  const config = field?.config
  if (config && typeof config === 'object' && 'hide' in config) return Boolean(config.hide)
  return Boolean(field?.hide)
}

/** A question's settings as they are stored. Every new question gets these. */
export const fieldConfig = (field) => ({ ...(field?.config || {}), hide: fieldHidden(field) })
