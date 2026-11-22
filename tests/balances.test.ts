import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  balanceDelta, canRemoveMember, computeBalances, convertAllocation, displayNames, isSelfSettlement, nameCollisions,
  remapMemberInExpense, remapMemberInSettlement, simplifyDebts,
} from '../src/core/balances'
import { computeShares } from '../src/core/split'
import { exp, settle } from './helpers'

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0)
const eq = (ids: string[]) => ({ mode: 'equal' as const, participants: ids })

describe('balances', () => {
  it('basic: A pays 900 split 3 ways', () => {
    const b = computeBalances([exp({ amount: 900, payers: { a: 900 }, split: eq(['a', 'b', 'c']) })], [], 'INR')
    expect(b).toEqual({ a: 600, b: -300, c: -300 })
  })
  it('multiple payers: A paid 600, B paid 400', () => {
    const b = computeBalances([exp({ amount: 1000, payers: { a: 600, b: 400 }, split: eq(['a', 'b', 'c', 'd']) })], [], 'INR')
    expect(b).toEqual({ a: 350, b: 150, c: -250, d: -250 })
  })
  it('payer not a participant; participant who paid nothing', () => {
    const b = computeBalances([exp({ amount: 1000, payers: { x: 1000 }, split: eq(['a', 'b']) })], [], 'INR')
    expect(b).toEqual({ x: 1000, a: -500, b: -500 })
  })
  it('single-person group, payer is only participant => zero', () => {
    expect(computeBalances([exp({ amount: 500, payers: { a: 500 }, split: eq(['a']) })], [], 'INR')).toEqual({ a: 0 })
  })
  it('deleted expenses/settlements ignored (soft delete + restore)', () => {
    const e = exp({ amount: 900, payers: { a: 900 }, split: eq(['a', 'b', 'c']), deleted: true })
    expect(computeBalances([e], [], 'INR', ['a'])).toEqual({ a: 0 })
    expect(computeBalances([{ ...e, deleted: false }], [], 'INR').a).toBe(600)
  })
  it('refund (negative expense) reverses balances', () => {
    const e1 = exp({ amount: 900, payers: { a: 900 }, split: eq(['a', 'b', 'c']) })
    const r = exp({ amount: -900, payers: { a: -900 }, split: eq(['a', 'b', 'c']) })
    expect(Object.values(computeBalances([e1, r], [], 'INR')).every((v) => v === 0)).toBe(true)
  })
  it('multi-currency: frozen per-expense rate; sums to zero after rounding', () => {
    const e = exp({ amount: 1000, currency: 'USD', rate: 83.337, payers: { a: 1000 }, split: eq(['a', 'b', 'c']) })
    const b = computeBalances([e], [], 'INR')
    expect(sum(b)).toBe(0)
    expect(b.a).toBeGreaterThan(0)
    // historical rate never rewritten: a later expense with another rate does not change the first
    const first = computeBalances([e], [], 'INR')
    const both = computeBalances([e, exp({ amount: 1000, currency: 'USD', rate: 90, payers: { b: 1000 }, split: eq(['a', 'b']) })], [], 'INR')
    expect(both).not.toEqual(first)
    expect(computeBalances([e], [], 'INR')).toEqual(first)
  })
  it('convertAllocation keeps total exact', () => {
    const r = convertAllocation({ a: 333, b: 333, c: 334 }, 0.7777, 'USD', 'EUR')
    expect(sum(r)).toBe(Math.round(1000 * 0.7777))
  })
  it('partial payment, then full', () => {
    const e = exp({ amount: 1000, payers: { a: 1000 }, split: eq(['a', 'b']) })
    expect(computeBalances([e], [settle('b', 'a', 200)], 'INR')).toEqual({ a: 300, b: -300 })
    expect(computeBalances([e], [settle('b', 'a', 200), settle('b', 'a', 300)], 'INR')).toEqual({ a: 0, b: 0 })
  })
  it('overpayment becomes credit', () => {
    const e = exp({ amount: 1000, payers: { a: 1000 }, split: eq(['a', 'b']) })
    const b = computeBalances([e], [settle('b', 'a', 800)], 'INR')
    expect(b).toEqual({ a: -300, b: 300 })
    expect(simplifyDebts(b)).toEqual([{ from: 'a', to: 'b', amount: 300 }])
  })
  it('settling in a different currency uses its own frozen rate', () => {
    const e = exp({ amount: 833700, payers: { a: 833700 }, split: eq(['a', 'b']) })
    // b owes 4168.50 INR; pays 50 USD @ 83.37
    const b = computeBalances([e], [settle('b', 'a', 5000, { currency: 'USD', rate: 83.37 })], 'INR')
    expect(b).toEqual({ a: 0, b: 0 })
  })
  it('settled expense edited later -> delta shown', () => {
    const e = exp({ amount: 1000, payers: { a: 1000 }, split: eq(['a', 'b']) })
    const st = [settle('b', 'a', 500)]
    const before = computeBalances([e], st, 'INR')
    const edited = { ...e, amount: 1200, payers: { a: 1200 } }
    const after = computeBalances([edited], st, 'INR')
    expect(balanceDelta(before, after)).toEqual({ a: 100, b: -100 })
    expect(sum(after)).toBe(0)
  })
  it('deleting an expense that was part of a settlement turns the payment into credit', () => {
    const e = exp({ amount: 1000, payers: { a: 1000 }, split: eq(['a', 'b']) })
    const st = [settle('b', 'a', 500)]
    const after = computeBalances([{ ...e, deleted: true }], st, 'INR')
    expect(after).toEqual({ b: 500, a: -500 })
    expect(balanceDelta(computeBalances([e], st, 'INR'), after)).toEqual({ a: -500, b: 500 })
  })
  it('PROPERTY: balances always sum to 0 (random expenses, currencies, settlements)', () => {
    const ids = ['a', 'b', 'c', 'd']
    const expArb = fc.record({
      amount: fc.integer({ min: -2_000_000, max: 2_000_000 }),
      cur: fc.constantFrom('INR', 'USD', 'JPY', 'KWD'),
      rate: fc.double({ min: 0.001, max: 500, noNaN: true }),
      parts: fc.subarray(ids, { minLength: 1 }),
      payer: fc.constantFrom(...ids), payer2: fc.constantFrom(...ids), frac: fc.integer({ min: 0, max: 100 }),
    })
    const stArb = fc.record({ f: fc.constantFrom(...ids), t: fc.constantFrom(...ids), amt: fc.integer({ min: 1, max: 100000 }), cur: fc.constantFrom('INR', 'USD'), rate: fc.double({ min: 0.01, max: 100, noNaN: true }) })
    fc.assert(fc.property(fc.array(expArb, { maxLength: 8 }), fc.array(stArb, { maxLength: 4 }), (es, ss) => {
      const expenses = es.map((x) => {
        const p1 = Math.trunc((x.amount * x.frac) / 100)
        const payers = x.payer === x.payer2 ? { [x.payer]: x.amount } : { [x.payer]: p1, [x.payer2]: x.amount - p1 }
        return exp({ amount: x.amount, currency: x.cur, rate: x.rate, payers, split: eq(x.parts) })
      })
      const sets = ss.map((s) => settle(s.f, s.t, s.amt, { currency: s.cur, rate: s.rate }))
      const b = computeBalances(expenses, sets, 'INR', ids)
      expect(sum(b)).toBe(0)
      const tr = simplifyDebts(b)
      // applying the transfers settles everyone
      const after = { ...b }
      for (const t of tr) { after[t.from] += t.amount; after[t.to] -= t.amount }
      expect(Object.values(after).every((v) => v === 0)).toBe(true)
      expect(tr.length).toBeLessThanOrEqual(Math.max(0, ids.length - 1))
    }))
  })
})

