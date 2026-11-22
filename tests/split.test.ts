import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  SplitError, autoFixExact, autoFixPercent, computeItemized, computeShares, includeMemberInSpec, largestRemainder, validatePayers, validateSplit,
} from '../src/core/split'
import type { ReceiptItem, SplitSpec } from '../src/core/types'

const sum = (r: Record<string, number> | number[]) => Object.values(r).reduce((a, b) => a + b, 0)

describe('largestRemainder', () => {
  it('100 paise / 3 -> 34,33,33 deterministic', () => {
    expect(largestRemainder(100, [1, 1, 1])).toEqual([34, 33, 33])
    expect(largestRemainder(100, [1, 1, 1])).toEqual(largestRemainder(100, [1, 1, 1]))
  })
  it('weights', () => expect(largestRemainder(100, [1, 2])).toEqual([33, 67]))
  it('zero and negative totals (refunds)', () => {
    expect(largestRemainder(0, [1, 2])).toEqual([0, 0])
    expect(largestRemainder(-100, [1, 1, 1])).toEqual([-34, -33, -33])
  })
  it('zero weight gets nothing', () => expect(largestRemainder(10, [0, 1])).toEqual([0, 10]))
  it('very large amounts stay exact', () => {
    const t = 9_007_199_254_740_000
    const r = largestRemainder(t, [1, 1, 1, 1, 1, 1, 1])
    expect(sum(r)).toBe(t)
  })
  it('errors', () => {
    expect(() => largestRemainder(10, [])).toThrow(SplitError)
    expect(() => largestRemainder(10, [0, 0])).toThrow(SplitError)
    expect(() => largestRemainder(10, [-1, 2])).toThrow(SplitError)
    expect(() => largestRemainder(1.5, [1])).toThrow(SplitError)
  })
  it('PROPERTY: parts always sum to total, each within 1 of ideal', () => {
    fc.assert(fc.property(
      fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
      fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 12 }).filter((w) => w.some((x) => x > 0)),
      (total, w) => {
        const r = largestRemainder(total, w)
        const W = w.reduce((a, b) => a + b, 0)
        expect(sum(r)).toBe(total)
        r.forEach((p, i) => expect(Math.abs(p - (total * w[i]) / W)).toBeLessThan(1 + 1e-6))
      }))
  })
})

