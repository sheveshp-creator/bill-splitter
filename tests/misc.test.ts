import { describe, expect, it } from 'vitest'
import { dueOccurrences, isValidVpa, occurrence, recurringExpenseId, sanitizeNotes, sanitizeText, todayLocal, upiLink } from '../src/core/misc'
import type { RecurringRule } from '../src/core/types'

const rule = (p: Partial<RecurringRule>): RecurringRule => ({
  id: 'r1', groupId: 'g', updatedAt: '', deleted: false, frequency: 'monthly', interval: 1, startDate: '2025-01-31',
  template: {} as never, ...p,
})

describe('UPI', () => {
  it('builds deep link with decimals, encoded name, INR', () => {
    expect(upiLink({ pa: 'rahul@okhdfc', pn: 'Rahul K', am: 45000 })).toBe('upi://pay?pa=rahul%40okhdfc&pn=Rahul%20K&am=450.00&cu=INR')
  })
  it('rejects bad VPA / non-positive amount; injection attempts are encoded', () => {
    expect(isValidVpa('a@b')).toBe(false)
    expect(() => upiLink({ pa: 'x y@upi', pn: 'n', am: 100 })).toThrow()
    expect(() => upiLink({ pa: 'ok@upi', pn: 'n', am: 0 })).toThrow()
    const l = upiLink({ pa: 'ok@upi', pn: 'A&am=1&pa=evil@upi', am: 100 })
    expect(new URL(l.replace('upi://', 'http://')).searchParams.get('pa')).toBe('ok@upi')
    expect(new URL(l.replace('upi://', 'http://')).searchParams.get('am')).toBe('1.00')
  })
})

describe('sanitisation', () => {
  it('strips control & bidi chars, collapses whitespace, truncates', () => {
    expect(sanitizeText('  a‮b\n\tc  ')).toBe('a b c')
    expect(sanitizeText('x'.repeat(500), 10)).toHaveLength(10)
    expect(sanitizeNotes('l1\nl2\u0000')).toBe('l1\nl2')
  })
  it('keeps <script> as inert text (React escapes on render)', () => {
    expect(sanitizeText('<script>alert(1)</script>')).toBe('<script>alert(1)</script>')
  })
})

describe('dates / recurring', () => {
  it('monthly from the 31st clamps without drifting', () => {
    const r = rule({})
    expect([0, 1, 2, 3].map((n) => occurrence(r, n))).toEqual(['2025-01-31', '2025-02-28', '2025-03-31', '2025-04-30'])
  })
  it('leap years, weekly, yearly, interval', () => {
    expect(occurrence(rule({ startDate: '2024-02-29', frequency: 'yearly' }), 1)).toBe('2025-02-28')
    expect(occurrence(rule({ startDate: '2025-12-30', frequency: 'weekly', interval: 2 }), 1)).toBe('2026-01-13')
    expect(occurrence(rule({ startDate: '2025-11-15', interval: 3 }), 1)).toBe('2026-02-15')
  })
  it('due occurrences: backfill, lastGenerated, endDate; deterministic ids', () => {
    const r = rule({ startDate: '2025-01-01' })
    expect(dueOccurrences(r, '2025-03-15')).toEqual(['2025-01-01', '2025-02-01', '2025-03-01'])
    expect(dueOccurrences({ ...r, lastGenerated: '2025-02-01' }, '2025-03-15')).toEqual(['2025-03-01'])
    expect(dueOccurrences({ ...r, endDate: '2025-02-15' }, '2025-12-31')).toEqual(['2025-01-01', '2025-02-01'])
    expect(recurringExpenseId('r1', '2025-03-01')).toBe(recurringExpenseId('r1', '2025-03-01'))
  })
  it('todayLocal is a calendar string, backdating just means any earlier string', () => {
    expect(todayLocal(new Date(2025, 0, 5, 23, 59))).toBe('2025-01-05')
    expect('2024-12-31' < todayLocal(new Date(2025, 0, 1))).toBe(true)
  })
})
