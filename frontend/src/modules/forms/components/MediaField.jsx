import React, { useCallback, useRef, useState } from 'react'

const DEFAULT_ACCEPT = {
  image: 'image/jpeg,image/png,image/webp,image/heic',
  audio: 'audio/mpeg,audio/wav,audio/ogg,audio/webm,audio/mp4',
  file: '.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt',
  signature: 'image/jpeg,image/png,image/webp',
}

const WORDING = {
  image: 'Choose a photo',
  audio: 'Choose a recording',
  file: 'Choose a file',
  signature: 'Choose an image',
}

const MODES = {
  image: [['file', 'Select File'], ['camera', 'Take Photo']],
  audio: [['file', 'Select File'], ['record', 'Record']],
  signature: [['draw', 'Draw'], ['file', 'Select File']],
}

export default function MediaField({ field, value, onChange, error, onPick, uploading }) {
  const kind = field.type
  const modes = MODES[kind] || null
  const defaultMode = modes ? modes[0][0] : 'file'
  const [mode, setMode] = useState(defaultMode)
  const maxFiles = field.max_files || 1
  const multi = maxFiles > 1
  const maxSizeMB = field.max_file_size_mb || null
  const accept = field.accept || DEFAULT_ACCEPT[kind] || undefined
  const [files, setFiles] = useState([])
  const [sizeError, setSizeError] = useState(null)
  const input = useRef(null)

  const ready = Boolean(onPick)

  const pick = (fileList) => {
    if (!fileList || !fileList.length) return
    setSizeError(null)
    const incoming = Array.from(fileList)
    const room = maxFiles - files.length
    const batch = incoming.slice(0, Math.max(room, 0))
    if (incoming.length > room)
      setSizeError(`Only ${maxFiles} file${maxFiles === 1 ? '' : 's'} allowed.`)
    const accepted = []
    for (const file of batch) {
      if (maxSizeMB && file.size > maxSizeMB * 1024 * 1024) {
        setSizeError(`${file.name} exceeds ${maxSizeMB} MB limit.`)
        continue
      }
      accepted.push({
        name: file.name,
        preview: (kind === 'image' || kind === 'signature') ? URL.createObjectURL(file) : null,
      })
      onPick(field.name, file)
    }
    const next = multi ? [...files, ...accepted] : accepted
    setFiles(next)
    onChange(field.name, multi ? next.map((f) => f.name) : (next[0]?.name || null))
  }

  const remove = (i) => {
    const next = files.filter((_, j) => j !== i)
    setFiles(next)
    onChange(field.name, multi ? next.map((f) => f.name) : (next[0]?.name || null))
  }

  const atLimit = files.length >= maxFiles

  const handleCapture = (name, preview, file) => {
    if (onPick) onPick(field.name, file)
    const entry = { name, preview }
    const next = multi ? [...files, entry] : [entry]
    setFiles(next)
    onChange(field.name, multi ? next.map((f) => f.name) : name)
  }

  return (
    <div className="media">
      {modes && (
        <div className="media__tabs">
          {modes.map(([key, label]) => (
            <button key={key} type="button"
              className={`media__tab${mode === key ? ' media__tab--on' : ''}`}
              onClick={() => setMode(key)}>{label}</button>
          ))}
        </div>
      )}

      {(mode === 'file') && (
        <>
          <input ref={input} id={`f_${field.name}`} type="file" className="media__input"
            accept={accept}
            capture={kind === 'image' ? 'environment' : undefined}
            multiple={multi || undefined}
            disabled={!ready || uploading || atLimit}
            onChange={(e) => pick(e.target.files)} />
          <div className="row">
            <button type="button"
              className={`btn btn--sm${error ? ' btn--bad' : ''}`}
              disabled={!ready || uploading || atLimit}
              onClick={() => input.current?.click()}>
              {uploading && <span className="spin" />}
              {files.length ? (multi ? 'Add more' : 'Replace') : WORDING[kind] || WORDING.file}
            </button>
            <span className="tiny muted grow ellipsis">
              {uploading && 'Uploading…'}
              {!uploading && !files.length && !ready && 'Available once the form is started.'}
              {!uploading && !files.length && ready && multi && `Up to ${maxFiles} files`}
              {!uploading && files.length === 1 && !multi && files[0].name}
              {!uploading && files.length > 0 && multi && `${files.length} / ${maxFiles} files`}
            </span>
          </div>
        </>
      )}

      {mode === 'camera' && <CameraCapture onCapture={handleCapture} />}
      {mode === 'record' && <AudioRecorder onCapture={handleCapture} onPick={onPick} fieldName={field.name} />}
      {mode === 'draw' && <SignaturePad onCapture={handleCapture} />}

      {sizeError && <span className="field__bad">{sizeError}</span>}

      {files.length > 0 && (
        <div className="media__files">
          {files.map((f, i) => (
            <div key={i} className="media__file">
              {f.preview && <img className="media__thumb" src={f.preview} alt={f.name} />}
              <span className="tiny ellipsis grow">{f.name}</span>
              <button type="button" className="media__rm" title="Remove" onClick={() => remove(i)}>x</button>
            </div>
          ))}
        </div>
      )}

      {maxSizeMB && <span className="tiny muted">Max {maxSizeMB} MB per file</span>}

      <style>{MEDIA_STYLES}</style>
    </div>
  )
}


