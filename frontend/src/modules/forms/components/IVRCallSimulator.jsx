import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api.js'

// Dual-tone multi-frequency (DTMF) oscillator for realistic telephone keypad sounds
function playDtmfBeep(key) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext
    if (!AudioCtx) return
    const ctx = new AudioCtx()
    const freqs = {
      '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
      '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
      '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
      '*': [941, 1209], '0': [941, 1336], '#': [941, 1477],
    }
    const pair = freqs[key] || [440, 440]
    const osc1 = ctx.createOscillator()
    const osc2 = ctx.createOscillator()
    const gain = ctx.createGain()
    gain.gain.value = 0.08
    osc1.frequency.value = pair[0]
    osc2.frequency.value = pair[1]
    osc1.connect(gain); osc2.connect(gain)
    gain.connect(ctx.destination)
    osc1.start(); osc2.start()
    setTimeout(() => {
      try { osc1.stop(); osc2.stop(); ctx.close() } catch (err) {}
    }, 160)
  } catch (e) {}
}

// Speaks prompt aloud using browser SpeechSynthesis
function speakPrompt(text) {
  try {
    if (!('speechSynthesis' in window) || !text) return
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    // Try to find a Hindi voice if prompt contains Hindi characters
    const isHindi = /[\u0900-\u097F]/.test(text)
    if (isHindi) {
      const voices = window.speechSynthesis.getVoices()
      const hiVoice = voices.find((v) => v.lang.startsWith('hi'))
      if (hiVoice) utterance.voice = hiVoice
      utterance.lang = 'hi-IN'
    } else {
      utterance.lang = 'en-IN'
    }
    utterance.rate = 0.95
    window.speechSynthesis.speak(utterance)
  } catch (e) {}
}

