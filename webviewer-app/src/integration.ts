/**
 * The three places this app meets a document system. This is a pattern, not a connector: nothing here knows about
 * SharePoint, Box, S3 or any real product. Swap `sendToDocumentSystem` for your own storage call.
 *
 *   file in    ?file=<url> in the page address loads that PDF instead of the sample
 *   file out   POST {base}/documents   body = the redacted PDF, headers X-File-Name, X-Original-Sha256, X-Output-Sha256
 *   audit out  POST {base}/audit       body = the audit log as JSON
 *
 * Set VITE_SAVE_ENDPOINT in .env.local to turn the "Send" button on.
 */

export interface Source {
  url: string
  name: string
}

/** Reads ?file= from a query string. Only http(s) URLs and same-site paths are accepted. */
export function sourceFromQuery(search: string, fallback: Source): Source {
  const raw = new URLSearchParams(search).get('file')
  if (!raw) return fallback
  const ok = /^https?:\/\//i.test(raw) || (raw.startsWith('/') && !raw.startsWith('//'))
  if (!ok) return fallback
  const last = raw.split('?')[0].split('/').filter(Boolean).pop() || fallback.name
  return { url: raw, name: decodeURIComponent(last) }
}

export interface SendPayload {
  pdf: ArrayBuffer
  fileName: string
  originalSha256?: string
  outputSha256: string
  auditJson: string
}

export interface SendResult {
  documentStatus: number
  auditStatus: number
}

type FetchLike = (input: string, init?: RequestInit) => Promise<{ ok: boolean; status: number }>

export async function sendToDocumentSystem(
  base: string,
  p: SendPayload,
  fetchFn: FetchLike = (u, i) => fetch(u, i),
): Promise<SendResult> {
  const root = base.replace(/\/+$/, '')
  const headers: Record<string, string> = {
    'Content-Type': 'application/pdf',
    'X-File-Name': encodeURIComponent(p.fileName),
    'X-Output-Sha256': p.outputSha256,
  }
  if (p.originalSha256) headers['X-Original-Sha256'] = p.originalSha256

  const doc = await fetchFn(`${root}/documents`, { method: 'POST', headers, body: p.pdf })
  if (!doc.ok) throw new Error(`document upload failed (${doc.status})`)
  const audit = await fetchFn(`${root}/audit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: p.auditJson,
  })
  if (!audit.ok) throw new Error(`audit upload failed (${audit.status}); the document was saved`)
  return { documentStatus: doc.status, auditStatus: audit.status }
}