function CameraCapture({ onCapture }) {
  const videoRef = useRef(null)
  const [streaming, setStreaming] = useState(false)
  const [preview, setPreview] = useState(null)
  const streamRef = useRef(null)

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        videoRef.current.play()
      }
      setStreaming(true)
    } catch { /* ignore */ }
  }

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    setStreaming(false)
  }

  const snap = () => {
    const video = videoRef.current
    if (!video) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0)
    canvas.toBlob(blob => {
      if (!blob) return
      stopCamera()
      const url = URL.createObjectURL(blob)
      setPreview(url)
      const file = new File([blob], `photo_${Date.now()}.jpg`, { type: 'image/jpeg' })
      onCapture(file.name, url, file)
    }, 'image/jpeg', 0.85)
  }

  const retake = () => { setPreview(null); startCamera() }

  if (preview) {
    return (
      <div className="camera-wrap">
        <img src={preview} className="camera-preview" alt="Captured" />
        <button type="button" className="btn btn--sm" onClick={retake}>Retake</button>
      </div>
    )
  }

  return (
    <div className="camera-wrap">
      <video ref={videoRef} className="camera-video" playsInline muted
        style={{ display: streaming ? 'block' : 'none' }} />
      {!streaming && (
        <button type="button" className="btn btn--sm btn--primary" onClick={startCamera}>
          Open Camera
        </button>
      )}
      {streaming && (
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <button type="button" className="btn btn--sm btn--primary" onClick={snap}>Capture</button>
          <button type="button" className="btn btn--sm btn--quiet" onClick={stopCamera}>Cancel</button>
        </div>
      )}
    </div>
  )
}


function AudioRecorder({ onCapture, onPick, fieldName }) {
  const [recording, setRecording] = useState(false)
  const [duration, setDuration] = useState(0)
  const [preview, setPreview] = useState(null)
  const [err, setErr] = useState('')
  const mediaRef = useRef(null)
  const chunksRef = useRef([])
  const timerRef = useRef(null)

  const start = useCallback(async () => {
    setErr('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = getSupportedMime()
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {})
      mediaRef.current = { recorder, stream }
      chunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop())
        clearInterval(timerRef.current)
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType })
        const url = URL.createObjectURL(blob)
        setPreview(url)
        const ext = recorder.mimeType.includes('webm') ? 'webm' : recorder.mimeType.includes('ogg') ? 'ogg' : 'mp4'
        const file = new File([blob], `recording_${Date.now()}.${ext}`, { type: recorder.mimeType })
        onCapture(file.name, null, file)
      }
      recorder.start(250)
      setRecording(true)
      setDuration(0)
      timerRef.current = setInterval(() => setDuration(d => d + 1), 1000)
    } catch (e) {
      setErr(e.name === 'NotAllowedError'
        ? 'Microphone access denied.'
        : 'Mic error: ' + e.message)
    }
  }, [onCapture])

  const stop = useCallback(() => {
    if (mediaRef.current?.recorder?.state === 'recording')
      mediaRef.current.recorder.stop()
    setRecording(false)
  }, [])

  const clear = () => { setPreview(null); setDuration(0) }

  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  return (
    <div style={{ padding: '8px 0' }}>
      {err && <div className="note note--bad" style={{ marginBottom: 8, fontSize: '0.82rem' }}>{err}</div>}
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        {!recording && !preview && (
          <button type="button" className="btn btn--sm btn--primary" onClick={start}>
            <MicIcon /> Start Recording
          </button>
        )}
        {recording && (
          <>
            <span className="voice-pulse" />
            <span style={{ fontFamily: 'monospace', fontSize: '0.88rem' }}>{fmt(duration)}</span>
            <button type="button" className="btn btn--sm btn--danger" onClick={stop}>Stop</button>
          </>
        )}
        {preview && !recording && (
          <>
            <audio src={preview} controls style={{ height: 32, maxWidth: 220 }} />
            <button type="button" className="btn btn--sm btn--quiet" onClick={clear}>Re-record</button>
          </>
        )}
      </div>
    </div>
  )
}


