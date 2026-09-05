import React, { useRef, useState } from 'react'

/**
 * A photo, a recording or a document.
 *
 * Choosing one does not upload it. The file is held here and reported to the
 * page, which uploads everything at once when Submit is pressed — that is when
 * the survey gets its id, and an upload has to be filed under one. Somebody who
 * opens a form, picks a photo and walks away leaves nothing behind: no id, no
 * row, no object in the bucket.
 *
 * The answer on the form is the filename until the upload happens, and the
 * media id afterwards. Neither is ever the file itself; `form_data` never holds
 * a byte of it.
 *
 * `capture` on an image input is what opens a phone's camera instead of its
 * file browser. It is ignored on a desktop, which is the right behaviour there.
 */
const ACCEPT = {
  image: 'image/jpeg,image/png,image/webp,image/heic',
  audio: 'audio/mpeg,audio/wav,audio/ogg,audio/webm,audio/mp4',
  file: '.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt',
}

const WORDING = {
  image: 'Choose a photo',
  audio: 'Choose a recording',
  file: 'Choose a file',
}

export default function MediaField({ field, value, onChange, error, onPick, uploading }) {
  const kind = field.type
  const [chosen, setChosen] = useState(null)   // { name, preview }
  const input = useRef(null)

  // Nowhere to report the file to — a preview, say — so there is nothing this
  // control can usefully do.
  const ready = Boolean(onPick)

  const pick = (file) => {
    if (!file) return
    setChosen({
      name: file.name,
      // Shown straight from the browser, so the picture appears without a round
      // trip to anywhere.
      preview: kind === 'image' ? URL.createObjectURL(file) : null,
    })
    onPick(field.name, file)
    // An answer, so a required question counts as answered. It becomes the
    // media id when the file is uploaded on submit.
    onChange(field.name, file.name)
  }

  return (
    <div className="media">
      <input
        ref={input}
        id={`f_${field.name}`}
        type="file"
        className="media__input"
        accept={ACCEPT[kind] || undefined}
        capture={kind === 'image' ? 'environment' : undefined}
        disabled={!ready || uploading}
        onChange={(e) => pick(e.target.files?.[0])}
      />

      <div className="row">
        <button
          type="button"
          className={`btn btn--sm${error ? ' btn--bad' : ''}`}
          disabled={!ready || uploading}
          onClick={() => input.current?.click()}
        >
          {uploading && <span className="spin" />}
          {chosen ? 'Replace' : WORDING[kind] || WORDING.file}
        </button>

        <span className="tiny muted grow ellipsis">
          {uploading && 'Uploading…'}
          {!uploading && (chosen?.name || (!ready && 'Available once the form is started.'))}
        </span>
      </div>

      {chosen?.preview && (
        <img className="media__preview" src={chosen.preview} alt={field.label} />
      )}
    </div>
  )
}
