import type { Money } from './types'

/** ISO 4217 minor-unit digits for the currencies we expose. */
export const CURRENCY_DECIMALS: Record<string, number> = {
  USD: 2, EUR: 2, GBP: 2, INR: 2, AUD: 2, CAD: 2, SGD: 2, AED: 2, CHF: 2, THB: 2,
  JPY: 0, KRW: 0, VND: 0, IDR: 2,
  KWD: 3, BHD: 3, OMR: 3, JOD: 3,
}
export const CURRENCY_SYMBOL: Record<string, string> = {
  INR: '₹', USD: '$', EUR: '€', GBP: '£', JPY: '¥', AUD: 'A$', CAD: 'C$', SGD: 'S$', AED: 'AED ', KRW: '₩', THB: '฿',
}

export function decimals(code: string): number {
  return CURRENCY_DECIMALS[code.toUpperCase()] ?? 2
}

/**
 * Parse user input like "1,234.5" into minor units. Returns null if invalid or if
 * more fractional digits than the currency allows are given (never silently rounds).
 * Negative values allowed (refunds). Uses string math: no floats.
 */
export function parseAmount(input: string, code: string): Money | null {
  const d = decimals(code)
  const s = input.trim().replace(/[,\s_]/g, '')
  const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(s)
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return null
  const frac = m[3] ?? ''
  if (frac.length > d) return null
  const digits = (m[2] || '0') + frac.padEnd(d, '0')
  const n = Number(digits)
  if (!Number.isSafeInteger(n)) return null
  return m[1] === '-' ? (n === 0 ? 0 : -n) : n
}

/** minor units -> plain decimal string "1234.50" (no grouping) */
export function toDecimalString(minor: Money, code: string): string {
  const d = decimals(code)
  const neg = minor < 0
  const abs = Math.abs(minor).toString().padStart(d + 1, '0')
  const out = d === 0 ? abs : `${abs.slice(0, -d)}.${abs.slice(-d)}`
  return neg ? `-${out}` : out
}

/** Digit grouping follows the currency's home convention: lakh/crore for INR, thousands (1,234,567) for everything else. */
export function formatMoney(minor: Money, code: string, locale = 'en-US'): string {
  const d = decimals(code)
  const neg = minor < 0
  const dec = toDecimalString(Math.abs(minor), code)
  const [int, frac] = dec.split('.')
  // Indian grouping for INR, western otherwise
  const grouped = new Intl.NumberFormat(code === 'INR' ? 'en-IN' : locale).format(BigInt(int))
  const sym = CURRENCY_SYMBOL[code] ?? `${code} `
  return `${neg ? '-' : ''}${sym}${grouped}${d ? '.' + frac : ''}`
}

/**
 * Convert minor units between currencies using a frozen rate
 * (1 `from` unit = `rate` `to` units). BigInt math, round half away from zero.
 */
export function convert(minor: Money, rate: number, from: string, to: string): Money {
  if (from === to || rate === 1 && decimals(from) === decimals(to)) return minor
  const SCALE = 100_000_000n
  const r = BigInt(Math.round(rate * 1e8))
  const shift = decimals(to) - decimals(from)
  let num = BigInt(minor) * r
  let den = SCALE
  if (shift >= 0) num *= 10n ** BigInt(shift)
  else den *= 10n ** BigInt(-shift)
  const neg = num < 0n
  const a = neg ? -num : num
  let q = a / den
  if ((a % den) * 2n >= den) q += 1n
  return Number(neg ? -q : q)
}
