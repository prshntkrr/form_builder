/**
 * What an answer looks like in the records table when it is not a word.
 *
 * The rule under test throughout: what a cell renders is decided by the
 * *question's type*, taken from the form definition — never by the shape of the
 * value. "MED..." is a media id when the question asks for a photo and an
 * ordinary answer when it does not.
 *
 * And the second rule: no URL is built here. Every file is reached through the
 * backend's media endpoint, which authorizes the request and signs a
 * short-lived link; nothing in this page knows a bucket, a key or a credential.
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const asked = []
const answers = { fails: false, empty: false }

vi.mock('./api.js', () => ({
  api: {
    mediaUrl: vi.fn(async (formId, surveyId, mediaId) => {
      asked.push([formId, surveyId, mediaId])
      if (answers.fails) throw new Error('No such upload.')
      if (answers.empty) return { content_type: 'image/jpeg' }
      // The shape the backend actually answers with.
      return { url: `https://s3.test/GET/${mediaId}?X-Amz-Signature=abc`,
               content_type: 'image/jpeg', original_filename: 'farmer.jpg' }
    }),
  },
}))

const IMAGE = { media_id: 'MED1', field_name: 'farmer_image', media_type: 'image',
                filename: 'farmer.jpg', content_type: 'image/jpeg', size: 1234 }
const DOC = { media_id: 'MED2', field_name: 'supporting_document', media_type: 'file',
              filename: 'Project_Role_Form_Access_Hierarchy.xlsx',
              content_type: 'application/vnd.ms-excel', size: 9876 }
const CLIP = { media_id: 'MED3', field_name: 'interview', media_type: 'audio',
               filename: 'interview.mp3', content_type: 'audio/mpeg', size: 5555 }

const PLACE = { latitude: 27.499293, longitude: 77.656361,
                accuracy: 12.4, captured_at: '2026-09-04T12:30:00Z' }

async function draw(props) {
  const { default: RecordCell, forgetMediaLinks } = await import(
    './components/RecordCell.jsx')
  forgetMediaLinks()
  return render(<RecordCell formId="FRM1" surveyId="000001" {...props} />)
}

beforeEach(() => {
  asked.length = 0
  answers.fails = false
  answers.empty = false
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  // A real browser asked for `noopener` returns null — the handle is severed by
  // specification. Anything that opens a tab and then points it somewhere is
  // pointing at nothing, which is what a blank page is. The stub says null for
  // exactly that reason.
  window.open = vi.fn(() => null)
})

/** Where the one and only tab was pointed. */
const opened = () => {
  expect(window.open).toHaveBeenCalledTimes(1)
  const [url, target, features] = window.open.mock.calls[0]
  // Never opened empty and filled in afterwards.
  expect(url).toBeTruthy()
  expect(target).toBe('_blank')
  expect(features).toBe('noopener,noreferrer')
  return url
}


