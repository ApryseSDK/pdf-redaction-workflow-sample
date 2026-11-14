import { describe, expect, it } from 'vitest'
import { fromPresidio } from './presidio'

const text = 'Name: Jordan A. Example\nSSN 987-65-4321'

describe('fromPresidio', () => {
  it('maps service results to matches and keeps the exact text', () => {
    const matches = fromPresidio(
      [
        { entity_type: 'PERSON', start: 6, end: 23, score: 0.85 },
        { entity_type: 'US_SSN', start: 28, end: 39, score: 0.85 },
      ],
      text,
    )
    expect(matches.map((m) => m.text)).toEqual(['Jordan A. Example', '987-65-4321'])
    expect(matches[0].source).toBe('presidio')
    expect(matches[0].label).toBe('Person name (Presidio)')
  })

  it('drops low-confidence results and out-of-range offsets', () => {
    const matches = fromPresidio(
      [
        { entity_type: 'PERSON', start: 6, end: 23, score: 0.2 },
        { entity_type: 'LOCATION', start: 0, end: 999, score: 0.9 },
        { entity_type: 'LOCATION', start: 10, end: 10, score: 0.9 },
      ],
      text,
    )
    expect(matches).toEqual([])
  })

  it('trims whitespace the model sometimes includes at the edges of a span', () => {
    const [m] = fromPresidio([{ entity_type: 'PERSON', start: 5, end: 24, score: 0.9 }], text)
    expect(m.text).toBe('Jordan A. Example')
    expect(m.start).toBe(6)
    expect(m.end).toBe(23)
  })
})
