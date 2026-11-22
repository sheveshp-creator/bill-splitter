import { parseAmount } from '../core/currency'
import type { ReceiptItem } from '../core/types'

export interface OcrLine { text: string; confidence: number }
export interface ParsedReceipt {
  items: ReceiptItem[]
  /** flat amounts found on the receipt (minor units) */
  tax: number; service: number; tip: number; discount: number
  total?: number; subtotal?: number
}
export const LOW_CONFIDENCE = 75

/** Run Tesseract in the browser. Lazy-loaded so it never costs initial page weight. */
export async function runOcr(image: Blob, onProgress?: (p: number) => void): Promise<OcrLine[]> {
  const { createWorker } = await import('tesseract.js')
  const worker = await createWorker('eng', 1, { logger: (m) => { if (m.status === 'recognizing text') onProgress?.(m.progress) } })
  try {
    const { data } = await worker.recognize(image, {}, { blocks: true, text: true })
    const lines = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines))
    if (lines.length) return lines.map((l) => ({ text: l.text.trim(), confidence: l.confidence })).filter((l) => l.text)
    // fallback: plain text, unknown confidence
    return (data.text ?? '').split('\n').map((t) => ({ text: t.trim(), confidence: data.confidence })).filter((l) => l.text)
  } finally { await worker.terminate() }
}

const NUM = String.raw`-?\(?\d[\d,]*(?:\.\d{1,3})?\)?`
const END_NUM = new RegExp(String.raw`(${NUM})\s*(?:cr|dr)?\s*$`, 'i')
const QTY_X_PRICE = new RegExp(String.raw`(\d{1,3})\s*[xX@*]\s*(${NUM})\s+(${NUM})\s*$`)
const QTY_NAME_UNIT_TOTAL = new RegExp(String.raw`^(\d{1,3})\s*[xX@*]\s+(.+?)\s+(${NUM})\s+(${NUM})\s*$`)
const SKIP = /\b(tel|phone|ph\b|invoice|bill\s*no|order\s*(no|#)|date|gstin|table|cashier|thank|change|cash|card|upi|round\s*off)\b/i
const TOTAL = /^(grand\s*)?total|amount\s*(due|payable)|net\s*(payable|amount)|balance\s*due|^to\s*pay/i
const SUBTOTAL = /sub\s*-?\s*total/i

const cleanNum = (s: string) => s.replace(/[()]/g, (c) => (c === '(' ? '-' : ''))
const cleanName = (s: string) => s.replace(/[\s.:\-_|*₹$€£]+$/g, '').replace(/^[\s.:\-_|*]+/, '').replace(/\s{2,}/g, ' ').trim()
const newId = () => (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2))

/** Pure receipt text parser (unit-tested). Everything it returns is meant to be user-corrected. */
export function parseReceipt(lines: OcrLine[], currency = 'INR'): ParsedReceipt {
  const out: ParsedReceipt = { items: [], tax: 0, service: 0, tip: 0, discount: 0 }
  for (const { text, confidence } of lines) {
    const t = text.replace(/\s+/g, ' ').trim()
    if (!t || SKIP.test(t)) continue
    let qty = 1, unit: number | null = null, name = '', lineTotal: number | null = null

    const lead3 = QTY_NAME_UNIT_TOTAL.exec(t)
    const q = QTY_X_PRICE.exec(t)
    if (lead3) {
      qty = Number(lead3[1]); name = cleanName(lead3[2]); unit = parseAmount(cleanNum(lead3[3]), currency); lineTotal = parseAmount(cleanNum(lead3[4]), currency)
    } else if (q) {
      qty = Number(q[1]); unit = parseAmount(cleanNum(q[2]), currency); lineTotal = parseAmount(cleanNum(q[3]), currency)
      name = cleanName(t.slice(0, q.index))
    } else {
      const m = END_NUM.exec(t)
      if (!m) continue
      lineTotal = parseAmount(cleanNum(m[1]), currency)
      name = cleanName(t.slice(0, m.index))
      const lead = /^(\d{1,2})\s*[xX]?\s+(\D.*)$/.exec(name)
      if (lead && lineTotal !== null && lineTotal % Number(lead[1]) === 0) { qty = Number(lead[1]); name = lead[2]; unit = lineTotal / qty }
    }
    if (lineTotal === null || !/[a-zA-Z]/.test(name)) continue
    const low = name.toLowerCase()
    const abs = Math.abs(lineTotal)
    if (SUBTOTAL.test(low)) { out.subtotal = abs; continue }
    if (TOTAL.test(low)) { out.total = abs; continue }
    if (/\b(cgst|sgst|igst|gst|vat|tax)\b/.test(low)) { out.tax += abs; continue }
    if (/service|svc/.test(low)) { out.service += abs; continue }
    if (/\b(tip|gratuity)\b/.test(low)) { out.tip += abs; continue }
    if (/disc|coupon|saving|offer/.test(low)) { out.discount += abs; continue }
    if (unit === null) unit = lineTotal
    out.items.push({ id: newId(), name, unitPrice: unit, qty, units: Array.from({ length: qty }, () => ({ sharers: [] })), confidence })
  }
  return out
}