describe('split modes', () => {
  it('equal incl. remainder', () => {
    const r = computeShares(1000, { mode: 'equal', participants: ['a', 'b', 'c'] })
    expect(r).toEqual({ a: 334, b: 333, c: 333 })
  })
  it('equal ignores duplicate participants', () => {
    expect(computeShares(100, { mode: 'equal', participants: ['a', 'a', 'b'] })).toEqual({ a: 50, b: 50 })
  })
  it('single-person group / payer is only participant', () => {
    expect(computeShares(777, { mode: 'equal', participants: ['a'] })).toEqual({ a: 777 })
  })
  it('exact: ok and live error with remaining + auto-fix', () => {
    const spec: SplitSpec = { mode: 'exact', amounts: { a: 300, b: 600 } }
    expect(computeShares(900, spec)).toEqual({ a: 300, b: 600 })
    const bad: SplitSpec = { mode: 'exact', amounts: { a: 300, b: 500 } }
    const v = validateSplit(900, bad)
    expect(v.ok).toBe(false); expect(v.remaining).toBe(100); expect(v.code).toBe('exact_sum')
    expect(() => computeShares(900, bad)).toThrow(SplitError)
    const fixed = autoFixExact(900, bad.amounts, 'b')
    expect(fixed).toEqual({ a: 300, b: 600 })
    expect(validateSplit(900, { mode: 'exact', amounts: fixed }).ok).toBe(true)
  })
  it('exact: over-allocated gives negative remaining', () => {
    expect(validateSplit(100, { mode: 'exact', amounts: { a: 80, b: 80 } }).remaining).toBe(-60)
  })
  it('percent: not summing to 100 -> error, autofix normalises', () => {
    const p = { a: 3000, b: 3000, c: 3000 }
    const v = validateSplit(1000, { mode: 'percent', percents: p })
    expect(v.ok).toBe(false); expect(v.remaining).toBe(1000); expect(v.code).toBe('percent_sum')
    const fixed = autoFixPercent(p)
    expect(sum(fixed)).toBe(10000)
    expect(sum(computeShares(1000, { mode: 'percent', percents: fixed }))).toBe(1000)
    expect(autoFixPercent({ a: 0, b: 0 })).toEqual({ a: 5000, b: 5000 })
  })
  it('percent exact split', () => {
    expect(computeShares(1000, { mode: 'percent', percents: { a: 2500, b: 7500 } })).toEqual({ a: 250, b: 750 })
  })
  it('shares/weights: 2 adults + 1 kid(0.5)', () => {
    const r = computeShares(5000, { mode: 'shares', shares: { a1: 1, a2: 1, kid: 0.5 } })
    expect(r).toEqual({ a1: 2000, a2: 2000, kid: 1000 })
  })
  it('shares: zero-share people excluded, all-zero errors', () => {
    expect(computeShares(100, { mode: 'shares', shares: { a: 1, b: 0 } })).toEqual({ a: 100 })
    expect(validateSplit(100, { mode: 'shares', shares: { a: 0 } }).ok).toBe(false)
    expect(validateSplit(100, { mode: 'shares', shares: { a: -1, b: 2 } }).code).toBe('neg_share')
  })
  it('adjustments +/-: base split of (total - adjustments), then add', () => {
    const r = computeShares(1000, { mode: 'equal', participants: ['a', 'b'], adjustments: { a: 100, b: -100 } })
    expect(r).toEqual({ a: 600, b: 400 })
    // adjustment for a non-listed person
    const r2 = computeShares(1000, { mode: 'equal', participants: ['a', 'b'], adjustments: { c: 200 } })
    expect(r2).toEqual({ a: 400, b: 400, c: 200 })
    expect(sum(r2)).toBe(1000)
  })
  it('refund (negative total) splits mirrored', () => {
    const r = computeShares(-300, { mode: 'equal', participants: ['a', 'b', 'c'] })
    expect(r).toEqual({ a: -100, b: -100, c: -100 })
  })
  it('zero amount ok', () => expect(sum(computeShares(0, { mode: 'equal', participants: ['a', 'b'] }))).toBe(0))
  it('no participants -> error', () => expect(() => computeShares(10, { mode: 'equal', participants: [] })).toThrow(SplitError))
  it('participant added later: include or not', () => {
    const s: SplitSpec = { mode: 'equal', participants: ['a', 'b'] }
    const inc = includeMemberInSpec(s, 'c')
    expect(computeShares(900, inc)).toEqual({ a: 300, b: 300, c: 300 })
    expect(computeShares(900, s)).toEqual({ a: 450, b: 450 }) // "don't include" = leave untouched
    expect(includeMemberInSpec({ mode: 'shares', shares: { a: 2 } }, 'b')).toEqual({ mode: 'shares', shares: { a: 2, b: 1 } })
  })
  it('PROPERTY: shares sum to total for equal/percent/shares', () => {
    fc.assert(fc.property(
      fc.integer({ min: -10_000_000, max: 10_000_000 }),
      fc.uniqueArray(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'), { minLength: 1 }),
      fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 6, maxLength: 6 }),
      (total, ids, w) => {
        expect(sum(computeShares(total, { mode: 'equal', participants: ids }))).toBe(total)
        const shares = Object.fromEntries(ids.map((id, i) => [id, w[i] / 4]))
        expect(sum(computeShares(total, { mode: 'shares', shares }))).toBe(total)
        const pct = autoFixPercent(Object.fromEntries(ids.map((id, i) => [id, w[i]])))
        expect(sum(computeShares(total, { mode: 'percent', percents: pct }))).toBe(total)
      }))
  })
})

describe('payers', () => {
  it('multiple payers must sum to total', () => {
    expect(validatePayers(1000, { a: 600, b: 400 }).ok).toBe(true)
    const v = validatePayers(1000, { a: 600, b: 300 })
    expect(v.ok).toBe(false); expect(v.remaining).toBe(100)
    expect(validatePayers(1000, {}).code).toBe('no_payer')
  })
})

const item = (id: string, price: number, qty: number, units: string[][]): ReceiptItem => ({
  id, name: id, unitPrice: price, qty, units: units.map((s) => ({ sharers: s })),
})
const noExtras = { discountBeforeTax: true, distribution: 'proportional' as const }

