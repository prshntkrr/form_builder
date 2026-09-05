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
}
