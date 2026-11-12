import React, { useCallback, useRef, useState } from 'react'

/**
 * Browser mic recorder that captures audio and outputs base64-encoded
 * PCM16 at 16kHz mono — the format the backend voiceprint pipeline expects.
 *
 * Uses MediaRecorder → AudioContext for resampling. Falls back gracefully
 * when mic access is denied.
 */
export default function VoiceRecorder({ value, onChange, field }) {
  const [recording, setRecording] = useState(false)
  const [duration, setDuration] = useState(0)
  const [err, setErr] = useState('')
  const [preview, setPreview] = useState(null)
  const mediaRef = useRef(null)
  const chunksRef = useRef([])
  const timerRef = useRef(null)

  const start = useCallback(async () => {
    setErr('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream, { mimeType: getSupportedMime() })
      mediaRef.current = { recorder, stream }
      chunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        clearInterval(timerRef.current)
        try {
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType })
          setPreview(URL.createObjectURL(blob))
          const pcm16b64 = await blobToPcm16Base64(blob)
          onChange(pcm16b64)
        } catch (e) {
          setErr('Could not process recording: ' + e.message)
        }
      }

      recorder.start(250)
      setRecording(true)
      setDuration(0)
      timerRef.current = setInterval(() => setDuration(d => d + 1), 1000)
    } catch (e) {
      setErr(e.name === 'NotAllowedError'
        ? 'Microphone access denied. Please allow mic access and try again.'
        : 'Could not access microphone: ' + e.message)
    }
  }, [onChange])

  const stop = useCallback(() => {
    if (mediaRef.current?.recorder?.state === 'recording') {
      mediaRef.current.recorder.stop()
    }
    setRecording(false)
  }, [])

  const clear = () => {
    onChange(null)
    setPreview(null)
    setDuration(0)
  }

  const hasValue = !!value

  return (
    <div className="voice-recorder">
      {err && <div className="note note--bad" style={{ marginBottom: 8, fontSize: '0.82rem' }}>{err}</div>}

      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        {!recording && !hasValue && (
          <button type="button" className="btn btn--primary voice-btn" onClick={start}>
            <MicIcon /> Record voice
          </button>
        )}
        {recording && (
          <>
            <span className="voice-pulse" />
            <span className="mono" style={{ fontSize: '0.88rem' }}>{formatTime(duration)}</span>
            <button type="button" className="btn btn--danger btn--sm" onClick={stop}>Stop</button>
          </>
        )}
        {hasValue && !recording && (
          <>
            <span style={{ color: 'var(--good, #16a34a)', fontWeight: 600, fontSize: '0.88rem' }}>
              Voice recorded
            </span>
            {preview && <audio src={preview} controls style={{ height: 32, maxWidth: 200 }} />}
            <button type="button" className="btn btn--sm btn--quiet" onClick={clear}>Re-record</button>
          </>
        )}
      </div>

      <style>{`
        .voice-recorder { padding: 8px 0; }
        .voice-btn { display: inline-flex; align-items: center; gap: 6px; }
        .voice-pulse {
          width: 12px; height: 12px; border-radius: 50%; background: #dc2626;
          animation: vpulse 1s ease-in-out infinite;
        }
        @keyframes vpulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
        .mono { font-family: monospace; }
      `}</style>
    </div>
  )
}

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  )
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function getSupportedMime() {
  for (const mime of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(mime)) return mime
  }
  return ''
}

async function blobToPcm16Base64(blob) {
  const arrayBuffer = await blob.arrayBuffer()
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 })
  const decoded = await audioCtx.decodeAudioData(arrayBuffer)
  const mono = decoded.getChannelData(0)
  // Convert float32 [-1,1] to int16
  const pcm16 = new Int16Array(mono.length)
  for (let i = 0; i < mono.length; i++) {
    const s = Math.max(-1, Math.min(1, mono[i]))
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
  }
  const bytes = new Uint8Array(pcm16.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  audioCtx.close()
  return btoa(binary)
}