describe('itemized', () => {
  it('qty 3 x 50 assigned to different people individually', () => {
    const r = computeItemized([item('beer', 5000, 3, [['a'], ['b'], ['b']])], noExtras)
    expect(r.shares).toEqual({ a: 5000, b: 10000 }); expect(r.total).toBe(15000)
  })
  it('shared by all / subset', () => {
    const r = computeItemized([
      item('pizza', 9000, 1, [['a', 'b', 'c']]),
      item('wine', 1000, 1, [['a', 'b']]),
    ], noExtras)
    expect(r.shares).toEqual({ a: 3500, b: 3500, c: 3000 })
  })
  it('shared item remainder paise handled exactly', () => {
    const r = computeItemized([item('x', 100, 1, [['a', 'b', 'c']])], noExtras)
    expect(sum(r.shares)).toBe(100)
  })
  it('unassigned items reported and block validation', () => {
    const items = [item('x', 100, 2, [['a'], []])]
    expect(computeItemized(items, noExtras).unassigned).toEqual([{ itemId: 'x', unit: 1 }])
    const v = validateSplit(200, { mode: 'itemized', items, extras: noExtras })
    expect(v.ok).toBe(false); expect(v.code).toBe('unassigned')
    expect(() => computeShares(200, { mode: 'itemized', items, extras: noExtras })).toThrow(SplitError)
  })
  const items = [item('a', 10000, 1, [['p']]), item('b', 30000, 1, [['q']])]
  it('tax % + tip % + service flat distributed proportionally', () => {
    const r = computeItemized(items, {
      ...noExtras, tax: { type: 'percent', value: 500 }, tip: { type: 'percent', value: 1000 }, service: { type: 'flat', value: 400 },
    })
    expect(r.tax).toBe(2000); expect(r.tip).toBe(4000); expect(r.service).toBe(400)
    expect(r.total).toBe(40000 + 2000 + 4000 + 400)
    expect(r.shares.p).toBe(10000 + 500 + 1000 + 100)
    expect(r.shares.q).toBe(30000 + 1500 + 3000 + 300)
    expect(sum(r.shares)).toBe(r.total)
  })
  it('equal distribution toggle', () => {
    const r = computeItemized(items, { ...noExtras, distribution: 'equal', tax: { type: 'flat', value: 1000 } })
    expect(r.shares).toEqual({ p: 10500, q: 30500 })
  })
  it('discount before vs after tax toggle', () => {
    const base = { tax: { type: 'percent' as const, value: 1000 }, discount: { type: 'percent' as const, value: 1000 } }
    const before = computeItemized(items, { ...base, discountBeforeTax: true, distribution: 'proportional' })
    const after = computeItemized(items, { ...base, discountBeforeTax: false, distribution: 'proportional' })
    expect(before.tax).toBe(3600); expect(before.total).toBe(40000 - 4000 + 3600)
    expect(after.tax).toBe(4000); expect(after.total).toBe(40000 + 4000 - 4000)
    expect(sum(before.shares)).toBe(before.total); expect(sum(after.shares)).toBe(after.total)
  })
  it('discount is capped to subtotal', () => {
    const r = computeItemized(items, { ...noExtras, discount: { type: 'flat', value: 999999 } })
    expect(r.discount).toBe(40000); expect(r.total).toBe(0)
  })
  it('negative item line (coupon) still sums exactly', () => {
    const r = computeItemized([item('a', 10000, 1, [['p']]), item('coupon', -2000, 1, [['p', 'q']])], { ...noExtras, tax: { type: 'percent', value: 500 } })
    expect(sum(r.shares)).toBe(r.total)
  })
  it('PROPERTY: itemized shares always sum to total', () => {
    const ppl = ['a', 'b', 'c', 'd']
    const itemArb = fc.record({
      price: fc.integer({ min: -5000, max: 500000 }),
      qty: fc.integer({ min: 1, max: 4 }),
      sharers: fc.array(fc.subarray(ppl, { minLength: 1 }), { minLength: 4, maxLength: 4 }),
    })
    const chargeArb = fc.option(fc.oneof(
      fc.record({ type: fc.constant('percent' as const), value: fc.integer({ min: 0, max: 3000 }) }),
      fc.record({ type: fc.constant('flat' as const), value: fc.integer({ min: 0, max: 100000 }) }),
    ), { nil: undefined })
    fc.assert(fc.property(fc.array(itemArb, { minLength: 1, maxLength: 6 }), chargeArb, chargeArb, chargeArb, fc.boolean(), fc.boolean(),
      (its, tax, tip, discount, dbt, eq) => {
        const items = its.map((x, i) => item(`i${i}`, x.price, x.qty, x.sharers.slice(0, x.qty)))
        const r = computeItemized(items, { tax, tip, discount, discountBeforeTax: dbt, distribution: eq ? 'equal' : 'proportional' })
        expect(r.unassigned).toHaveLength(0)
        expect(sum(r.shares)).toBe(r.total)
      }))
  })
})
