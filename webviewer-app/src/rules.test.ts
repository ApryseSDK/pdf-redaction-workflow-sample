import { describe, expect, it } from 'vitest'
import { RULES, findMatches, luhn, parseTerms, resolveOverlaps } from './rules'

const page1 = [
  'Name: Jordan A. Example',
  'Address: 100 Example Street, Springfield',
  'Social Security No.: 987-65-4321',
  'Payment card on file: 4111 1111 1111 1111',
  'Contact email: jordan.example@example.com',
].join('\n')

describe('luhn', () => {
  it('accepts a valid test card number and rejects a corrupted one', () => {
    expect(luhn('4111 1111 1111 1111')).toBe(true)
    expect(luhn('4111 1111 1111 1112')).toBe(false)
  })
  it('rejects strings that are too short or too long to be cards', () => {
    expect(luhn('123456')).toBe(false)
    expect(luhn('1'.repeat(20))).toBe(false)
  })
})

describe('findMatches', () => {
  it('finds each planted item in the sample page text with exact offsets', () => {
    const matches = findMatches(page1, RULES, [])
    const byRule = Object.fromEntries(matches.map((m) => [m.rule, m]))
    expect(byRule.ssn.text).toBe('987-65-4321')
    expect(byRule.card.text).toBe('4111 1111 1111 1111')
    expect(byRule.email.text).toBe('jordan.example@example.com')
    for (const m of matches) expect(page1.slice(m.start, m.end)).toBe(m.text)
  })

  it('does not match a card-shaped number that fails the checksum', () => {
    const matches = findMatches('Ref 4111 1111 1111 1112 end', RULES, [])
    expect(matches.find((m) => m.rule === 'card')).toBeUndefined()
  })

  it('does not include trailing separators in a card match', () => {
    const [m] = findMatches('Card 4111-1111-1111-1111 and more', RULES, []).filter((x) => x.rule === 'card')
    expect(m.text).toBe('4111-1111-1111-1111')
  })

  it('finds US phone numbers in common formats', () => {
    const text = 'Call (555) 123-4567 or 555-123-4567 or 555.123.4567'
    expect(findMatches(text, RULES, []).filter((m) => m.rule === 'phone')).toHaveLength(3)
  })

  it('matches literal terms case-insensitively and finds every occurrence', () => {
    const text = '100 Example Street. Send to 100 EXAMPLE STREET.'
    const matches = findMatches(text, [], ['100 example street'])
    expect(matches).toHaveLength(2)
    expect(matches[1].text).toBe('100 EXAMPLE STREET')
  })

  it('ignores blank terms and returns nothing for empty text', () => {
    expect(findMatches('', RULES, ['', '  '])).toEqual([])
  })

  it('only runs the rules it is given', () => {
    const onlyEmail = RULES.filter((r) => r.id === 'email')
    expect(findMatches(page1, onlyEmail, []).map((m) => m.rule)).toEqual(['email'])
  })
})

describe('resolveOverlaps', () => {
  it('keeps the longer match when two start at the same place, and drops overlapped ones', () => {
    const mk = (start: number, end: number, rule: string) => ({
      rule, label: rule, source: 'rule' as const, start, end, text: '',
    })
    const kept = resolveOverlaps([mk(0, 5, 'short'), mk(0, 10, 'long'), mk(8, 12, 'overlap'), mk(12, 15, 'after')])
    expect(kept.map((m) => m.rule)).toEqual(['long', 'after'])
  })
})

describe('parseTerms', () => {
  it('splits on commas and newlines and trims', () => {
    expect(parseTerms('Jordan A. Example, 100 Example Street\n\n  Springfield ')).toEqual([
      'Jordan A. Example',
      '100 Example Street',
      'Springfield',
    ])
  })
})
