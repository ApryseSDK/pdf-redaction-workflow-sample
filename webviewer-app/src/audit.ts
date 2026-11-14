import type { AuditAction, AuditEntry, Suggestion } from './types'

export function auditEntry(
  reviewer: string,
  action: AuditAction,
  extra: Partial<Omit<AuditEntry, 'at' | 'reviewer' | 'action'>> = {},
): AuditEntry {
  return { at: new Date().toISOString(), reviewer, action, ...extra }
}

/** Builds an entry from a suggestion by copying only rule, page and id, so matched text can't leak in. */
export function auditForSuggestion(reviewer: string, action: AuditAction, s: Suggestion): AuditEntry {
  return auditEntry(reviewer, action, { rule: s.rule, page: s.page, suggestionId: s.id })
}

const CSV_COLUMNS: (keyof AuditEntry)[] = ['at', 'reviewer', 'action', 'rule', 'page', 'suggestionId', 'count', 'detail']

function csvCell(value: unknown): string {
  const s = value === undefined || value === null ? '' : String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(entries: AuditEntry[]): string {
  const rows = entries.map((e) => CSV_COLUMNS.map((c) => csvCell(e[c])).join(','))
  return [CSV_COLUMNS.join(','), ...rows].join('\n') + '\n'
}

export function toJson(meta: { file: string; originalSha256?: string }, entries: AuditEntry[]): string {
  return JSON.stringify({ ...meta, exportedAt: new Date().toISOString(), entries }, null, 2)
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
