/**
 * Offering one form in several languages.
 *
 * The rule everything here protects: **only the words change.** A question's
 * `name`, an option's `value`, the type, the rules and the stored answer are
 * the same in every language, because they are what the answer means — so a
 * Hindi response and an English one land in the same column and count together.
 *
 * The grid is rows of what the form says by columns of language, so a gap is
 * visible as a gap rather than as a language you have to switch to and check.
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const SUPPORTED = [
  { code: 'en', name: 'English' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'mr', name: 'मराठी' },
  { code: 'es', name: 'Español' },
]

const drafted = vi.fn(async () => ({
  language: 'hi',
  translations: { title: 'किसान पंजीकरण', fields: { farmer_name: { label: 'किसान का नाम' } } },
}))

vi.mock('./api.js', () => ({
  api: {
    languages: vi.fn(async () => SUPPORTED),
    translateForm: (...args) => drafted(...args),
  },
}))

const { default: Translations } = await import('./components/Translations.jsx')

/** An English form with a section, a text question and a coded one. */
const FORM = {
  title: 'Beneficiary Registration',
  description: 'Who is enrolled, and where.',
  submit_label: 'Submit',
  sections: [{ key: 'basics', title: 'Basics' }],
  fields: [
    { name: 'farmer_name', type: 'text', label: 'Name of farmer',
      help_text: 'As written on the card', options: [] },
    { name: 'crop_type', type: 'select', label: 'Type of crop', options: [
      { value: 'wheat', label: 'Wheat' },
      { value: 'rice', label: 'Rice' },
    ] },
  ],
}

/** Render, and hand back whatever the component last produced. */
function open(form = FORM) {
  const state = { form }
  const onChange = vi.fn((next) => { state.form = next })
  const view = render(<Translations form={form} onChange={onChange} />)
  return { state, onChange, view }
}

/** The row whose element column reads `label`. */
const rowFor = (label) =>
  screen.getAllByRole('row').find((r) => {
    const head = within(r).queryAllByRole('rowheader')[0]
    return head && within(head).queryAllByText(label).length > 0
  })

beforeEach(() => vi.clearAllMocks())

// --------------------------------------------------------------------------- //
describe('adding a language', () => {
  test('a form in one language says so, and offers the rest', async () => {
    open()

    expect(await screen.findByText(/one language so far/i)).toBeTruthy()
    const add = screen.getByLabelText(/add a language/i)
    expect(within(add).getByRole('option', { name: 'हिन्दी' })).toBeTruthy()
  })

  test('adding one lists it on the form, and nothing else changes', async () => {
    const { onChange } = open()
    const user = userEvent.setup()

    await user.selectOptions(await screen.findByLabelText(/add a language/i), 'hi')

    const next = onChange.mock.calls[0][0]
    expect(next.languages).toEqual(['en', 'hi'])
    // The questions are untouched — adding a language is not an edit to them.
    expect(next.fields).toBe(FORM.fields)
  })

  test('a language already on the form is not offered twice', async () => {
    open({ ...FORM, languages: ['en', 'hi'] })

    const add = await screen.findByLabelText(/add a language/i)
    expect(within(add).queryByRole('option', { name: 'हिन्दी' })).toBeNull()
    expect(within(add).getByRole('option', { name: 'मराठी' })).toBeTruthy()
  })
})

