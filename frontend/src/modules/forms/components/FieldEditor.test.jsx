/**
 * Selecting a question, and the inspector following it.
 *
 * The list and the inspector are the same component in two modes, driven by one
 * piece of state in the page — the *name* of the chosen question, never its
 * index. These tests stand in for that page, so they exercise the contract the
 * two sides actually share: click a row, the panel shows that question;
 * reorder or delete, and it still shows the one it was showing.
 */
import React, { useState } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import FieldEditor from './FieldEditor.jsx'

vi.mock('../api.js', () => ({ api: {} }))
vi.mock('../../../core/auth.jsx', () => ({ useAuth: () => ({ can: {} }) }))

const FIELDS = [
  { _uid: '1', name: 'name', label: 'Name', type: 'text', options: [], validation: {} },
  { _uid: '2', name: 'age', label: 'Age', type: 'number', options: [], validation: {} },
  { _uid: '3', name: 'gender', label: 'Gender', type: 'text', options: [], validation: {} },
]

/** The page, reduced to the part these tests are about. */
function Workspace({ initial = FIELDS }) {
  const [fields, setFields] = useState(initial)
  // By name, not index: reordering must not leave this pointing elsewhere.
  const [chosen, setChosen] = useState(initial[0].name)

  const index = fields.findIndex((f) => f.name === chosen)
  const field = index < 0 ? null : fields[index]

  const put = (i, next) => {
    // Editing an unsaved question's label renames its key, so the selection
    // follows it — exactly what Builder does.
    if (fields[i].name === chosen && next.name !== chosen) setChosen(next.name)
    setFields(fields.map((f, n) => (n === i ? next : f)))
  }

  const move = (from, to) => {
    const next = [...fields]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setFields(next.map((f, n) => ({ ...f, order: n + 1 })))
  }

  const remove = (i) => {
    const next = fields.filter((_, n) => n !== i).map((f, n) => ({ ...f, order: n + 1 }))
    if (fields[i].name === chosen) {
      const near = next[Math.min(i, next.length - 1)]
      setChosen(near ? near.name : null)
    }
    setFields(next)
  }

  return (
    <div>
      <div data-testid="list">
        {fields.map((f, i) => (
          <FieldEditor
            key={f._uid}
            field={f}
            index={i}
            total={fields.length}
            selected={f.name === chosen}
            onSelect={() => setChosen(f.name)}
            onChange={put}
            onMove={move}
            onRemove={remove}
          />
        ))}
      </div>

      <button onClick={() => move(2, 0)}>move gender to top</button>
      <button onClick={() => remove(index)}>delete chosen</button>

      <aside data-testid="inspector">
        {field ? (
          <FieldEditor
            key={field._uid}
            mode="panel"
            field={field}
            index={index}
            total={fields.length}
            onChange={put}
            onRemove={remove}
          />
        ) : (
          <p>Nothing selected</p>
        )}
      </aside>
    </div>
  )
}

/** The question the inspector is showing, read from its Variable tab. */
async function inspecting(user) {
  const inspector = screen.getByTestId('inspector')
  await user.click(within(inspector).getByRole('button', { name: 'Variable' }))
  return within(inspector).getByDisplayValue(/.+/, { selector: 'input' }).value
}

const rows = () => within(screen.getByTestId('list')).getAllByPlaceholderText('Question')

describe('selecting a question', () => {
  test('the first question is inspected to begin with', async () => {
    const user = userEvent.setup()
    render(<Workspace />)

    expect(await inspecting(user)).toBe('name')
  })

  test('clicking a row selects it and the inspector follows', async () => {
    const user = userEvent.setup()
    render(<Workspace />)

    await user.click(rows()[1])

    expect(await inspecting(user)).toBe('age')
  })

  test('clicking another row switches the inspector again', async () => {
    const user = userEvent.setup()
    render(<Workspace />)

    await user.click(rows()[1])
    await user.click(rows()[2])

    expect(await inspecting(user)).toBe('gender')
  })

  test('the ⋯ button selects the question too', async () => {
    const user = userEvent.setup()
    render(<Workspace />)

    const row = rows()[2].closest('.frow')
    await user.click(within(row).getByTitle(/Settings/))

    expect(await inspecting(user)).toBe('gender')
  })

  test('the selected row is marked', async () => {
    const user = userEvent.setup()
    render(<Workspace />)

    await user.click(rows()[1])

    expect(rows()[1].closest('.frow').className).toContain('frow--on')
    expect(rows()[0].closest('.frow').className).not.toContain('frow--on')
  })
})

describe('reordering and deleting', () => {
  test('the inspector still shows the same question after a reorder', async () => {
    const user = userEvent.setup()
    render(<Workspace />)

    await user.click(rows()[1])                                   // Age
    await user.click(screen.getByText('move gender to top'))       // Age is now 3rd

    expect(await inspecting(user)).toBe('age')
  })

  test('a reorder changes the list order and nothing else', async () => {
    const user = userEvent.setup()
    render(<Workspace />)

    await user.click(screen.getByText('move gender to top'))

    expect(rows().map((r) => r.value)).toEqual(['Gender', 'Name', 'Age'])
  })

  test('deleting the inspected question moves to its neighbour', async () => {
    const user = userEvent.setup()
    render(<Workspace />)

    await user.click(rows()[1])                                   // Age
    await user.click(screen.getByText('delete chosen'))

    expect(rows().map((r) => r.value)).toEqual(['Name', 'Gender'])
    expect(await inspecting(user)).toBe('gender')
  })

  test('deleting the last question falls back to the one before it', async () => {
    const user = userEvent.setup()
    render(<Workspace />)

    await user.click(rows()[2])                                   // Gender
    await user.click(screen.getByText('delete chosen'))

    expect(await inspecting(user)).toBe('age')
  })

  test('deleting a question that is not selected leaves the inspector alone', async () => {
    const user = userEvent.setup()
    render(<Workspace initial={FIELDS} />)

    await user.click(rows()[0])                                   // Name
    await user.click(within(rows()[2].closest('.frow')).getByTitle('Delete question'))

    expect(await inspecting(user)).toBe('name')
  })
})

describe('the inspector is one editor, not a copy', () => {
  test('editing in the panel shows up in the list', async () => {
    const user = userEvent.setup()
    render(<Workspace />)

    const inspector = screen.getByTestId('inspector')
    await user.clear(within(inspector).getByPlaceholderText('Question'))
    await user.type(within(inspector).getByPlaceholderText('Question'), 'Full name')

    expect(rows()[0].value).toBe('Full name')
  })

  test('the panel carries the three tabs', () => {
    render(<Workspace />)
    const inspector = within(screen.getByTestId('inspector'))

    for (const name of ['Field', 'Variable', 'Standards']) {
      expect(inspector.getByRole('button', { name })).toBeTruthy()
    }
  })

  test('the stored key lives on the Variable tab, not beside the wording', async () => {
    const user = userEvent.setup()
    render(<Workspace />)
    const inspector = within(screen.getByTestId('inspector'))

    expect(inspector.queryByText('Variable name')).toBeNull()

    await user.click(inspector.getByRole('button', { name: 'Variable' }))

    expect(inspector.getByText('Variable name')).toBeTruthy()
  })
})
