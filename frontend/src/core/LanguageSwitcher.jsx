import React from 'react'
import { useTranslation } from './language.jsx'

export default function LanguageSwitcher({ style }) {
  const { language, setLanguage, languages } = useTranslation()
  if (!languages.length) return null
  return (
    <select
      className="control"
      value={language}
      onChange={e => setLanguage(e.target.value)}
      style={{ width: 'auto', fontSize: 12, padding: '2px 8px', ...style }}
    >
      {languages.map(l => (
        <option key={l.language} value={l.language}>{l.label}</option>
      ))}
    </select>
  )
}