describe('a photo', () => {
  const props = { column: { name: 'farmer_image', type: 'image' },
                  value: 'MED1', media: [IMAGE] }

  test('is a "View Image" link, not a thumbnail', async () => {
    const { container } = await draw(props)

    expect(screen.getByRole('link', { name: 'View Image' })).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.queryByText('MED1')).toBeNull()
  })

  test('asks for nothing until it is clicked', async () => {
    const user = userEvent.setup()
    await draw(props)

    expect(asked).toEqual([])

    await user.click(screen.getByRole('link', { name: 'View Image' }))

    await waitFor(() => expect(asked).toEqual([['FRM1', '000001', 'MED1']]))
  })

  test('opens the backend’s signed link in a new tab', async () => {
    const user = userEvent.setup()
    await draw(props)
    await user.click(screen.getByRole('link', { name: 'View Image' }))

    await waitFor(() => expect(window.open).toHaveBeenCalled())
    const url = opened()
    expect(url).toContain('X-Amz-Signature=')
    // The tab is opened with the real link. A tab opened empty and pointed
    // somewhere afterwards is the blank page this replaced.
    expect(window.open).not.toHaveBeenCalledWith('', expect.anything(), expect.anything())
    // And the URL was never assembled here.
    expect(url).not.toMatch(/amazonaws\.com|s3_key|AKIA/)
  })

  test('nothing is opened until the link has been signed', async () => {
    const user = userEvent.setup()
    const order = []
    window.open = vi.fn(() => { order.push('open'); return null })
    await draw(props)

    await user.click(screen.getByRole('link', { name: 'View Image' }))
    await waitFor(() => expect(order).toContain('open'))

    // The request first, the tab second — the other way round is the blank page.
    expect(asked).toHaveLength(1)
    expect(order).toEqual(['open'])
    expect(window.open.mock.calls[0][0]).toContain('X-Amz-Signature=')
  })

  test('it says what it is doing, then goes back to what it was', async () => {
    const user = userEvent.setup()
    let release
    window.open = vi.fn(() => null)
    const { api } = await import('./api.js')
    api.mediaUrl.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ url: 'https://s3.test/GET/x?X-Amz-Signature=abc' }) }))
    await draw(props)

    await user.click(screen.getByRole('link', { name: 'View Image' }))
    expect(await screen.findByText('Opening…')).toBeTruthy()

    release()
    expect(await screen.findByText('View Image')).toBeTruthy()
  })

  test('clicking again while it is still opening opens one tab', async () => {
    const user = userEvent.setup()
    let release
    const { api } = await import('./api.js')
    api.mediaUrl.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ url: 'https://s3.test/GET/MED1?X-Amz-Signature=abc' })
    }))
    await draw(props)
    const link = screen.getByRole('link', { name: 'View Image' })

    // Impatient: clicked again, and again, while the first is in flight.
    await user.click(link)
    await user.click(link)
    await user.click(link)
    expect(window.open).not.toHaveBeenCalled()

    release()

    await waitFor(() => expect(window.open).toHaveBeenCalled())
    expect(window.open).toHaveBeenCalledTimes(1)
  })

  test('opening it twice signs it once', async () => {
    const user = userEvent.setup()
    await draw(props)
    const link = screen.getByRole('link', { name: 'View Image' })

    await user.click(link)
    await waitFor(() => expect(window.open).toHaveBeenCalledTimes(1))
    await user.click(link)
    await waitFor(() => expect(window.open).toHaveBeenCalledTimes(2))

    expect(asked).toEqual([['FRM1', '000001', 'MED1']])
  })

  test('a link the backend refuses says so, and opens no blank tab', async () => {
    const user = userEvent.setup()
    answers.fails = true
    await draw(props)

    await user.click(screen.getByRole('link', { name: 'View Image' }))

    expect(await screen.findByText('Unable to open media')).toBeTruthy()
    expect(window.open).not.toHaveBeenCalled()
  })

  test('an answer carrying no url opens no blank tab either', async () => {
    const user = userEvent.setup()
    answers.empty = true
    await draw(props)

    await user.click(screen.getByRole('link', { name: 'View Image' }))

    expect(await screen.findByText('Unable to open media')).toBeTruthy()
    expect(window.open).not.toHaveBeenCalled()
  })

  test('a failure is not remembered — the next click asks again', async () => {
    const user = userEvent.setup()
    answers.fails = true
    await draw(props)
    await user.click(screen.getByRole('link', { name: 'View Image' }))
    await screen.findByText('Unable to open media')

    // Whatever was wrong is fixed; the link works without reloading the page.
    answers.fails = false
    const { default: RecordCell } = await import('./components/RecordCell.jsx')
    render(<RecordCell formId="FRM1" surveyId="000001" {...props} />)
    await user.click(screen.getByRole('link', { name: 'View Image' }))

    await waitFor(() => expect(window.open).toHaveBeenCalled())
    expect(opened()).toContain('X-Amz-Signature=')
    expect(asked).toHaveLength(2)
  })

  test('several photos are several links', async () => {
    const second = { ...IMAGE, media_id: 'MED9', filename: 'field.jpg' }
    await draw({ column: { name: 'farmer_images', type: 'image' },
                 value: ['MED1', 'MED9'], media: [IMAGE, second] })

    expect(screen.getAllByRole('link', { name: 'View Image' })).toHaveLength(2)
    // Not the array, printed.
    expect(screen.queryByText(/MED1, ?MED9/)).toBeNull()
  })
})


describe('a document', () => {
  const props = { column: { name: 'supporting_document', type: 'file' },
                  value: 'MED2', media: [DOC] }

  test('is its own filename, as a link', async () => {
    await draw(props)

    expect(screen.getByRole('link',
      { name: 'Project_Role_Form_Access_Hierarchy.xlsx' })).toBeTruthy()
    expect(screen.queryByText('MED2')).toBeNull()
    // No buttons: one link is the whole control.
    expect(screen.queryByRole('button')).toBeNull()
  })

  test('clicking the filename opens the backend’s link', async () => {
    const user = userEvent.setup()
    await draw(props)

    await user.click(screen.getByRole('link',
      { name: 'Project_Role_Form_Access_Hierarchy.xlsx' }))

    await waitFor(() => expect(asked).toEqual([['FRM1', '000001', 'MED2']]))
    await waitFor(() => expect(window.open).toHaveBeenCalled())
    expect(opened()).toContain('X-Amz-Signature=')
  })

  test('a document with no filename still has a link', async () => {
    await draw({ ...props, media: [{ ...DOC, filename: '' }] })

    expect(screen.getByRole('link', { name: 'View Document' })).toBeTruthy()
  })
})


describe('a recording', () => {
  test('is a link, not a player', async () => {
    const user = userEvent.setup()
    const { container } = await draw({ column: { name: 'interview', type: 'audio' },
                                       value: 'MED3', media: [CLIP] })

    expect(container.querySelector('audio')).toBeNull()
    await user.click(screen.getByRole('link', { name: 'interview.mp3' }))

    await waitFor(() => expect(asked).toEqual([['FRM1', '000001', 'MED3']]))
    await waitFor(() => expect(window.open).toHaveBeenCalled())
    expect(opened()).toContain('X-Amz-Signature=')
  })

  test('a recording with no filename says what it is', async () => {
    await draw({ column: { name: 'interview', type: 'audio' },
                 value: 'MED3', media: [{ ...CLIP, filename: '' }] })

    expect(screen.getByRole('link', { name: 'View Audio' })).toBeTruthy()
  })
})


