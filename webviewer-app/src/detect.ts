/**
 * The only file that talks to the WebViewer API for detection, review colours, apply and re-scan.
 *
 * Flow per page: loadPageText -> run rules (and optionally Presidio) over the TEXT -> getTextPosition turns each
 * match's character offsets into quads on the page -> a RedactionAnnotation is created for each. These are only
 * MARKS. Nothing is removed from the document until applyRedactions is called on the approved ones.
 *
 * Written against the WebViewer docs (loadPageText / getTextPosition, RedactionAnnotation with Quads,
 * annotationManager.addAnnotations / applyRedactions with a list). These calls ran end to end in a headless browser run (WebViewer 12.2.1) and in hand-run sessions in
 * November 2026. `core` is typed `any` on purpose, because this is the SDK boundary.
 */
import { findMatches, resolveOverlaps, type Rule } from './rules'
import { analyze, fromPresidio } from './presidio'
import type { RawMatch, Status, Suggestion } from './types'

export const COLORS: Record<Status, [number, number, number]> = {
  pending: [230, 126, 34], // orange: waiting for a human
  approved: [39, 174, 96], // green: will be applied
  rejected: [149, 165, 166], // grey: hidden, will be discarded
}

export interface ScanOptions {
  rules: Rule[]
  terms: string[]
  usePresidio: boolean
  /**
   * Ids of annotations the app created itself. The scan adds every new mark's id here BEFORE the marks are added to
   * the document, so the viewer's "annotation added" event can tell automatic marks from ones a reviewer draws by hand.
   */
  knownIds: Set<string>
  onProgress?: (page: number, total: number) => void
}

export interface ScanResult {
  suggestions: Suggestion[]
  annotations: Map<string, any>
  presidioError?: string
}

/** getTextPosition returns quads; make sure they are Core.Math.Quad instances before handing them to an annotation. */
function toQuad(core: any, q: any): any {
  if (q instanceof core.Math.Quad) return q
  return new core.Math.Quad(q.x1, q.y1, q.x2, q.y2, q.x3, q.y3, q.x4, q.y4) // field names for plain quad objects
}

export async function scanDocument(core: any, opts: ScanOptions): Promise<ScanResult> {
  const { documentViewer, annotationManager, Annotations } = core
  const doc = documentViewer.getDocument()
  const total: number = doc.getPageCount()
  const suggestions: Suggestion[] = []
  const annotations = new Map<string, any>()
  let presidioError: string | undefined

  for (let page = 1; page <= total; page++) {
    opts.onProgress?.(page, total)
    const text: string = await doc.loadPageText(page)
    let matches: RawMatch[] = findMatches(text, opts.rules, opts.terms)

    if (opts.usePresidio && text.trim() && !presidioError) {
      try {
        matches = resolveOverlaps([...matches, ...fromPresidio(await analyze(text), text)])
      } catch (err) {
        presidioError = err instanceof Error ? err.message : String(err)
      }
    }

    for (const m of matches) {
      const quads = (await doc.getTextPosition(page, m.start, m.end)).map((q: any) => toQuad(core, q))
      if (quads.length === 0) continue
      const id = `s${suggestions.length + 1}`
      const annot = new Annotations.RedactionAnnotation({
        PageNumber: page,
        Quads: quads,
        StrokeColor: new Annotations.Color(...COLORS.pending),
        FillColor: new Annotations.Color(0, 0, 0), // black boxes once applied
      })
      annot.Author = m.source === 'presidio' ? 'auto-detect (Presidio)' : 'auto-detect (rules)'
      opts.knownIds.add(annot.Id)
      annotations.set(id, annot)
      suggestions.push({
        id,
        source: m.source,
        rule: m.rule,
        label: m.label,
        page,
        text: m.text,
        score: m.score,
        status: 'pending',
        annotationId: annot.Id,
      })
    }
  }

  const list = [...annotations.values()]
  if (list.length > 0) {
    annotationManager.addAnnotations(list)
    annotationManager.drawAnnotationsFromList(list)
  }
  return { suggestions, annotations, presidioError }
}

/** Recolour a mark to show its review status; rejected marks are hidden. */
export function paint(core: any, annot: any, status: Status): void {
  const { annotationManager, Annotations } = core
  annot.StrokeColor = new Annotations.Color(...COLORS[status])
  if (status === 'rejected') {
    annotationManager.hideAnnotations([annot])
  } else {
    annotationManager.showAnnotations([annot])
    annotationManager.redrawAnnotation(annot)
  }
}

export function removeAnnotations(core: any, annots: any[]): void {
  if (annots.length === 0) return
  const am = core.annotationManager
  if (typeof am.deleteAnnotations === 'function') am.deleteAnnotations(annots, { force: true }) // bulk delete, with a one-at-a-time fallback
  else annots.forEach((a) => am.deleteAnnotation(a, { force: true }))
}

/**
 * Applies exactly the list it is given. Removal is permanent in the document that is open.
 * Needs fullAPI: true (client-side), or a WebViewer Server URL.
 */
export async function applyApproved(core: any, approved: any[]): Promise<void> {
  await core.annotationManager.applyRedactions(approved)
}

/** In-app check: run the same rules over the current text and count what is left. */
export async function rescan(core: any, rules: Rule[], terms: string[]) {
  const doc = core.documentViewer.getDocument()
  const total: number = doc.getPageCount()
  const byRule: Record<string, number> = {}
  let remaining = 0
  for (let page = 1; page <= total; page++) {
    const text: string = await doc.loadPageText(page) // reads the text as it is after apply
    for (const m of findMatches(text, rules, terms)) {
      byRule[m.rule] = (byRule[m.rule] ?? 0) + 1
      remaining++
    }
  }
  return { remaining, byRule }
}

/** Bytes of the document as it is now (after apply), for download and hashing. */
export async function currentFileData(core: any): Promise<ArrayBuffer> {
  return core.documentViewer.getDocument().getFileData() // the redacted bytes, with the full API
}

/** What the hidden-data step removes, in plain words. Shown in the UI and written to the audit log. */
export const SANITIZE_CATEGORIES = [
  'document metadata',
  'embedded files',
  'comments and markups',
  'hidden layers',
  'hidden text',
  'actions (links and scripts)',
  'bookmarks',
]

/**
 * EXPERIMENTAL in the browser. Calls the Apryse sanitizer (PDFNet.Sanitizer) on the open document. Apryse documents
 * sanitization as a Server SDK capability, and support and licensing in the Web SDK are unconfirmed. It ran in a
 * headless test on WebViewer 12.2.1 in demo mode, but that does not establish production support.
 * Run it after applying redactions. Sanitizing first was never tested, so no claim is made about what happens to marks.
 * Not covered: text inside scanned images, form field data, occluded text. Those are separate decisions.
 */
export async function sanitizeHidden(core: any): Promise<void> {
  const { PDFNet } = core
  await PDFNet.runWithCleanup(async () => {
    const doc = await core.documentViewer.getDocument().getPDFDoc()
    const options = await PDFNet.Sanitizer.createSanitizeOptions()
    await options.setMetadata(true)
    await options.setEmbeddedContent(true)
    await options.setMarkups(true)
    await options.setHiddenLayers(true)
    await options.setHiddenText(true)
    await options.setActions(true)
    await options.setBookmarks(true)
    await PDFNet.Sanitizer.sanitizeDocument(doc, options)
  })
}
