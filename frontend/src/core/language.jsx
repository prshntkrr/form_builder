import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { request } from './http.js'

const STORAGE_KEY = '_language'
const LanguageContext = createContext(null)

export function LanguageProvider({ children }) {
  const [language, setLanguageState] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) || 'en-US' } catch { return 'en-US' }
  })
  const [pack, setPack] = useState({})
  const [languages, setLanguages] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    request('/languages').then(setLanguages).catch(() => {})
  }, [])

  useEffect(() => {
    setLoading(true)
    request(`/languages/${language}`)
      .then(data => {
        setPack(data?.pack || {})
        try { localStorage.setItem(STORAGE_KEY, language) } catch {}
      })
      .catch(() => setPack({}))
      .finally(() => setLoading(false))
  }, [language])

  const setLanguage = useCallback((lang) => setLanguageState(lang), [])
  const t = useCallback((key) => pack[key] || key, [pack])

  return (
    <LanguageContext.Provider value={{ language, setLanguage, languages, t, loading, pack }}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useTranslation() { return useContext(LanguageContext) }

export function T({ k }) {
  const { t } = useTranslation()
  return t(k)
}