describe('a place', () => {
  const props = { column: { name: 'farm_location', type: 'location' }, value: PLACE }

  test('is the coordinates and a map link', async () => {
    await draw(props)

    expect(screen.getByText('27.499293, 77.656361')).toBeTruthy()
    const link = screen.getByRole('link', { name: 'View on Map' })
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('href')).toContain('mlat=27.499293')
    expect(link.getAttribute('href')).toContain('mlon=77.656361')
    // A map needs nothing signed, so nothing is asked for.
    expect(asked).toEqual([])
  })

  test('a question that stores lat/lng reads the same way', async () => {
    // A Location *question* stores what the field type coerced; the form-level
    // position stores latitude/longitude. Both are places.
    await draw({ ...props, value: { lat: 27.499293, lng: 77.656361 } })

    expect(screen.getByText('27.499293, 77.656361')).toBeTruthy()
  })

  test('coordinates that cannot be real are not offered as a place', async () => {
    const { coordinates } = await import('./components/RecordCell.jsx')

    expect(coordinates({ latitude: 91, longitude: 0 })).toBe(null)
    expect(coordinates({ latitude: 0, longitude: 181 })).toBe(null)
    expect(coordinates({ latitude: -91, longitude: -181 })).toBe(null)
    expect(coordinates({ latitude: 'north', longitude: 'east' })).toBe(null)
    expect(coordinates(null)).toBe(null)
    expect(coordinates('27.4, 77.6')).toBe(null)
    expect(coordinates({ latitude: -33.86, longitude: 151.2 }))
      .toMatchObject({ lat: -33.86, lng: 151.2 })
  })

  test('an impossible position says so rather than pretending', async () => {
    await draw({ ...props, value: { latitude: 999, longitude: 999 } })

    expect(screen.getByText('Invalid location')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'View on Map' })).toBeNull()
  })
})


describe('the type decides, not the value', () => {
  test('an ordinary answer that looks like a media id is still an answer', async () => {
    // The whole reason this dispatches on the question's type.
    await draw({ column: { name: 'batch_code', type: 'text' }, value: 'MEDebf63912' })

    expect(screen.getByText('MEDebf63912')).toBeTruthy()
    expect(asked).toEqual([])
    expect(screen.queryByRole('link')).toBeNull()
  })

  test('text, numbers, dates, yes/no and multi-answers are unchanged', async () => {
    for (const [type, value, shown] of [
      ['text', 'Maize', 'Maize'],
      ['number', 42, '42'],
      ['date', '2026-09-04', '2026-09-04'],
      ['select', 'Canal', 'Canal'],
      ['multiselect', ['Canal', 'Borewell'], 'Canal, Borewell'],
      ['boolean', true, 'Yes'],
    ]) {
      const { unmount } = await draw({ column: { name: 'q', type }, value })
      expect(screen.getByText(shown)).toBeTruthy()
      unmount()
    }
    expect(asked).toEqual([])
  })

  test('an empty answer is a dash, whatever it asks for', async () => {
    for (const type of ['text', 'image', 'file', 'audio']) {
      const { container, unmount } = await draw({ column: { name: 'q', type }, value: null })
      expect(within(container).getByText('—')).toBeTruthy()
      unmount()
    }
    expect(asked).toEqual([])
  })

  test('an id with no metadata is an upload that never finished', async () => {
    await draw({ column: { name: 'farmer_image', type: 'image' },
                 value: 'MEDgone', media: [] })

    expect(screen.getByText('Unavailable')).toBeTruthy()
    // And no attempt to sign something that is not there.
    expect(asked).toEqual([])
  })
})


describe('what the page is not allowed to know', () => {
  test('the only way to a file is the authorized endpoint', async () => {
    const user = userEvent.setup()
    await draw({ column: { name: 'farmer_image', type: 'image' },
                 value: 'MED1', media: [IMAGE] })
    await user.click(screen.getByRole('link', { name: 'View Image' }))
    await waitFor(() => expect(asked).toHaveLength(1))

    // ids in, a signed link out. Nothing else crosses.
    expect(asked[0]).toEqual(['FRM1', '000001', 'MED1'])
    await waitFor(() => expect(window.open).toHaveBeenCalled())
  })

  test('the source builds no S3 URL and holds no credential', async () => {
    // Read the component itself: a URL assembled here would never reach the
    // backend's authorization, however the tests above happen to be mocked.
    const source = await import('./components/RecordCell.jsx?raw')
      .then((m) => m.default)

    expect(source).not.toMatch(/amazonaws\.com/)
    expect(source).not.toMatch(/s3[:.]/i)
    expect(source).not.toMatch(/AKIA|SECRET_ACCESS_KEY|aws_/i)
    expect(source).not.toMatch(/s3_key/)
    // The one way out is the media endpoint helper.
    expect(source).toMatch(/api\.mediaUrl\(/)
  })
})