export default function IVRCallSimulator({ form, did, onClose }) {
  const navigate = useNavigate()
  const formId = form.form_id
  const formTitle = form.form_title || formId

  const [callerNumber, setCallerNumber] = useState('919876543210')
  const [callState, setCallState] = useState('ready') // ready, in_call, ended, submitting, completed
  const [callDuration, setCallDuration] = useState(0)
  const [stepIndex, setStepIndex] = useState(0)
  const [answers, setAnswers] = useState({})
  const [voiceInput, setVoiceInput] = useState('')
  const [submissionResult, setSubmissionResult] = useState(null)
  const [error, setError] = useState('')

  // Build sequential questions from form fields & channel_config
  const ivrConfig = form.form_json?.channel_config?.ivr || {}
  const fields = form.form_json?.fields || form.fields || []

  const welcomeText = ivrConfig.welcome_message || `नमस्ते, ${formTitle} में आपका स्वागत है।`
  const completionText = ivrConfig.completion_message || 'आपके उत्तर दर्ज कर लिए गए हैं। धन्यवाद।'

  const steps = [
    { type: 'info', text: welcomeText, seq: 1 },
    ...fields.map((f, idx) => {
      const fieldType = (f.type || 'text').toLowerCase()
      const isDtmf = ['rating', 'scale', 'nps', 'integer', 'number', 'boolean', 'select_one', 'radio', 'choice'].includes(fieldType)
      return {
        type: isDtmf ? 'dtmf' : 'voice',
        name: f.name,
        label: f.label || f.name,
        prompt: ivrConfig.fields?.[f.name]?.prompt || f.label || f.name,
        options: f.options || (fieldType === 'boolean' ? ['Yes', 'No'] : []),
        fieldType,
        seq: idx + 2,
      }
    }),
    { type: 'info', text: completionText, seq: fields.length + 2, isFinal: true },
  ]

  // Call timer
  useEffect(() => {
    let timer = null
    if (callState === 'in_call') {
      timer = setInterval(() => setCallDuration((d) => d + 1), 1000)
    }
    return () => clearInterval(timer)
  }, [callState])

  // Speak prompt when step changes
  useEffect(() => {
    if (callState === 'in_call' && steps[stepIndex]) {
      const current = steps[stepIndex]
      speakPrompt(current.prompt || current.text)
      setVoiceInput('')

      // If it's the welcome or final step, auto-advance after 3 seconds
      if (current.type === 'info') {
        const timeout = setTimeout(() => {
          if (current.isFinal) {
            handleHangUp()
          } else {
            setStepIndex((idx) => idx + 1)
          }
        }, 3200)
        return () => clearTimeout(timeout)
      }
    }
  }, [callState, stepIndex])

  const startCall = () => {
    setError('')
    setCallDuration(0)
    setAnswers({})
    setStepIndex(0)
    setCallState('in_call')
  }

  const handleDtmfInput = (digit) => {
    playDtmfBeep(digit)
    const current = steps[stepIndex]
    if (!current || current.type !== 'dtmf') return

    setAnswers((prev) => ({
      ...prev,
      [current.seq]: {
        seq: current.seq,
        question: current.label || current.prompt,
        type: 'dtmf',
        answer_text: String(digit),
        audio_url: null,
      },
    }))

    // Move to next step
    setTimeout(() => setStepIndex((idx) => idx + 1), 400)
  }

  const handleVoiceSubmit = () => {
    if (!voiceInput.trim()) return
    const current = steps[stepIndex]
    if (!current) return

    setAnswers((prev) => ({
      ...prev,
      [current.seq]: {
        seq: current.seq,
        question: current.label || current.prompt,
        type: 'voice',
        answer_text: voiceInput.trim(),
        audio_url: 'https://raw.githubusercontent.com/mdn/webaudio-examples/master/audio-analyser/viper.mp3',
      },
    }))

    setStepIndex((idx) => idx + 1)
  }

  const handleHangUp = async () => {
    try { window.speechSynthesis?.cancel() } catch (e) {}
    setCallState('submitting')
    setError('')

    const answersList = Object.values(answers)
    const payload = {
      event: 'survey_completed',
      call_id: `CALL_SIM_${Date.now()}`,
      caller: callerNumber.replace(/\D/g, '') || '919876543210',
      did: did || '1205236308',
      duration_seconds: callDuration || 45,
      completed_at: new Date().toISOString(),
      recording_url: 'https://raw.githubusercontent.com/mdn/webaudio-examples/master/audio-analyser/viper.mp3',
      answers: answersList,
    }

    try {
      const res = await fetch('/api/integrations/ivr/indev', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Webhook submission failed')

      setSubmissionResult(data)
      setCallState('completed')
    } catch (e) {
      setError(e.message)
      setCallState('ended')
    }
  }

  const formatTime = (secs) => {
    const m = Math.floor(secs / 60).toString().padStart(2, '0')
    const s = (secs % 60).toString().padStart(2, '0')
    return `${m}:${s}`
  }

  const currentStep = steps[stepIndex]

  return (
    <div className="modal-backdrop" style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 9999, backdropFilter: 'blur(3px)',
    }}>
      <div className="card" style={{
        width: 380, borderRadius: 24, boxShadow: '0 20px 40px rgba(0,0,0,0.4)',
        background: '#181b1f', border: '1px solid #333', color: '#fff', overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Phone Header */}
        <div style={{
          padding: '16px 20px', background: '#121417', borderBottom: '1px solid #282c34',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#4ade80' }}>
              ● IVR TELEPHONY SIMULATOR
            </div>
            <div style={{ fontSize: 11, color: '#888' }}>
              Line DID: {did || '1205236308'}
            </div>
          </div>
          <button className="btn btn--quiet btn--xs" onClick={() => {
            try { window.speechSynthesis?.cancel() } catch (e) {}
            onClose()
          }}>
            ✕
          </button>
        </div>

        {/* Phone Screen */}
        <div style={{ padding: 24, flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
          {callState === 'ready' && (
            <div style={{ width: '100%' }}>
              <div style={{ fontSize: 48, margin: '16px 0 8px' }}>📞</div>
              <h3 style={{ margin: '0 0 8px', color: '#fff' }}>Call DID {did || '1205236308'}</h3>
              <p style={{ fontSize: 12, color: '#aaa', margin: '0 0 20px' }}>
                Simulate a real respondent call to <strong>{formTitle}</strong>.
                Questions will be read aloud through your speakers in Hindi/English.
              </p>

              <label style={{ display: 'block', textAlign: 'left', marginBottom: 16 }}>
                <span style={{ fontSize: 11, color: '#888' }}>Caller Phone Number:</span>
                <input
                  type="text"
                  className="control control--sm"
                  style={{ width: '100%', marginTop: 4, background: '#222', color: '#fff', border: '1px solid #444' }}
                  value={callerNumber}
                  onChange={(e) => setCallerNumber(e.target.value)}
                  placeholder="e.g. 919876543210"
                />
              </label>

              <button
                className="btn btn--primary"
                style={{ width: '100%', padding: '10px 0', fontSize: 14, fontWeight: 600, background: '#10b981', borderColor: '#10b981' }}
                onClick={startCall}
              >
                📞 Dial 01205236308 Now
              </button>
            </div>
          )}

          {callState === 'in_call' && (
            <div style={{ width: '100%' }}>
              {/* Active Call Status */}
              <div style={{ fontSize: 12, color: '#10b981', fontWeight: 600, marginBottom: 4 }}>
                ● CONNECTED
              </div>
              <div style={{ fontSize: 24, fontWeight: 700, fontFamily: 'monospace', marginBottom: 12 }}>
                {formatTime(callDuration)}
              </div>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 16 }}>
                Caller: +{callerNumber} ➔ DID {did}
              </div>

              {/* Current Question Bubble */}
              <div style={{
                background: '#23272e', padding: '14px 16px', borderRadius: 12, marginBottom: 16,
                border: '1px solid #3a3f4b', textAlign: 'left',
              }}>
                <div style={{ fontSize: 11, color: '#60a5fa', fontWeight: 600, marginBottom: 4 }}>
                  [TTS VOICE PLAYING]
                </div>
                <div style={{ fontSize: 14, color: '#eee', lineHeight: 1.4 }}>
                  {currentStep.prompt || currentStep.text}
                </div>
                {currentStep.options?.length > 0 && (
                  <div style={{ marginTop: 8, fontSize: 11, color: '#bbb' }}>
                    {currentStep.options.map((opt, i) => (
                      <div key={i}>Press <strong>{i + 1}</strong> for {typeof opt === 'object' ? opt.label : opt}</div>
                    ))}
                  </div>
                )}
              </div>

              {/* Interaction Controls */}
              {currentStep.type === 'dtmf' && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>
                    Press digits on the keypad:
                  </div>
                  <div style={{
                    display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8,
                    maxWidth: 220, margin: '0 auto',
                  }}>
                    {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((d) => (
                      <button
                        key={d}
                        type="button"
                        style={{
                          height: 44, borderRadius: 22, background: '#2c313a', color: '#fff',
                          fontSize: 18, fontWeight: 600, border: '1px solid #444', cursor: 'pointer',
                        }}
                        onClick={() => handleDtmfInput(d)}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {currentStep.type === 'voice' && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>
                    Speak answer (simulated speech-to-text):
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="text"
                      className="control control--sm"
                      placeholder="Type your spoken answer..."
                      style={{ flex: 1, background: '#222', color: '#fff', border: '1px solid #444' }}
                      value={voiceInput}
                      autoFocus
                      onChange={(e) => setVoiceInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleVoiceSubmit()}
                    />
                    <button className="btn btn--primary btn--sm" onClick={handleVoiceSubmit}>
                      Send
                    </button>
                  </div>
                </div>
              )}

              {/* Hangup button */}
              <div style={{ marginTop: 24 }}>
                <button
                  className="btn btn--danger"
                  style={{ borderRadius: 24, padding: '8px 24px', fontSize: 13 }}
                  onClick={handleHangUp}
                >
                  End Call (Hang Up)
                </button>
              </div>
            </div>
          )}

          {callState === 'submitting' && (
            <div style={{ padding: '30px 0' }}>
              <div className="spin" style={{ width: 36, height: 36, margin: '0 auto 16px' }} />
              <h4>Posting Call Result to Webhook...</h4>
              <p style={{ fontSize: 12, color: '#888' }}>
                Executing MCDC PostgreSQL ingestion & archiving audio to AWS S3.
              </p>
            </div>
          )}

          {callState === 'completed' && (
            <div style={{ width: '100%', padding: '10px 0' }}>
              <div style={{ fontSize: 48, color: '#10b981', marginBottom: 12 }}>✓</div>
              <h3 style={{ margin: '0 0 6px', color: '#fff' }}>Call Completed!</h3>
              <p style={{ fontSize: 13, color: '#aaa', margin: '0 0 16px' }}>
                Survey responses submitted via MCDC and audio archived in AWS S3.
              </p>

              <div style={{
                background: '#1c2128', padding: 12, borderRadius: 8, fontSize: 12,
                textAlign: 'left', marginBottom: 20, border: '1px solid #333',
              }}>
                <div><strong>Survey ID:</strong> {submissionResult?.survey_id || '000001'}</div>
                <div><strong>Caller:</strong> +{callerNumber}</div>
                <div><strong>DID Line:</strong> {did}</div>
                <div><strong>Call Audio:</strong> Archived to S3</div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <button
                  className="btn btn--primary"
                  onClick={() => {
                    onClose()
                    navigate(`/forms/${formId}/records`)
                  }}
                >
                  View Submission & Audio Playback
                </button>
                <button className="btn btn--quiet btn--sm" onClick={startCall}>
                  Make Another Call
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="note note--bad" style={{ marginTop: 12, width: '100%', fontSize: 12 }}>
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