function SignaturePad({ onCapture }) {
  const canvasRef = useRef(null)
  const [drawing, setDrawing] = useState(false)
  const [hasStrokes, setHasStrokes] = useState(false)
  const lastPos = useRef(null)

  const getPos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const touch = e.touches ? e.touches[0] : e
    return { x: touch.clientX - rect.left, y: touch.clientY - rect.top }
  }

  const down = (e) => {
    e.preventDefault()
    setDrawing(true)
    lastPos.current = getPos(e)
  }

  const move = (e) => {
    if (!drawing) return
    e.preventDefault()
    const ctx = canvasRef.current.getContext('2d')
    const pos = getPos(e)
    ctx.beginPath()
    ctx.moveTo(lastPos.current.x, lastPos.current.y)
    ctx.lineTo(pos.x, pos.y)
    ctx.strokeStyle = '#222'
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.stroke()
    lastPos.current = pos
    setHasStrokes(true)
  }

  const up = () => setDrawing(false)

  const clear = () => {
    const ctx = canvasRef.current.getContext('2d')
    ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
    setHasStrokes(false)
  }

  const save = () => {
    canvasRef.current.toBlob(blob => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const file = new File([blob], `signature_${Date.now()}.png`, { type: 'image/png' })
      onCapture(file.name, url, file)
    }, 'image/png')
  }

  return (
    <div className="sig-wrap">
      <canvas ref={canvasRef} width={320} height={120} className="sig-canvas"
        onMouseDown={down} onMouseMove={move} onMouseUp={up} onMouseLeave={up}
        onTouchStart={down} onTouchMove={move} onTouchEnd={up} />
      <div className="row" style={{ gap: 8, marginTop: 6 }}>
        <button type="button" className="btn btn--sm btn--primary" disabled={!hasStrokes} onClick={save}>
          Accept
        </button>
        <button type="button" className="btn btn--sm btn--quiet" onClick={clear}>Clear</button>
      </div>
    </div>
  )
}


function MicIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 2 }}>
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  )
}

function getSupportedMime() {
  for (const mime of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/mp4']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) return mime
  }
  return ''
}

const MEDIA_STYLES = `
.media__tabs {
  display: flex; gap: 0; margin-bottom: 8px; border-bottom: 2px solid var(--border, #e5e7eb);
}
.media__tab {
  padding: 5px 14px; font-size: 0.82rem; font-weight: 600; cursor: pointer;
  background: none; border: none; color: var(--muted, #6b7280);
  border-bottom: 2px solid transparent; margin-bottom: -2px; transition: all 0.15s;
}
.media__tab--on {
  color: var(--accent, #2563eb); border-bottom-color: var(--accent, #2563eb);
}
.media__tab:hover { color: var(--fg, #222); }
.camera-wrap { padding: 8px 0; }
.camera-video { width: 100%; max-width: 320px; border-radius: 8px; background: #000; }
.camera-preview { width: 100%; max-width: 320px; border-radius: 8px; }
.sig-wrap { padding: 8px 0; }
.sig-canvas {
  border: 1px solid var(--border, #ccc); border-radius: 6px; cursor: crosshair;
  touch-action: none; background: #fff; display: block; max-width: 100%;
}
.voice-pulse {
  width: 12px; height: 12px; border-radius: 50%; background: #dc2626;
  animation: vpulse 1s ease-in-out infinite;
}
@keyframes vpulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
`