// --------------------------------------------------------------------------- //
describe('the grid', () => {
  const withHindi = { ...FORM, languages: ['en', 'hi'] }

  test('a column per language, the form\'s own first', async () => {
    open({ ...withHindi, languages: ['en', 'hi', 'mr'] })

    const head = within(await screen.findByRole('table')).getAllByRole('columnheader')
    expect(head.map((h) => h.textContent.replace(/AI|×|original/g, '').trim()))
      .toEqual(['Form element', 'English', 'हिन्दी', 'मराठी'])
  })

  test('every translatable thing is a row, filled in from the form', async () => {
    open(withHindi)

    // The form's own words, read off the current definition — nobody re-types
    // the questions to translate them.
    expect(within(rowFor('Description')).getByText('Who is enrolled, and where.'))
      .toBeTruthy()
    expect(rowFor('Basics')).toBeTruthy()
    expect(rowFor('Name of farmer')).toBeTruthy()
    // Help text is its own row, named for what it is and hinted with the
    // question it belongs to — two questions' help text are told apart by that.
    expect(within(rowFor('Help text')).getByText('As written on the card')).toBeTruthy()
    expect(within(rowFor('Help text')).getByText('farmer_name')).toBeTruthy()
    // Option labels are translated; their values are not offered at all.
    expect(rowFor('Wheat')).toBeTruthy()
  })

  test('the title, the submit button and the thank-you are not offered', async () => {
    // The same in every language by decision. A translation already stored for
    // one is still applied — it just is not something to fill in here.
    open(withHindi)

    await screen.findByRole('table')
    expect(rowFor('Form title')).toBeUndefined()
    expect(rowFor('Submit button')).toBeUndefined()
    expect(rowFor('Thank-you message')).toBeUndefined()
  })

  test('an option row names the value it belongs to, and never edits it', async () => {
    open(withHindi)

    const row = rowFor('Wheat')
    expect(within(row).getByText('crop_type = wheat')).toBeTruthy()
  })

  test('a translation already entered is shown in its column', async () => {
    open({
      ...withHindi,
      translations: { hi: { fields: { farmer_name: { label: 'किसान का नाम' } } } },
    })

    const row = rowFor('Name of farmer')
    expect(within(row).getByDisplayValue('किसान का नाम')).toBeTruthy()
  })

  test('typing one stores it under the field name, not over the label', async () => {
    const { onChange } = open(withHindi)
    const user = userEvent.setup()

    const row = rowFor('Name of farmer')
    await user.type(within(row).getByRole('textbox'), 'क')

    const next = onChange.mock.calls[0][0]
    expect(next.translations.hi.fields.farmer_name.label).toBe('क')
    // The English label is where it was: a translation sits beside the form's
    // own wording and never replaces it.
    expect(next.fields[0].label).toBe('Name of farmer')
    expect(next.fields[0].name).toBe('farmer_name')
  })

  test('an option translation is stored under the option value', async () => {
    const { onChange } = open(withHindi)
    const user = userEvent.setup()

    await user.type(within(rowFor('Wheat')).getByRole('textbox'), 'ग')

    const next = onChange.mock.calls[0][0]
    expect(next.translations.hi.fields.crop_type.options).toEqual({ wheat: 'ग' })
    // The stored value is untouched — otherwise the same answer would be two
    // different values depending on who filled the form in.
    expect(next.fields[1].options[0].value).toBe('wheat')
  })
})

// --------------------------------------------------------------------------- //
describe('what is missing', () => {
  const withHindi = { ...FORM, languages: ['en', 'hi'] }

  test('an empty cell says it is missing rather than looking filled', async () => {
    // It used to show the English text as the placeholder, which made an
    // untranslated row look done — the one thing this screen exists to find.
    open(withHindi)

    const row = rowFor('Name of farmer')
    expect(within(row).getByText(/translation missing/i)).toBeTruthy()
    expect(within(row).getByRole('textbox').value).toBe('')
  })

  test('a filled cell does not', async () => {
    open({ ...withHindi,
           translations: { hi: { fields: { farmer_name: { label: 'किसान का नाम' } } } } })

    expect(within(rowFor('Name of farmer')).queryByText(/translation missing/i)).toBeNull()
  })

  test('the count says how much is left', async () => {
    open(withHindi)
    // 2 languages' worth of gaps, counted in the bar at the top.
    expect(await screen.findByText(/\d+ missing/)).toBeTruthy()
  })

  test('it says what a gap falls back to', async () => {
    open(withHindi)
    expect(await screen.findByText(/falls back to English/i)).toBeTruthy()
  })
})

// --------------------------------------------------------------------------- //
describe('the language the form is written in', () => {
  // A workbook imported from Spanish is a Spanish form. Its English column is
  // the translation, and English is not special.
  const spanish = {
    ...FORM,
    default_language: 'es',
    title: 'Registro de Beneficiarios',
    languages: ['es', 'en'],
  }

  test('the base column is the form\'s own language, not English', async () => {
    open(spanish)

    const head = within(await screen.findByRole('table')).getAllByRole('columnheader')
    expect(head[1].textContent).toMatch(/Español/)
    expect(head[1].textContent).toMatch(/original/)
  })

  test('the base language cannot be removed, because it is the fallback', async () => {
    open(spanish)

    await screen.findByRole('table')
    expect(screen.queryByRole('button', { name: /remove Español/i })).toBeNull()
    expect(screen.getByRole('button', { name: /remove English/i })).toBeTruthy()
  })

  test('removing a language asks first, and drops its words with it', async () => {
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { onChange } = open({
      ...FORM, languages: ['en', 'hi'],
      translations: { hi: { title: 'किसान पंजीकरण' } },
    })
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: /remove हिन्दी/i }))

    expect(ask).toHaveBeenCalled()
    const next = onChange.mock.calls[0][0]
    expect(next.languages).toEqual(['en'])
    expect(next.translations.hi).toBeUndefined()
    ask.mockRestore()
  })
})

