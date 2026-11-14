import type { RawMatch } from './types'

export interface PresidioResult {
  entity_type: string
  start: number
  end: number
  score: number
}

export const ENTITY_LABELS: Record<string, string> = {
  PERSON: 'Person name',
  LOCATION: 'Location',
  US_SSN: 'Social Security number',
  CREDIT_CARD: 'Payment card number',
  EMAIL_ADDRESS: 'Email address',
  PHONE_NUMBER: 'Phone number',
  IBAN_CODE: 'IBAN',
}

/** Turn the service's offsets into matches, trimming stray whitespace and dropping low-confidence hits. */
export function fromPresidio(results: PresidioResult[], text: string, minScore = 0.4): RawMatch[] {
  const matches: RawMatch[] = []
  for (const r of results) {
    if (r.score < minScore) continue
    let { start, end } = r
    if (start < 0 || end > text.length || end <= start) continue
    while (start < end && /\s/.test(text[start])) start++
    while (end > start && /\s/.test(text[end - 1])) end--
    if (end <= start) continue
    matches.push({
      rule: `presidio:${r.entity_type.toLowerCase()}`,
      label: `${ENTITY_LABELS[r.entity_type] ?? r.entity_type} (Presidio)`,
      source: 'presidio',
      start,
      end,
      text: text.slice(start, end),
      score: r.score,
    })
  }
  return matches
}

/** Sends one page of TEXT (never the file) to the local service and returns entity offsets. */
export async function analyze(text: string): Promise<PresidioResult[]> {
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!res.ok) throw new Error(`Presidio service returned ${res.status}`)
  const data = (await res.json()) as { results: PresidioResult[] }
  return data.results
}

export async function presidioAvailable(): Promise<boolean> {
  try {
    const res = await fetch('/api/health', { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}
