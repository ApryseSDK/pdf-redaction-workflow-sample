export type Status = 'pending' | 'approved' | 'rejected'

export type Source = 'rule' | 'term' | 'presidio' | 'manual'

/** A match found in one page's text, before it has been turned into a box on the page. */
export interface RawMatch {
  rule: string
  label: string
  source: Source
  start: number
  end: number
  text: string
  score?: number
}

/** One suggested redaction shown to the reviewer. */
export interface Suggestion {
  id: string
  source: Source
  rule: string
  label: string
  page: number
  /** The matched text. Shown to the reviewer in the panel; never written to the audit log. */
  text: string
  score?: number
  status: Status
  annotationId?: string
}

export type AuditAction =
  | 'detected'
  | 'approved'
  | 'rejected'
  | 'manual-mark'
  | 'applied'
  | 'sanitized'
  | 'verified'
  | 'downloaded'
  | 'sent'

/** A customer-built audit record. By design it holds rules, pages and counts, never matched text. */
export interface AuditEntry {
  at: string
  reviewer: string
  action: AuditAction
  rule?: string
  page?: number
  suggestionId?: string
  count?: number
  detail?: string
}
