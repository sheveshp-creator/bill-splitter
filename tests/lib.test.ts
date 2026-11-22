import { describe, expect, it } from 'vitest'
import { fitDimensions, validateUpload, MAX_UPLOAD_BYTES } from '../src/lib/image'
import { parseReceipt } from '../src/lib/ocr'
import { csvCell, expensesToCsv, paymentRequestLink, reminderMessage, summaryText } from '../src/lib/share'
import { exp } from './helpers'

const L = (text: string, confidence = 90) => ({ text, confidence })

describe('receipt parsing (OCR text -> items)', () => {
  const r = parseReceipt([
    L('THE GRAND CAFE'), L('Bill No: 1234'), L('Date: 12/03/2025'),
    L('Paneer Tikka 250.00'), L('3 x Chai 20.00 60.00', 88), L('2 Masala Dosa 180.00', 55), L('Coupon -30.00'),
    L('Subtotal 490.00'), L('CGST 2.5% 12.25'), L('SGST 2.5% 12.25'), L('Service Charge 49.00'), L('Tip 20.00'), L('Grand Total 583.50'),
  ])
  it('extracts items with qty and unit price in minor units', () => {
    expect(r.items.map((i) => [i.name, i.qty, i.unitPrice])).toEqual([['Paneer Tikka', 1, 25000], ['Chai', 3, 2000], ['Masala Dosa', 2, 9000]])
    expect(r.items[1].units).toHaveLength(3)
  })
  it('keeps OCR confidence so the UI can highlight low-confidence lines', () => {
    expect(r.items.find((i) => i.name === 'Masala Dosa')!.confidence).toBe(55)
  })
  it('classifies tax / service / tip / discount / totals, ignores header junk', () => {
    expect(r.tax).toBe(2450); expect(r.service).toBe(4900); expect(r.tip).toBe(2000); expect(r.discount).toBe(3000)
    expect(r.subtotal).toBe(49000); expect(r.total).toBe(58350)
  })
  it('garbage in -> nothing out, never throws', () => {
    expect(parseReceipt([L('~~~~'), L(''), L('12345'), L('Thank you!!')]).items).toEqual([])
  })
  it('respects currency decimals (JPY)', () => {
    expect(parseReceipt([L('Ramen 900')], 'JPY').items[0].unitPrice).toBe(900)
  })
})

describe('image safeguards', () => {
  it('fits within max side, preserving aspect ratio, never upscales', () => {
    expect(fitDimensions(4000, 3000)).toEqual({ w: 1600, h: 1200 })
    expect(fitDimensions(800, 600)).toEqual({ w: 800, h: 600 })
  })
  it('rejects wrong types and oversize uploads', () => {
    expect(validateUpload({ type: 'application/pdf', size: 10 })).toMatch(/JPG/)
    expect(validateUpload({ type: 'image/jpeg', size: MAX_UPLOAD_BYTES + 1 })).toMatch(/too large/)
    expect(validateUpload({ type: 'image/png', size: 1000 })).toBeNull()
  })
})

describe('share / export', () => {
  const names = { a: 'Rahul', b: 'Amit' }
  it('WhatsApp summary text', () => {
    expect(summaryText('Goa', [{ from: 'a', to: 'b', amount: 45000 }], names, 'INR')).toContain('Rahul owes Amit ₹450.00')
    expect(summaryText('Goa', [], names, 'INR')).toContain('settled')
  })
  it('reminder includes UPI link only for INR with a valid VPA', () => {
    expect(reminderMessage('Rahul', 'Amit', 45000, 'INR', 'Goa', 'amit@okaxis')).toContain('upi://pay?pa=amit%40okaxis')
    expect(reminderMessage('Rahul', 'Amit', 45000, 'USD', 'Goa', 'amit@okaxis')).not.toContain('upi://')
    expect(reminderMessage('Rahul', 'Amit', 45000, 'INR', 'Goa', 'bad')).not.toContain('upi://')
    expect(paymentRequestLink(undefined, 'Amit', 100, 'INR', 'x')).toBeNull()
  })
  it('CSV escapes quotes/commas and neutralises formula injection', () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""')
    expect(csvCell('=HYPERLINK("evil")')).toMatch(/^"?'=/)
    expect(csvCell('-5')).toBe("'-5")
    const csv = expensesToCsv([exp({ amount: 12345, payers: { a: 12345 }, split: { mode: 'equal', participants: ['a'] }, title: '=cmd|x' })], names)
    expect(csv).toContain("'=cmd|x"); expect(csv).toContain('123.45')
  })
  it('deleted expenses are excluded from export', () => {
    expect(expensesToCsv([exp({ amount: 1, payers: { a: 1 }, split: { mode: 'equal', participants: ['a'] }, deleted: true })], names).split('\r\n')).toHaveLength(1)
  })
})
