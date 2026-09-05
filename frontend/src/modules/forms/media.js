import { api } from './api.js'

/**
 * Upload the files chosen on a form, once the survey has an id.
 *
 *     ask the backend where to put it   → a presigned PUT, good for minutes
 *     PUT the bytes straight to S3
 *     tell the backend it landed        → the answer becomes the media id
 *
 * The browser never holds a credential for any of it. Returns the media id for
 * each field, to be put in the payload in place of the filename.
 *
 * `done` is what has already been uploaded, so a submission that failed
 * validation and is being retried does not send the same photo twice.
 */
export async function uploadAll(formId, surveyId, files, done = {}) {
  const ids = { ...done }

  for (const [fieldName, file] of Object.entries(files)) {
    if (ids[fieldName]) continue

    const asked = await api.mediaUploadUrl(formId, surveyId, {
      field_name: fieldName,
      filename: file.name,
      content_type: file.type || 'application/octet-stream',
      file_size: file.size,
    })

    const sent = await fetch(asked.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    })
    if (!sent.ok) throw new Error(`The upload of ${file.name} was refused (${sent.status}).`)

    await api.mediaComplete(formId, surveyId, asked.media_id, file.size)
    ids[fieldName] = asked.media_id
  }

  return ids
}
