/**
 * Uploads, and where a form was filled in — on the screens.
 *
 * What the browser is responsible for is asking once, reporting what it got,
 * and never holding a credential. What it is *not* responsible for is deciding
 * whether a position is acceptable: it says "this looks outside the area" as a
 * courtesy and the backend decides, from the same ring, on submission.
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const calls = []
const answers = {}

vi.mock('./api.js', () => ({
  api: {
    mediaUploadUrl: vi.fn(async (formId, surveyId, body) => {
      calls.push(['upload-url', formId, surveyId, body])
      if (answers.uploadFails) throw new Error(answers.uploadFails)
      return { media_id: 'MED1', s3_key: 'k', media_type: body.content_type.split('/')[0],
               upload_url: 'https://s3.test/PUT/k' }
    }),
    mediaComplete: vi.fn(async (...args) => { calls.push(['complete', ...args]); return {} }),
    clientCatalogOptions: vi.fn(async () => []),
    cropOntologyOptions: vi.fn(async () => []),
  },
}))

const RING = [[-99.20, 19.40], [-99.10, 19.40], [-99.10, 19.50], [-99.20, 19.50]]

const form = (extra = {}) => ({
  title: 'Farmer Registration', form_id: 'FRM1', sections: [], rules: [],
  fields: [
    { name: 'farmer_name', label: 'Farmer name', type: 'text', order: 1 },
    { name: 'farmer_photo', label: 'Farmer photo', type: 'image', order: 2 },
  ],
  ...extra,
})

/** A browser that answers the location question however a test wants. */
function geolocation(answer) {
  const getCurrentPosition = vi.fn((ok, fail) => {
    if (answer instanceof Error) return fail({ code: answer.message === 'denied' ? 1 : 2 })
    ok({ coords: answer, timestamp: 1767225600000 })
  })
  Object.defineProperty(window.navigator, 'geolocation', {
    value: { getCurrentPosition }, configurable: true, writable: true,
  })
  return getCurrentPosition
}

const MEXICO = { latitude: 19.4326, longitude: -99.1332, accuracy: 12.4 }
const DELHI = { latitude: 28.6139, longitude: 77.2090, accuracy: 8 }

beforeEach(() => {
  calls.length = 0
  vi.clearAllMocks()
  answers.uploadFails = null
  global.fetch = vi.fn(async () => ({ ok: true, status: 200 }))
  global.URL.createObjectURL = vi.fn(() => 'blob:preview')
})

async function draw(formJson, props = {}) {
  const { default: FormRenderer } = await import('./components/FormRenderer.jsx')
  const seen = []
  render(
    <FormRenderer
      formJson={formJson}
      values={{}}
      onChange={() => {}}
      onSubmit={() => {}}
      onLocation={(p) => seen.push(p)}
      {...props}
    />,
  )
  return seen
}


