import { describe, expect, it } from 'vitest'
import { auditEntry, auditForSuggestion, sha256Hex, toCsv, toJson } from './audit'
import type { Suggestion } from './types'

const suggestion: Suggestion = {
  id: 's1',
  source: 'rule',
  rule: 'ssn',
  label: 'Social Security number',
  page: 1,
  text: '987-65-4321',
  status: 'approved',
}

describe('audit log', () => {
  it('records rule, page and id but never the matched text', () => {
    const entry = auditForSuggestion('Reviewer', 'approved', suggestion)
    expect(entry).toMatchObject({ reviewer: 'Reviewer', action: 'approved', rule: 'ssn', page: 1, suggestionId: 's1' })
    expect(JSON.stringify(entry)).not.toContain('987-65-4321')
    expect('text' in entry).toBe(false)
  })

  it('exports JSON and CSV without the matched text', () => {
    const entries = [auditForSuggestion('Reviewer', 'approved', suggestion), auditEntry('Reviewer', 'applied', { count: 1 })]
    expect(toJson({ file: 'sample_claim.pdf', originalSha256: 'abc' }, entries)).not.toContain('987-65-4321')
    const csv = toCsv(entries)
    expect(csv.split('\n')[0]).toBe('at,reviewer,action,rule,page,suggestionId,count,detail')
    expect(csv).not.toContain('987-65-4321')
  })

  it('escapes commas and quotes in CSV cells', () => {
    const csv = toCsv([auditEntry('A "quoted", name', 'detected')])
    expect(csv).toContain('"A ""quoted"", name"')
  })

  it('hashes bytes with SHA-256', async () => {
    const hex = await sha256Hex(new TextEncoder().encode('abc'))
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
