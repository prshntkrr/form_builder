import React, { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { startRecording, toPcm16, seconds, supported } from './voiceRecorder.js'

/**
 * Setting up voice sign-in for somebody.
 *
 * Several short recordings rather than one, because averaging them cancels the
 * particular noise of each take — and because three takes is how the server can
 * tell that the same person made all of them. An enrolment where somebody else
 * spoke into take two would otherwise read as a success and fail every sign-in
 * afterwards.
 *
 * The person being enrolled is in the room; this screen is for whoever is adding
 * them. So it says plainly what is kept — a voiceprint, not the recordings —
 * because that is the sentence they need in order to agree to it.
 */

// Different sentences per take, on purpose: reading the same words three times
// characterises the words as much as the voice.
const LINES = [
  'My name is, and I collect field data for this project.',
  'The wheat plot was sown in the second week of November.',
  'Please record the plot number before leaving the field.',
]

export default function VoiceEnrolment({ person, onClose, onDone }) {
  const [setup, setSetup] = useState(null)
  const [clips, setClips] = useState([])
  const [consent, setConsent] = useState(false)
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const stopper = useRef(null)

  useEffect(() => {
    api.voiceEnrolment().then(setSetup).catch((e) => setError(e.message))
    // Abandoning the sheet mid-recording must still release the microphone.
    return () => { if (stopper.current) stopper.current() }
  }, [])

  const needed = setup?.recordings_needed ?? LINES.length
  const minSeconds = setup?.min_seconds ?? 1.2

  const begin = async () => {
    setError('')
    try {
      stopper.current = await startRecording()
      setRecording(true)
    } catch {
      // Overwhelmingly a refused permission prompt, and the browser does not
      // say which — so name the likely cause rather than repeating its message.
      setError('The microphone is not available. Allow microphone access for '
               + 'this site and try again.')
    }
  }

  const finish = async () => {
    const stop = stopper.current
    stopper.current = null
    setRecording(false)
    try {
      const encoded = await toPcm16(await stop(), setup?.sample_rate)
      const length = seconds(encoded.length, setup?.sample_rate)
      if (length < minSeconds) {
        setError(`That take was ${length.toFixed(1)} seconds. Speak for at `
                 + `least ${minSeconds} seconds.`)
        return
      }
      setClips((held) => [...held, { encoded, length }])
      setError('')
    } catch {
      setError('That recording could not be read. Try again.')
    }
  }

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      onDone(await api.enrolVoice(person.user_id, clips.map((c) => c.encoded), consent))
    } catch (e) {
      // The server's words: they say what to do differently — somewhere
      // quieter, the same person each time, speak for longer.
      setError(e.message)
      setBusy(false)
      setClips([])
    }
  }

  const remove = async () => {
    setBusy(true)
    setError('')
    try {
      onDone(await api.forgetVoice(person.user_id))
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  return (
    <div className="sheet" onMouseDown={onClose}>
      <div className="sheet__panel" role="dialog" aria-modal="true"
           onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet__head">
          <div>
            <h2>Voice sign-in</h2>
            <p className="lede tiny">
              For {person.full_name || person.email || person.username || person.phone}
            </p>
          </div>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="sheet__body">
          {error && <div className="note note--bad" style={{ marginBottom: 14 }}>{error}</div>}

          {!supported() && (
            <div className="note note--warn">
              This browser cannot record audio. Voice sign-in has to be set up
              from one that can.
            </div>
          )}

          {setup && !setup.available && (
            <div className="note note--warn">
              Voice sign-in is not set up on this server — the speaker model is
              missing. Nothing can be enrolled until it is installed.
            </div>
          )}

          {person.voice_enrolled ? (
            <>
              <div className="note note--good">
                <strong>A voice is enrolled for this account.</strong>
                <span className="tiny">
                  Set up {new Date(person.voice_enrolled_on).toLocaleString()}.
                </span>
              </div>
              <p className="tiny muted" style={{ marginTop: 12 }}>
                Recording again replaces it. Removing it leaves the account
                signing in by password, which it can do either way.
              </p>
            </>
          ) : (
            <p className="tiny muted">
              {needed} short recordings of them speaking. What is kept is a
              voiceprint — {needed === 1 ? 'a list' : 'a list'} of numbers
              describing the voice, about a kilobyte. <b>The recordings
              themselves are not stored</b>: they are used to work out the
              voiceprint and then discarded.
            </p>
          )}

          {setup?.available && supported() && (
            <>
              <ol className="stack-list" style={{ marginTop: 14, paddingLeft: 0 }}>
                {LINES.slice(0, needed).map((line, i) => {
                  const done = clips[i]
                  const current = clips.length === i
                  return (
                    <li className="item" key={i} style={{ listStyle: 'none' }}>
                      <div className="item__body">
                        <div className="item__title">
                          {done ? '✓ ' : `${i + 1}. `}
                          <span style={{ fontWeight: done ? 400 : 600 }}>“{line}”</span>
                        </div>
                        <div className="item__meta">
                          {done
                            ? <span>recorded, {done.length.toFixed(1)} seconds</span>
                            : <span>not recorded yet</span>}
                        </div>
                      </div>
                      <div className="item__acts">
                        {current && !recording && (
                          <button className="btn btn--sm btn--primary" onClick={begin}>
                            Record
                          </button>
                        )}
                        {current && recording && (
                          <button className="btn btn--sm btn--danger" onClick={finish}>
                            <span className="spin" /> Stop
                          </button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ol>

              {clips.length > 0 && !recording && (
                <button className="btn btn--sm btn--quiet" style={{ marginTop: 10 }}
                        onClick={() => { setClips([]); setError('') }}>
                  Start the recordings again
                </button>
              )}

              {/* Required, not a courtesy: a voice is biometric data about a
                  person, and the date they agreed is stored with it. */}
              <label className="row" style={{ marginTop: 16, gap: 10, alignItems: 'flex-start' }}>
                <input type="checkbox" checked={consent}
                       onChange={(e) => setConsent(e.target.checked)} />
                <span className="tiny">
                  They have been told their voice is being recorded to sign in
                  with, and agree to a voiceprint of it being kept. It can be
                  removed from this screen at any time.
                </span>
              </label>
            </>
          )}
        </div>

        <div className="sheet__foot">
          {person.voice_enrolled && (
            <button className="btn btn--quiet btn--danger" onClick={remove} disabled={busy}>
              Remove the voiceprint
            </button>
          )}
          <span className="spacer" />
          <button className="btn btn--quiet" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={save}
                  disabled={busy || recording || !consent || clips.length < needed}>
            {busy && <span className="spin" />}
            {person.voice_enrolled ? 'Replace the voiceprint' : 'Set up voice sign-in'}
          </button>
        </div>
      </div>
    </div>
  )
}
