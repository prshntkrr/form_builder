import MediaField from './MediaField.jsx'
import React from 'react'

/** One control for one field. Types match the backend registry. */
export default function FieldInput({ field, value, onChange, error, media }) {
  const v = field.validation || {}
  const set = (val) => onChange(field.name, val)

  const base = {
    id: `f_${field.name}`,
    name: field.name,
    placeholder: field.placeholder || '',
    'aria-invalid': error ? 'true' : undefined,
    className: `control${error ? ' control--bad' : ''}`,
  }

  const toggleIn = (option) => {
    const list = Array.isArray(value) ? value : []
    set(list.includes(option) ? list.filter((x) => x !== option) : [...list, option])
  }

  /** A digit cap is about length, not magnitude, and maxLength does nothing on
   *  a number input — so refuse the keystroke that would overrun it. */
  const setCapped = (next) => {
    if (v.max_length && String(next).replace(/\D/g, '').length > Number(v.max_length)) return
    set(next)
  }

  let control

  switch (field.type) {
    case 'textarea':
      control = <textarea {...base} rows={4} value={value ?? ''} onChange={(e) => set(e.target.value)} />
      break

    case 'number':
    case 'decimal':
      control = (
        <input
          {...base}
          type="number"
          step={field.type === 'decimal' ? (v.step ?? 'any') : (v.step ?? 1)}
          min={v.min ?? undefined}
          max={v.max ?? undefined}
          value={value ?? ''}
          onChange={(e) => setCapped(e.target.value)}
        />
      )
      break

    case 'rating': {
      const max = Number(v.max ?? 5)
      control = (
        <div className="stars">
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              className={`star${Number(value) >= n ? ' on' : ''}`}
              onClick={() => set(Number(value) === n ? '' : n)}
              aria-label={`${n} of ${max}`}
            >★</button>
          ))}
        </div>
      )
      break
    }

    case 'date':
      control = <input {...base} type="date" value={value ?? ''} onChange={(e) => set(e.target.value)} />
      break

    case 'datetime':
      control = <input {...base} type="datetime-local" value={value ?? ''} onChange={(e) => set(e.target.value)} />
      break

    case 'time':
      control = <input {...base} type="time" value={value ?? ''} onChange={(e) => set(e.target.value)} />
      break

    case 'email':
      control = <input {...base} type="email" value={value ?? ''} onChange={(e) => set(e.target.value)} />
      break

    case 'phone':
      control = <input {...base} type="tel" value={value ?? ''} onChange={(e) => setCapped(e.target.value)} />
      break

    case 'url':
      control = <input {...base} type="url" value={value ?? ''} onChange={(e) => set(e.target.value)} />
      break

    case 'boolean':
      control = (
        <label className="toggle">
          <input
            type="checkbox"
            checked={value === true || value === 'true'}
            onChange={(e) => set(e.target.checked)}
          />
          <span className="toggle__track" />
          <span className="muted">{value === true || value === 'true' ? 'Yes' : 'No'}</span>
        </label>
      )
      break

    case 'select':
      control = (
        <select {...base} value={value ?? ''} onChange={(e) => set(e.target.value)}>
          <option value="">{field.placeholder || 'Choose'}</option>
          {(field.options || []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      )
      break

    case 'radio':
      control = (
        <div className="choices">
          {(field.options || []).map((o) => (
            <label key={o.value} className="choice">
              <input
                type="radio"
                name={field.name}
                checked={String(value ?? '') === String(o.value)}
                onChange={() => set(o.value)}
              />
              {o.label}
            </label>
          ))}
        </div>
      )
      break

    case 'multiselect':
      control = (
        <div className="choices">
          {(field.options || []).map((o) => (
            <label key={o.value} className="choice">
              <input
                type="checkbox"
                checked={Array.isArray(value) && value.includes(o.value)}
                onChange={() => toggleIn(o.value)}
              />
              {o.label}
            </label>
          ))}
        </div>
      )
      break

    case 'location': {
      const at = value && typeof value === 'object' ? value : {}
      const part = (key, val) => set({ ...at, [key]: val === '' ? undefined : Number(val) })
      control = (
        <div className="row row--tight">
          <input className="control grow" type="number" step="any" placeholder="Latitude"
                 value={at.lat ?? ''} onChange={(e) => part('lat', e.target.value)} />
          <input className="control grow" type="number" step="any" placeholder="Longitude"
                 value={at.lng ?? ''} onChange={(e) => part('lng', e.target.value)} />
          <button
            type="button"
            className="btn btn--sm"
            disabled={!navigator.geolocation}
            onClick={() =>
              navigator.geolocation.getCurrentPosition((p) =>
                set({ lat: Number(p.coords.latitude.toFixed(6)), lng: Number(p.coords.longitude.toFixed(6)) }),
              )
            }
          >Locate me</button>
        </div>
      )
      break
    }

    // A photo, a recording or a document. One control for all three — what
    // differs is what it accepts and whether it opens a camera.
    case 'image':
    case 'audio':
    case 'file':
      control = (
        <MediaField
          field={field}
          value={value}
          onChange={onChange}
          error={error}
          onPick={media?.onPick}
          uploading={media?.uploading}
        />
      )
      break

    case 'signature':
      control = (
        <input {...base} type="text" placeholder={field.placeholder || 'Type your name to sign'}
               value={value ?? ''} onChange={(e) => set(e.target.value)} />
      )
      break

    default:
      control = (
        <input {...base} type="text" maxLength={v.max_length ?? undefined}
               value={value ?? ''} onChange={(e) => set(e.target.value)} />
      )
  }

  return (
    <div className="field">
      <label htmlFor={`f_${field.name}`}>
        {field.label}
        {field.required && <span className="star-req"> *</span>}
      </label>
      {control}
      {field.help_text && <span className="field__note">{field.help_text}</span>}
      {error && <span className="field__bad">{error}</span>}
    </div>
  )
}
