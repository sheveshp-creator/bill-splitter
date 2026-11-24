import { formatMoney, toDecimalString } from '../core/currency'
import { isValidVpa, sanitizeText, upiLink } from '../core/misc'
import type { Expense, Id, Transfer } from '../core/types'

export function summaryText(groupName: string, transfers: Transfer[], names: Record<Id, string>, cur: string): string {
  if (!transfers.length) return `${groupName}: all settled up`
  const lines = transfers.map((t) => `• ${names[t.from] ?? '?'} owes ${names[t.to] ?? '?'} ${formatMoney(t.amount, cur)}`)
  return `${groupName} — who owes whom\n${lines.join('\n')}`
}
export function reminderMessage(debtor: string, creditor: string, amount: number, cur: string, groupName: string, upi?: string): string {
  const base = `Hi ${debtor}, a gentle nudge: you owe ${creditor} ${formatMoney(amount, cur)} for "${groupName}".`
  if (upi && cur === 'INR' && isValidVpa(upi)) return `${base}\nPay here: ${upiLink({ pa: upi, pn: creditor, am: amount, note: groupName })}`
  return base
}
export function paymentRequestLink(upi: string | undefined, creditor: string, amount: number, cur: string, note: string): string | null {
  if (!upi || cur !== 'INR' || amount <= 0 || !isValidVpa(upi)) return null
  return upiLink({ pa: upi, pn: creditor, am: amount, note })
}

/** CSV with formula-injection guard (cells starting = + - @ are prefixed with ') */
export const csvCell = (v: unknown): string => {
  let s = String(v ?? '')
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export function expensesToCsv(expenses: Expense[], names: Record<Id, string>): string {
  const head = ['Date', 'Title', 'Category', 'Currency', 'Amount', 'Paid by', 'Split mode', 'Notes']
  const rows = expenses.filter((e) => !e.deleted).sort((a, b) => a.date.localeCompare(b.date)).map((e) => [
    e.date, e.title, e.category, e.currency, toDecimalString(e.amount, e.currency),
    Object.entries(e.payers).map(([id, v]) => `${names[id] ?? id}: ${toDecimalString(v, e.currency)}`).join('; '), e.split.mode, e.notes,
  ])
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')
}

export function download(name: string, blob: Blob) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob); a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}
/** Web Share API with graceful fallbacks (file -> text -> clipboard/download). */
export async function shareText(text: string, title = 'Bill Splitter'): Promise<'shared' | 'copied'> {
  if (navigator.share) { try { await navigator.share({ title, text }); return 'shared' } catch (e) { if ((e as Error).name === 'AbortError') return 'shared' } }
  await navigator.clipboard.writeText(text)
  return 'copied'
}
export async function shareImage(blob: Blob, name: string, text: string): Promise<'shared' | 'downloaded'> {
  const file = new File([blob], name, { type: 'image/png' })
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], text }); return 'shared' } catch (e) { if ((e as Error).name === 'AbortError') return 'shared' } }
  download(name, blob)
  return 'downloaded'
}

/** Render the settle-up summary to a PNG using canvas. */
export function summaryPng(groupName: string, transfers: Transfer[], names: Record<Id, string>, cur: string): Promise<Blob> {
  const W = 800, row = 64, H = 200 + Math.max(1, transfers.length) * row
  const c = document.createElement('canvas'); c.width = W; c.height = H
  const g = c.getContext('2d')!
  g.fillStyle = '#f4efe4'; g.fillRect(0, 0, W, H); g.fillStyle = '#1c1917'; g.fillRect(0, 0, W, 130)
  g.fillStyle = '#f4efe4'; g.font = '700 40px Georgia, serif'; g.fillText(sanitizeText(groupName, 30), 40, 70)
  g.font = '400 22px system-ui, sans-serif'; g.fillStyle = '#f4d03f'; g.fillText('WHO OWES WHOM', 40, 105)
    g.fillStyle = '#1c1917'; g.font = '600 28px system-ui, sans-serif'
  if (!transfers.length) g.fillText('All settled up', 40, 200)
  transfers.forEach((t, i) => {
    const y = 195 + i * row
    g.fillStyle = '#1c1917'; g.font = '600 28px system-ui, sans-serif'; g.fillText(`${sanitizeText(names[t.from] ?? '?', 20)} → ${sanitizeText(names[t.to] ?? '?', 20)}`, 40, y)
    g.fillStyle = '#b7361e'; g.font = '500 28px ui-monospace, monospace'; g.textAlign = 'right'; g.fillText(formatMoney(t.amount, cur), W - 40, y); g.textAlign = 'left'
  })
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('png failed'))), 'image/png'))
}

export async function summaryPdf(groupName: string, expenses: Expense[], transfers: Transfer[], names: Record<Id, string>, cur: string): Promise<Blob> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF()
  let y = 18
  const line = (s: string, size = 10, gap = 6) => { if (y > 280) { doc.addPage(); y = 18 } doc.setFontSize(size); doc.text(s, 14, y); y += gap }
  line(sanitizeText(groupName, 60), 18, 10)
  line('Settle up', 13, 8)
  if (!transfers.length) line('All settled up')
  for (const t of transfers) line(`${names[t.from]} pays ${names[t.to]}  ${formatMoney(t.amount, cur).replace('₹', 'Rs ')}`)
  y += 4; line('Expenses', 13, 8)
  for (const e of expenses.filter((x) => !x.deleted).sort((a, b) => a.date.localeCompare(b.date)))
    line(`${e.date}  ${sanitizeText(e.title, 40)}  ${formatMoney(e.amount, e.currency).replace('₹', 'Rs ')}  (paid: ${Object.keys(e.payers).map((i) => names[i] ?? '?').join(', ')})`)
  return doc.output('blob')
}
