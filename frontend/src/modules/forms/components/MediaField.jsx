import React, { useRef, useState } from 'react'

const DEFAULT_ACCEPT = {
  image: 'image/jpeg,image/png,image/webp,image/heic',
  audio: 'audio/mpeg,audio/wav,audio/ogg,audio/webm,audio/mp4',
  file: '.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt',
}

const WORDING = {
  image: 'Choose a photo',
  audio: 'Choose a recording',
  file: 'Choose a file',
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function MediaField({ field, value, onChange, error, onPick, uploading }) {
  const kind = field.type
  const maxFiles = field.max_files || 1
  const multi = maxFiles > 1
  const maxSizeMB = field.max_file_size_mb || null
  const accept = field.accept || DEFAULT_ACCEPT[kind] || undefined
  const [files, setFiles] = useState([])    // [{ name, preview, error? }]
  const [sizeError, setSizeError] = useState(null)
  const input = useRef(null)

  const ready = Boolean(onPick)

  const pick = (fileList) => {
    if (!fileList || !fileList.length) return
    setSizeError(null)

    const incoming = Array.from(fileList)
    const room = maxFiles - files.length
    const batch = incoming.slice(0, Math.max(room, 0))

    if (incoming.length > room) {
      setSizeError(`Only ${maxFiles} file${maxFiles === 1 ? '' : 's'} allowed. ${incoming.length - room} skipped.`)
    }

    const accepted = []
    for (const file of batch) {
      if (maxSizeMB && file.size > maxSizeMB * 1024 * 1024) {
        setSizeError(`${file.name} exceeds ${maxSizeMB} MB limit.`)
        continue
      }
      accepted.push({
        name: file.name,
        preview: kind === 'image' ? URL.createObjectURL(file) : null,
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

  return (
    <div className="media">
      <input
        ref={input}
        id={`f_${field.name}`}
        type="file"
        className="media__input"
        accept={accept}
        capture={kind === 'image' ? 'environment' : undefined}
        multiple={multi || undefined}
        disabled={!ready || uploading || atLimit}
        onChange={(e) => pick(e.target.files)}
      />

      <div className="row">
        <button
          type="button"
          className={`btn btn--sm${error ? ' btn--bad' : ''}`}
          disabled={!ready || uploading || atLimit}
          onClick={() => input.current?.click()}
        >
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

      {sizeError && <span className="field__bad">{sizeError}</span>}

      {files.length > 0 && (
        <div className="media__files">
          {files.map((f, i) => (
            <div key={i} className="media__file">
              {f.preview && <img className="media__thumb" src={f.preview} alt={f.name} />}
              <span className="tiny ellipsis grow">{f.name}</span>
              <button type="button" className="media__rm" title="Remove" onClick={() => remove(i)}>×</button>
            </div>
          ))}
        </div>
      )}

      {maxSizeMB && <span className="tiny muted">Max {maxSizeMB} MB per file</span>}
    </div>
  )
}
