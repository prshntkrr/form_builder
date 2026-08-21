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
