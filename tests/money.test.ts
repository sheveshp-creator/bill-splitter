import { describe, expect, it } from 'vitest'
import { convert, decimals, formatMoney, parseAmount, toDecimalString } from '../src/core/currency'

describe('money parsing / formatting', () => {
  it('parses to integer minor units without floats', () => {
    expect(parseAmount('0.1', 'INR')).toBe(10)
    expect(parseAmount('1,234.50', 'INR')).toBe(123450)
    expect(parseAmount('19.99', 'USD')).toBe(1999)
    expect(parseAmount('.5', 'USD')).toBe(50)
  })
  it('currency-aware decimals: JPY 0, KWD 3', () => {
    expect(decimals('JPY')).toBe(0); expect(decimals('KWD')).toBe(3)
    expect(parseAmount('500', 'JPY')).toBe(500)
    expect(parseAmount('500.5', 'JPY')).toBeNull()
    expect(parseAmount('1.234', 'KWD')).toBe(1234)
    expect(parseAmount('1.2345', 'KWD')).toBeNull()
  })
  it('rejects >2 decimals for INR instead of silently rounding', () => {
    expect(parseAmount('1.005', 'INR')).toBeNull()
  })
  it('handles zero, negative (refund) and garbage', () => {
    expect(parseAmount('0', 'INR')).toBe(0)
    expect(parseAmount('-0', 'INR')).toBe(0)
    expect(Object.is(parseAmount('-0', 'INR'), -0)).toBe(false)
    expect(parseAmount('-25.50', 'INR')).toBe(-2550)
    for (const bad of ['', 'abc', '1.2.3', '--1', '.', '1e5']) expect(parseAmount(bad, 'INR')).toBeNull()
  })
  it('very large amounts: safe integers ok, beyond rejected', () => {
    expect(parseAmount('90000000000000', 'INR')).toBe(9_000_000_000_000_000 > Number.MAX_SAFE_INTEGER ? null : 9_000_000_000_000_000)
    expect(parseAmount('99999999999999999999', 'INR')).toBeNull()
    expect(parseAmount('1000000000', 'INR')).toBe(100_000_000_000)
  })
  it('formats with Indian grouping and sign', () => {
    expect(formatMoney(123456789, 'INR')).toBe('₹12,34,567.89')
    expect(formatMoney(-450, 'INR')).toBe('-₹4.50')
    expect(formatMoney(500, 'JPY')).toBe('¥500')
    expect(toDecimalString(5, 'KWD')).toBe('0.005')
  })
  it('uses standard thousands grouping for non-INR currencies (THB, USD, EUR, GBP, JPY)', () => {
    expect(formatMoney(13983817, 'THB')).toBe('฿139,838.17')
    expect(formatMoney(123456789, 'USD')).toBe('$1,234,567.89')
    expect(formatMoney(123456789, 'EUR')).toBe('€1,234,567.89')
    expect(formatMoney(123456789, 'GBP')).toBe('£1,234,567.89')
    expect(formatMoney(1234567, 'JPY')).toBe('¥1,234,567')
    expect(formatMoney(1234567, 'KWD')).toBe('KWD 1,234.567')
    expect(formatMoney(-99999, 'THB')).toBe('-฿999.99')
    expect(formatMoney(100000, 'THB')).toBe('฿1,000.00')
  })
  it('INR keeps lakh/crore grouping', () => {
    expect(formatMoney(13983817, 'INR')).toBe('₹1,39,838.17')
    expect(formatMoney(1000000000, 'INR')).toBe('₹1,00,00,000.00')
  })
  it('convert uses frozen rate, rounds half away from zero, handles decimals shift', () => {
    expect(convert(1000, 83.5, 'USD', 'INR')).toBe(83500)
    expect(convert(1, 0.5, 'INR', 'INR')).toBe(1)
    expect(convert(100, 0.5, 'USD', 'EUR')).toBe(50)
    expect(convert(-3, 0.5, 'USD', 'EUR')).toBe(-2)
    expect(convert(100, 1, 'USD', 'JPY')).toBe(1) // 100 cents -> 1 unit @1
    expect(convert(1000, 150, 'JPY', 'USD')).toBe(15000000)
  })
})