// --------------------------------------------------------------------------- //
describe('drafting one with the model', () => {
  test('it fills the column it was asked for and leaves the others', async () => {
    const { onChange } = open({
      ...FORM, languages: ['en', 'hi', 'mr'],
      translations: { mr: { title: 'लाभार्थी नोंदणी' } },
    })
    const user = userEvent.setup()

    const head = within(await screen.findByRole('table')).getAllByRole('columnheader')
    await user.click(within(head[2]).getByRole('button', { name: 'AI' }))

    await waitFor(() => expect(onChange).toHaveBeenCalled())
    const next = onChange.mock.calls[0][0]
    expect(next.translations.hi.title).toBe('किसान पंजीकरण')
    expect(next.translations.mr.title).toBe('लाभार्थी नोंदणी')
  })

  test('a refusal is shown, and nothing is written', async () => {
    drafted.mockRejectedValueOnce(new Error('The model did not return anything usable.'))
    const { onChange } = open({ ...FORM, languages: ['en', 'hi'] })
    const user = userEvent.setup()

    const head = within(await screen.findByRole('table')).getAllByRole('columnheader')
    await user.click(within(head[2]).getByRole('button', { name: 'AI' }))

    expect(await screen.findByText(/did not return anything usable/i)).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
  })
})

// --------------------------------------------------------------------------- //
describe('what a WhatsApp conversation says', () => {
  // The four things said around the questions: hello, may we ask, never mind,
  // thank you. They live in channel_config.whatsapp and refer to the questions,
  // so they version and roll back with them.
  const chat = {
    ...FORM,
    channel: 'whatsapp',
    languages: ['en', 'hi'],
    channel_config: {
      whatsapp: {
        welcome_message: 'Welcome to the farmer survey',
        consent_message: 'Would you like to continue?',
        decline_message: 'No problem. Send FARMER again any time.',
        completion_message: 'Thank you!',
        order: ['farmer_name', 'crop_type'],
        review: true,
      },
    },
  }

  test('all four are rows, with what the conversation says today', async () => {
    open(chat)

    await screen.findByRole('table')
    expect(within(rowFor('WhatsApp · welcome'))
      .getByText('Welcome to the farmer survey')).toBeTruthy()
    expect(within(rowFor('WhatsApp · asking consent'))
      .getByText('Would you like to continue?')).toBeTruthy()
    expect(within(rowFor('WhatsApp · if they say no'))
      .getByText(/Send FARMER again/)).toBeTruthy()
    expect(within(rowFor('WhatsApp · confirmation')).getByText('Thank you!')).toBeTruthy()
  })

  test('a translation is stored beside the message, not over it', async () => {
    const { onChange } = open(chat)
    const user = userEvent.setup()

    await user.type(
      within(rowFor('WhatsApp · welcome')).getByRole('textbox'), 'न')

    const next = onChange.mock.calls[0][0]
    expect(next.translations.hi.whatsapp.welcome_message).toBe('न')
    // The conversation's own wording is untouched, and so is how it behaves.
    expect(next.channel_config.whatsapp.welcome_message)
      .toBe('Welcome to the farmer survey')
    expect(next.channel_config.whatsapp.order).toEqual(['farmer_name', 'crop_type'])
  })

  test('a message the form does not set is not a row to fill in', async () => {
    // A form asking for no consent has no consent question to translate.
    open({ ...chat, channel_config: { whatsapp: { welcome_message: 'Hello' } } })

    await screen.findByRole('table')
    expect(rowFor('WhatsApp · welcome')).toBeTruthy()
    expect(rowFor('WhatsApp · asking consent')).toBeUndefined()
  })

  test('a web form has no conversation, so no rows for one', async () => {
    open({ ...FORM, languages: ['en', 'hi'] })

    await screen.findByRole('table')
    expect(rowFor('WhatsApp · welcome')).toBeUndefined()
  })
})