describe('simplifyDebts', () => {
  it('circular A->B->C->A simplifies to zero', () => {
    const es = [
      exp({ amount: 1000, payers: { a: 1000 }, split: { mode: 'exact', amounts: { b: 1000 } } }),
      exp({ amount: 1000, payers: { b: 1000 }, split: { mode: 'exact', amounts: { c: 1000 } } }),
      exp({ amount: 1000, payers: { c: 1000 }, split: { mode: 'exact', amounts: { a: 1000 } } }),
    ]
    const b = computeBalances(es, [], 'INR')
    expect(Object.values(b).every((v) => v === 0)).toBe(true)
    expect(simplifyDebts(b)).toEqual([])
  })
  it('minimises transactions: chain collapses', () => {
    // a owes b 10, b owes c 10  => a pays c 10 (1 tx)
    expect(simplifyDebts({ a: -10, b: 0, c: 10 })).toEqual([{ from: 'a', to: 'c', amount: 10 }])
  })
  it('classic example', () => {
    const t = simplifyDebts({ a: 50, b: -30, c: -20, d: 0 })
    expect(t).toEqual([{ from: 'b', to: 'a', amount: 30 }, { from: 'c', to: 'a', amount: 20 }])
  })
  it('deterministic, empty, all-zero', () => {
    expect(simplifyDebts({})).toEqual([]); expect(simplifyDebts({ a: 0 })).toEqual([])
    const b = { a: 5, b: 5, c: -5, d: -5 }
    expect(simplifyDebts(b)).toEqual(simplifyDebts({ ...b }))
  })
})

