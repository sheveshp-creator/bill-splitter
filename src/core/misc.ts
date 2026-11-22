import { toDecimalString } from './currency'
import type { Money, RecurringRule } from './types'

/* ---------- text sanitising (React escapes on render; this guards exports/PDF/links) ---------- */
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g
export function sanitizeText(s: string, max = 200): string {
  return s.replace(CTRL, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}
export const sanitizeNotes = (s: string, max = 2000) => s.replace(CTRL, (c) => (c === '\n' ? '\n' : ' ')).trim().slice(0, max)

/* ---------- UPI ---------- */
export const isValidVpa = (v: string) => /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/.test(v)
export function upiLink(o: { pa: string; pn: string; am: Money; note?: string }): string {
  if (!isValidVpa(o.pa)) throw new Error('Invalid UPI ID')
  if (!(o.am > 0)) throw new Error('Amount must be positive')
  const q = new URLSearchParams()
  q.set('pa', o.pa); q.set('pn', sanitizeText(o.pn, 60)); q.set('am', toDecimalString(o.am, 'INR')); q.set('cu', 'INR')
  if (o.note) q.set('tn', sanitizeText(o.note, 80))
  return `upi://pay?${q.toString().replace(/\+/g, '%20')}`
}

/* ---------- dates: calendar-date strings, no timezone drift ---------- */
export const todayLocal = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const parse = (s: string) => { const [y, m, d] = s.split('-').map(Number); return { y, m, d } }
const fmt = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const dim = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()

/** n-th occurrence from start (n=0 is start). Monthly clamps to month end (31 Jan -> 28 Feb) w/o drift. */
export function occurrence(rule: Pick<RecurringRule, 'frequency' | 'interval' | 'startDate'>, n: number): string {
  const { y, m, d } = parse(rule.startDate)
  const k = n * Math.max(1, rule.interval)
  if (rule.frequency === 'weekly') {
    const t = new Date(Date.UTC(y, m - 1, d + 7 * k))
    return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
  }
  if (rule.frequency === 'monthly') {
    const total = y * 12 + (m - 1) + k
    const ny = Math.floor(total / 12), nm = (total % 12) + 1
    return fmt(ny, nm, Math.min(d, dim(ny, nm)))
  }
  const ny = y + k
  return fmt(ny, m, Math.min(d, dim(ny, m)))
}
/** All occurrence dates <= `today` not yet generated. Capped to avoid runaway loops. */
export function dueOccurrences(rule: RecurringRule, today: string, cap = 400): string[] {
  const out: string[] = []
  for (let n = 0; n < cap; n++) {
    const d = occurrence(rule, n)
    if (d > today || (rule.endDate && d > rule.endDate)) break
    if (!rule.lastGenerated || d > rule.lastGenerated) out.push(d)
  }
  return out
}
/** Deterministic id so two devices generating the same occurrence never duplicate. */
export const recurringExpenseId = (ruleId: string, date: string) => `rec_${ruleId}_${date}`
