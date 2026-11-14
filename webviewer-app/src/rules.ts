import type { RawMatch } from './types'

export interface Rule {
  id: string
  label: string
  pattern: RegExp
  /** Optional second check, so a pattern hit that fails it is dropped (for example a card number that fails Luhn). */
  validate?: (text: string) => boolean
}

/** Luhn checksum: the check digit that valid payment card numbers satisfy. */
export function luhn(value: string): boolean {
  const digits = value.replace(/\D/g, '')
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i])
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

export const RULES: Rule[] = [
  { id: 'ssn', label: 'Social Security number', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { id: 'card', label: 'Payment card number', pattern: /\b\d(?:[ -]?\d){12,18}\b/g, validate: luhn },
  { id: 'email', label: 'Email address', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { id: 'phone', label: 'Phone number', pattern: /(?<!\d)(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)/g },
]

/** Drop matches that overlap an earlier or longer one, so no text is marked twice. */
export function resolveOverlaps(matches: RawMatch[]): RawMatch[] {
  const sorted = [...matches].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
  const kept: RawMatch[] = []
  let lastEnd = -1
  for (const m of sorted) {
    if (m.start >= lastEnd) {
      kept.push(m)
      lastEnd = m.end
    }
  }
  return kept
}

/** Run the enabled rules and any literal terms over one page of text. */
export function findMatches(text: string, rules: Rule[], terms: string[]): RawMatch[] {
  const found: RawMatch[] = []

  for (const rule of rules) {
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g'
    for (const m of text.matchAll(new RegExp(rule.pattern.source, flags))) {
      const value = m[0]
      if (rule.validate && !rule.validate(value)) continue
      const start = m.index ?? 0
      found.push({ rule: rule.id, label: rule.label, source: 'rule', start, end: start + value.length, text: value })
    }
  }

  const haystack = text.toLowerCase()
  for (const raw of terms) {
    const term = raw.trim()
    if (!term) continue
    const needle = term.toLowerCase()
    let at = haystack.indexOf(needle)
    while (at !== -1) {
      found.push({
        rule: 'term',
        label: `Term: ${term}`,
        source: 'term',
        start: at,
        end: at + needle.length,
        text: text.slice(at, at + needle.length),
      })
      at = haystack.indexOf(needle, at + needle.length)
    }
  }

  return resolveOverlaps(found)
}

/** Split a comma- or newline-separated box of terms into a clean list. */
export function parseTerms(input: string): string[] {
  return input
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter(Boolean)
}
