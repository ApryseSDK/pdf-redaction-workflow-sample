import { describe, expect, it } from 'vitest'
import { sendToDocumentSystem, sourceFromQuery } from './integration'

const fallback = { url: '/sample_claim.pdf', name: 'sample_claim.pdf' }

describe('sourceFromQuery', () => {
  it('uses the fallback when there is no file parameter', () => {
    expect(sourceFromQuery('', fallback)).toEqual(fallback)
  })
  it('accepts an https URL and takes the file name from it', () => {
    const s = sourceFromQuery('?file=https%3A%2F%2Fdocs.example.com%2Fa%2Fclaim%2520one.pdf%3Fv%3D2', fallback)
    expect(s.url).toBe('https://docs.example.com/a/claim%20one.pdf?v=2')
    expect(s.name).toBe('claim one.pdf')
  })
  it('accepts a same-site path', () => {
    expect(sourceFromQuery('?file=/files/x.pdf', fallback).name).toBe('x.pdf')
  })
  it('rejects other schemes and protocol-relative URLs', () => {
    expect(sourceFromQuery('?file=javascript:alert(1)', fallback)).toEqual(fallback)
    expect(sourceFromQuery('?file=//evil.example/x.pdf', fallback)).toEqual(fallback)
    expect(sourceFromQuery('?file=file:///etc/passwd', fallback)).toEqual(fallback)
  })
})

describe('sendToDocumentSystem', () => {
  const payload = {
    pdf: new ArrayBuffer(4),
    fileName: 'claim one.pdf',
    originalSha256: 'aaa',
    outputSha256: 'bbb',
    auditJson: '{"entries":[]}',
  }

  it('posts the document first, then the audit log', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const res = await sendToDocumentSystem('https://dms.example.com/api/', payload, async (url, init) => {
      calls.push({ url, init })
      return { ok: true, status: 201 }
    })
    expect(calls.map((c) => c.url)).toEqual(['https://dms.example.com/api/documents', 'https://dms.example.com/api/audit'])
    const h = calls[0].init!.headers as Record<string, string>
    expect(h['X-File-Name']).toBe('claim%20one.pdf')
    expect(h['X-Original-Sha256']).toBe('aaa')
    expect(h['X-Output-Sha256']).toBe('bbb')
    expect(res).toEqual({ documentStatus: 201, auditStatus: 201 })
  })

  it('does not send the audit log when the document upload fails', async () => {
    const calls: string[] = []
    await expect(
      sendToDocumentSystem('https://dms.example.com', payload, async (url) => {
        calls.push(url)
        return { ok: false, status: 500 }
      }),
    ).rejects.toThrow('document upload failed (500)')
    expect(calls).toHaveLength(1)
  })

  it('says the document was saved when only the audit upload fails', async () => {
    let n = 0
    await expect(
      sendToDocumentSystem('https://dms.example.com', payload, async () => ({ ok: ++n === 1, status: n === 1 ? 201 : 503 })),
    ).rejects.toThrow('the document was saved')
  })
})