describe('where the form is being filled in', () => {
  test('a form that does not record a place asks for nothing', async () => {
    const asked = geolocation(MEXICO)
    await draw(form())

    expect(asked).not.toHaveBeenCalled()
    expect(screen.queryByText(/location/i)).toBeNull()
  })

  test('a form that does asks once, and reports what it got', async () => {
    const asked = geolocation(MEXICO)
    const seen = await draw(form({ location: { enabled: true } }))

    await waitFor(() => expect(seen.filter(Boolean).length).toBe(1))
    expect(asked).toHaveBeenCalledTimes(1)

    const position = seen.filter(Boolean)[0]
    expect(position).toMatchObject({
      latitude: 19.4326, longitude: -99.1332, accuracy: 12.4 })
    // The four things the backend stores, and a real timestamp.
    expect(Object.keys(position).sort()).toEqual(
      ['accuracy', 'captured_at', 'latitude', 'longitude'])
    expect(position.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test('it says so once it has one', async () => {
    geolocation(MEXICO)
    await draw(form({ location: { enabled: true } }))

    expect(await screen.findByText(/Location recorded/)).toBeTruthy()
    expect(screen.getByText(/accurate to about 12 m/)).toBeTruthy()
  })

  test('a refusal on an optional form is allowed to pass', async () => {
    geolocation(new Error('denied'))
    await draw(form({ location: { enabled: true } }))

    expect(await screen.findByText(/will not record where it was filled in/))
      .toBeTruthy()
    // Still sendable.
    expect(screen.getByRole('button', { name: /Submit/ })).toBeTruthy()
  })

  test('a refusal on a required form stops the form being sent', async () => {
    geolocation(new Error('denied'))
    await draw(form({ location: { enabled: true, required: true } }))

    expect(await screen.findByText(/location access was refused/i)).toBeTruthy()
    expect(screen.getByText(/cannot be sent until your location is available/))
      .toBeTruthy()
    expect(screen.queryByRole('button', { name: /Submit/ })).toBeNull()
  })

  test('a device that cannot fix a position says something different', async () => {
    geolocation(new Error('unavailable'))
    await draw(form({ location: { enabled: true, required: true } }))

    expect(await screen.findByText(/could not be found/)).toBeTruthy()
  })

  test('it warns when the position looks outside the form’s area', async () => {
    geolocation(DELHI)
    await draw(form({
      location: { enabled: true },
      geofence: { enabled: true, polygon: RING },
    }))

    expect(await screen.findByText(/outside the area this form covers/)).toBeTruthy()
  })

  test('and says nothing when it is inside', async () => {
    geolocation(MEXICO)
    await draw(form({
      location: { enabled: true },
      geofence: { enabled: true, polygon: RING },
    }))

    await screen.findByText(/Location recorded/)
    expect(screen.queryByText(/outside the area/)).toBeNull()
  })

  test('the warning is a courtesy — it does not stop the form', async () => {
    // The backend decides. A page that got this wrong, or lied, changes
    // nothing about what is accepted.
    geolocation(DELHI)
    await draw(form({
      location: { enabled: true, required: true },
      geofence: { enabled: true, polygon: RING },
    }))

    await screen.findByText(/outside the area/)
    expect(screen.getByRole('button', { name: /Submit/ })).toBeTruthy()
  })

  test('the point-in-polygon agrees with the backend’s', async () => {
    const { insideFence } = await import('./useLocation.js')
    const fenced = { geofence: { enabled: true, polygon: RING } }

    expect(insideFence(fenced, MEXICO)).toBe(true)
    expect(insideFence(fenced, DELHI)).toBe(false)
    // No fence, nothing to say.
    expect(insideFence(form(), MEXICO)).toBe(null)
  })
})


describe('choosing a photo', () => {
  // Choosing is not uploading. The file waits here until Submit, because the
  // survey it would be filed under does not exist until then.
  const picks = []
  const withMedia = { media: { onPick: (name, file) => picks.push([name, file]) } }

  beforeEach(() => { picks.length = 0 })

  test('the control is offered for a media field', async () => {
    geolocation(MEXICO)
    await draw(form(), withMedia)

    expect(screen.getByRole('button', { name: 'Choose a photo' })).toBeTruthy()
  })

  test('choosing one uploads nothing and asks for no survey id', async () => {
    const user = userEvent.setup()
    await draw(form(), withMedia)

    await user.upload(document.querySelector('.media__input'),
                      new File(['x'], 'photo.jpg', { type: 'image/jpeg' }))

    expect(picks.map(([name, f]) => [name, f.name]))
      .toEqual([['farmer_photo', 'photo.jpg']])
    // Nothing has left the browser.
    expect(calls).toEqual([])
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('the question counts as answered, and shows what was chosen', async () => {
    const user = userEvent.setup()
    const changes = []
    const { default: FormRenderer } = await import('./components/FormRenderer.jsx')
    render(
      <FormRenderer formJson={form()} values={{}} media={withMedia.media}
                    onChange={(name, value) => changes.push([name, value])} />,
    )

    await user.upload(document.querySelector('.media__input'),
                      new File(['x'], 'photo.jpg', { type: 'image/jpeg' }))

    expect(changes).toContainEqual(['farmer_photo', 'photo.jpg'])
    expect(await screen.findByText('photo.jpg')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Replace' })).toBeTruthy()
  })

  test('with nowhere to report it, it says so instead of failing', async () => {
    await draw(form())      // no media context — a preview, say

    expect(screen.getByText(/Available once the form is started/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Choose a photo' }).disabled).toBe(true)
  })
})


describe('uploading, once the survey has an id', () => {
  const file = (name = 'photo.jpg') => new File(['x'], name, { type: 'image/jpeg' })

  test('it asks the backend where to put it, then PUTs it there', async () => {
    const { uploadAll } = await import('./media.js')
    const ids = await uploadAll('FRM1', '000001', { farmer_photo: file() })

    expect(ids).toEqual({ farmer_photo: 'MED1' })

    const [, formId, surveyId, body] = calls.find(([k]) => k === 'upload-url')
    expect(formId).toBe('FRM1')
    expect(surveyId).toBe('000001')
    expect(body).toMatchObject({ field_name: 'farmer_photo', filename: 'photo.jpg',
                                 content_type: 'image/jpeg' })
    expect(calls.some(([k]) => k === 'complete')).toBe(true)

    // Straight to S3, with no credential anywhere near the browser.
    const [url, options] = global.fetch.mock.calls[0]
    expect(url).toBe('https://s3.test/PUT/k')
    expect(options.method).toBe('PUT')
    expect(JSON.stringify(options.headers)).not.toMatch(/aws|secret|key/i)
  })

  test('a refused upload stops the submission rather than being swallowed', async () => {
    const { uploadAll } = await import('./media.js')
    answers.uploadFails = 'That file is larger than 25 MB.'

    await expect(uploadAll('FRM1', '000001', { farmer_photo: file('huge.jpg') }))
      .rejects.toThrow(/larger than 25 MB/)
  })

  test('an S3 refusal is reported with its status', async () => {
    const { uploadAll } = await import('./media.js')
    global.fetch = vi.fn(async () => ({ ok: false, status: 403 }))

    await expect(uploadAll('FRM1', '000001', { farmer_photo: file() }))
      .rejects.toThrow(/refused \(403\)/)
  })

  test('a retry does not send the same photo twice', async () => {
    // The first attempt uploaded the photo and then failed validation. The
    // second reuses the survey id and what already landed.
    const { uploadAll } = await import('./media.js')
    const ids = await uploadAll('FRM1', '000001',
                                { farmer_photo: file() }, { farmer_photo: 'MED1' })

    expect(ids).toEqual({ farmer_photo: 'MED1' })
    expect(calls).toEqual([])
  })
})


describe('the form-level location settings', () => {
  const draw = async (formJson = {}) => {
    const { default: LocationSettings } = await import('./components/LocationSettings.jsx')
    const changes = []
    const Wrap = () => {
      const [f, setF] = React.useState(formJson)
      return <LocationSettings form={f} onChange={(c) => { changes.push(c); setF({ ...f, ...c }) }} />
    }
    render(<Wrap />)
    return changes
  }

  const pick = (label, answer) =>
    userEvent.selectOptions(screen.getByLabelText(label), answer)

  test('a form that records nothing offers only the first question', async () => {
    await draw()
    expect(screen.getByLabelText('Collect device location?').value).toBe('no')
    expect(screen.queryByLabelText('Require location?')).toBeNull()
    expect(screen.queryByLabelText('Enable geo-fencing?')).toBeNull()
  })

  test('turning collection on reveals the rest', async () => {
    const changes = await draw()
    await pick('Collect device location?', 'yes')

    expect(changes).toContainEqual({ location: { enabled: true, required: false } })
    expect(screen.getByLabelText('Require location?')).toBeTruthy()
    expect(screen.getByLabelText('Enable geo-fencing?')).toBeTruthy()
  })

  test('turning it off takes the fence with it', async () => {
    const changes = await draw({
      location: { enabled: true, required: true },
      geofence: { enabled: true, polygon: RING },
    })
    await pick('Collect device location?', 'no')

    expect(changes).toContainEqual({ location: null, geofence: null })
    expect(screen.queryByLabelText('Enable geo-fencing?')).toBeNull()
  })

  test('required is written into the definition', async () => {
    const changes = await draw({ location: { enabled: true, required: false } })
    await pick('Require location?', 'yes')

    expect(changes).toContainEqual({ location: { enabled: true, required: true } })
  })

  test('the boundary is edited as points, and says when it is too short', async () => {
    const user = userEvent.setup()
    const changes = await draw({ location: { enabled: true, required: false } })
    await pick('Enable geo-fencing?', 'yes')

    // Opened on enabling, and empty, which is not a boundary yet.
    expect(await screen.findByText(/needs at least three points/)).toBeTruthy()

    await user.type(screen.getByLabelText('Boundary points'),
                    '-99.20, 19.40\n-99.10, 19.40\n-99.10, 19.50')

    const last = changes[changes.length - 1]
    expect(last.geofence.polygon).toEqual(RING.slice(0, 3))
    expect(screen.queryByText(/needs at least three points/)).toBeNull()
    expect(screen.getByText(/3 points/)).toBeTruthy()
  })

  test('an existing boundary comes back to be edited', async () => {
    const user = userEvent.setup()
    await draw({ location: { enabled: true }, geofence: { enabled: true, polygon: RING } })

    expect(screen.getByText(/4 points/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Configure boundary' }))
    expect(screen.getByLabelText('Boundary points').value)
      .toBe('-99.2, 19.4\n-99.1, 19.4\n-99.1, 19.5\n-99.2, 19.5')
  })

  test('device location is a form setting, never a question', async () => {
    // The one thing this must not become: a row in the Questions list. A
    // "location" *field* is a different concept and is left alone.
    const { default: LocationSettings } = await import('./components/LocationSettings.jsx')
    const changes = []
    render(<LocationSettings form={form()} onChange={(c) => changes.push(c)} />)
    await pick('Collect device location?', 'yes')

    expect(changes.every((c) => !('fields' in c))).toBe(true)
  })
})