describe('people edge cases', () => {
  it('remove member: blocked when balance != 0, allowed at 0', () => {
    expect(canRemoveMember({ a: 100 }, 'a')).toEqual({ ok: false, reason: 'nonzero_balance', balance: 100 })
    expect(canRemoveMember({ a: 0 }, 'a')).toEqual({ ok: true })
    expect(canRemoveMember({}, 'zz')).toEqual({ ok: true })
  })
  it('archived member keeps history in balances', () => {
    // balances are computed from records, not membership, so archived members still appear
    const b = computeBalances([exp({ amount: 100, payers: { gone: 100 }, split: eq(['gone', 'a']) })], [], 'INR')
    expect(b.gone).toBe(50)
  })
  it('duplicate names are disambiguated and detected', () => {
    const ms = [{ id: '1', name: 'Sam', deleted: false }, { id: '2', name: 'sam', deleted: false }, { id: '3', name: 'Zed', deleted: false }]
    expect(nameCollisions(ms).sort()).toEqual(['1', '2'])
    expect(displayNames(ms)).toEqual({ 1: 'Sam', 2: 'sam (2)', 3: 'Zed' })
  })
  it('merge guest into member: balances preserved, same-record duplicates combined', () => {
    const e = exp({ amount: 900, payers: { guest: 600, real: 300 }, split: { mode: 'shares', shares: { guest: 1, real: 2 } } })
    const before = computeBalances([e], [], 'INR')
    const m = remapMemberInExpense(e, 'guest', 'real')
    const after = computeBalances([m], [], 'INR')
    expect(after.real).toBe((before.guest ?? 0) + (before.real ?? 0))
    expect(after.guest).toBeUndefined()
    expect(sum(after)).toBe(0)
    expect(computeShares(900, m.split)).toEqual({ real: 900 })
  })
  it('merge across all modes', () => {
    const modes = [
      { mode: 'equal' as const, participants: ['g', 'r'] },
      { mode: 'exact' as const, amounts: { g: 400, r: 600 } },
      { mode: 'percent' as const, percents: { g: 4000, r: 6000 } },
      { mode: 'itemized' as const, items: [{ id: 'i', name: 'i', unitPrice: 1000, qty: 1, units: [{ sharers: ['g', 'r'] }] }], extras: { discountBeforeTax: true, distribution: 'proportional' as const } },
    ]
    for (const split of modes) {
      const m = remapMemberInExpense(exp({ amount: 1000, payers: { g: 1000 }, split }), 'g', 'r')
      expect(computeBalances([m], [], 'INR')).toEqual({ r: 0 })
    }
  })
  it('merge settlement may become self-settlement', () => {
    const s = remapMemberInSettlement(settle('g', 'r', 100), 'g', 'r')
    expect(isSelfSettlement(s)).toBe(true)
  })
})
