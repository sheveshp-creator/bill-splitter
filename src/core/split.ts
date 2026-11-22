import type { Charge, Id, ItemizedExtras, Money, ReceiptItem, SplitSpec } from './types'

export class SplitError extends Error {
  constructor(public code: string, message: string, public remaining?: number) {
    super(message)
  }
}

/**
 * Largest-remainder (Hamilton) apportionment.
 * Splits integer `total` (may be negative or zero) over non-negative integer `weights`
 * so that the parts sum to `total` EXACTLY. Ties break by lower index => deterministic.
 */
export function largestRemainder(total: Money, weights: number[]): Money[] {
  if (!Number.isSafeInteger(total)) throw new SplitError('bad_total', 'Total must be a safe integer')
  if (weights.length === 0) throw new SplitError('no_weights', 'Nobody to split between')
  if (weights.some((w) => !Number.isInteger(w) || w < 0)) throw new SplitError('bad_weight', 'Weights must be non-negative integers')
  const W = weights.reduce((a, b) => a + BigInt(b), 0n)
  if (W === 0n) throw new SplitError('zero_weights', 'Weights sum to zero')
  const neg = total < 0
  const T = BigInt(Math.abs(total))
  const floors: bigint[] = []
  const rems: bigint[] = []
  for (const w of weights) {
    const p = T * BigInt(w)
    floors.push(p / W)
    rems.push(p % W)
  }
  let left = T - floors.reduce((a, b) => a + b, 0n)
  const order = weights.map((_, i) => i).sort((a, b) => (rems[b] === rems[a] ? a - b : rems[b] > rems[a] ? 1 : -1))
  for (const i of order) {
    if (left <= 0n) break
    floors[i] += 1n
    left -= 1n
  }
  return floors.map((f) => (neg ? -Number(f) : Number(f)) || 0)
}

/** multiply-divide with round-half-up on non-negative-ish ints, BigInt-safe */
export function mulDivRound(a: number, b: number, c: number): number {
  const neg = a < 0 !== b < 0
  const n = BigInt(Math.abs(a)) * BigInt(Math.abs(b))
  const d = BigInt(c)
  let q = n / d
  if ((n % d) * 2n >= d) q += 1n
  return neg ? -Number(q) : Number(q)
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const sumVals = (r: Record<Id, number>) => sum(Object.values(r))

export function chargeAmount(c: Charge | undefined, base: Money): Money {
  if (!c || c.value === 0) return 0
  return c.type === 'percent' ? mulDivRound(base, c.value, 10000) : c.value
}

export function itemTotal(i: ReceiptItem): Money {
  return i.unitPrice * i.qty
}

export interface ItemizedResult {
  total: Money
  subtotal: Money
  tax: Money
  tip: Money
  service: Money
  discount: Money
  shares: Record<Id, Money>
  unassigned: { itemId: Id; unit: number }[]
}

/** Full itemized computation. Throws nothing; reports unassigned units. */
export function computeItemized(items: ReceiptItem[], extras: ItemizedExtras): ItemizedResult {
  const subtotals: Record<Id, Money> = {}
  const unassigned: { itemId: Id; unit: number }[] = []
  let S = 0
  for (const it of items) {
    S += itemTotal(it)
    for (let u = 0; u < it.qty; u++) {
      const sh = [...new Set(it.units[u]?.sharers ?? [])]
      if (sh.length === 0) { unassigned.push({ itemId: it.id, unit: u }); continue }
      const parts = largestRemainder(it.unitPrice, sh.map(() => 1))
      sh.forEach((p, i) => { subtotals[p] = (subtotals[p] ?? 0) + parts[i] })
    }
  }
  const discount = Math.min(Math.max(chargeAmount(extras.discount, S), 0), Math.max(S, 0))
  const base = extras.discountBeforeTax ? S - discount : S
  const tax = chargeAmount(extras.tax, base)
  const service = chargeAmount(extras.service, base)
  const tip = chargeAmount(extras.tip, base)
  const total = S + tax + service + tip - discount

  // Distribute each extra among people who have items.
  const people = Object.keys(subtotals).sort()
  const shares: Record<Id, Money> = { ...subtotals }
  if (people.length) {
    const pos = people.map((p) => Math.max(subtotals[p], 0))
    const weights = extras.distribution === 'equal' || sum(pos) === 0 ? people.map(() => 1) : pos
    for (const [amt, sign] of [[tax, 1], [service, 1], [tip, 1], [discount, -1]] as const) {
      if (!amt) continue
      const parts = largestRemainder(amt, weights)
      people.forEach((p, i) => { shares[p] += sign * parts[i] })
    }
  }
  return { total, subtotal: S, tax, tip, service, discount, shares, unassigned }
}

export const itemizedTotal = (items: ReceiptItem[], extras: ItemizedExtras) => computeItemized(items, extras).total

/** Live validation result for forms: never throws. */
export interface Validation {
  ok: boolean
  /** signed: total - allocated. Positive => still to allocate */
  remaining: number
  code?: string
  message?: string
}

export function validateSplit(total: Money, spec: SplitSpec): Validation {
  switch (spec.mode) {
    case 'equal': {
      if (spec.participants.length === 0) return { ok: false, remaining: total, code: 'no_participants', message: 'Pick at least one person' }
      return validateAdjustments(total, spec.adjustments)
    }
    case 'exact': {
      const rem = total - sumVals(spec.amounts)
      return rem === 0 ? { ok: true, remaining: 0 } : { ok: false, remaining: rem, code: 'exact_sum', message: `Amounts are off by ${rem}` }
    }
    case 'percent': {
      const rem = 10000 - sumVals(spec.percents)
      if (Object.keys(spec.percents).length === 0) return { ok: false, remaining: 10000, code: 'no_participants', message: 'Pick at least one person' }
      if (rem !== 0) return { ok: false, remaining: rem, code: 'percent_sum', message: `Percentages are off by ${rem / 100}%` }
      return validateAdjustments(total, spec.adjustments)
    }
    case 'shares': {
      const vals = Object.values(spec.shares)
      if (vals.length === 0 || vals.every((v) => v <= 0)) return { ok: false, remaining: total, code: 'no_participants', message: 'Give at least one person a share' }
      if (vals.some((v) => v < 0)) return { ok: false, remaining: total, code: 'neg_share', message: 'Shares cannot be negative' }
      return validateAdjustments(total, spec.adjustments)
    }
    case 'itemized': {
      const r = computeItemized(spec.items, spec.extras)
      if (spec.items.length === 0) return { ok: false, remaining: 0, code: 'no_items', message: 'Add at least one item' }
      if (r.unassigned.length) return { ok: false, remaining: r.unassigned.length, code: 'unassigned', message: `${r.unassigned.length} item(s) not assigned to anyone` }
      return { ok: true, remaining: total - r.total }
    }
  }
}

function validateAdjustments(total: Money, adj?: Record<Id, Money>): Validation {
  // adjustments are carved out of total; any amount is allowed as the base can be negative
  void total; void adj
  return { ok: true, remaining: 0 }
}

/** Compute what each person owes. Sum of values === total always (throws SplitError otherwise). */
export function computeShares(total: Money, spec: SplitSpec): Record<Id, Money> {
  const v = validateSplit(total, spec)
  if (!v.ok) throw new SplitError(v.code ?? 'invalid', v.message ?? 'Invalid split', v.remaining)
  let out: Record<Id, Money> = {}
  if (spec.mode === 'exact') {
    out = { ...spec.amounts }
  } else if (spec.mode === 'itemized') {
    out = computeItemized(spec.items, spec.extras).shares
  } else {
    const adj = spec.adjustments ?? {}
    const A = sumVals(adj)
    const base = total - A
    let ids: Id[]
    let weights: number[]
    if (spec.mode === 'equal') { ids = [...new Set(spec.participants)]; weights = ids.map(() => 1) }
    else if (spec.mode === 'percent') { ids = Object.keys(spec.percents); weights = ids.map((i) => spec.percents[i]) }
    else { ids = Object.keys(spec.shares).filter((i) => spec.shares[i] > 0); weights = ids.map((i) => Math.round(spec.shares[i] * 100)) }
    const parts = largestRemainder(base, weights)
    ids.forEach((id, i) => { out[id] = parts[i] })
    for (const [id, a] of Object.entries(adj)) out[id] = (out[id] ?? 0) + a
  }
  const s = sumVals(out)
  if (s !== total) throw new SplitError('sum_mismatch', `Split sums to ${s}, expected ${total}`, total - s)
  return out
}

/* ---------------- auto-fix helpers (for the "fix it for me" buttons) ---------------- */

/** Put the whole remainder on one person (default: first). */
export function autoFixExact(total: Money, amounts: Record<Id, Money>, onto?: Id): Record<Id, Money> {
  const ids = Object.keys(amounts)
  if (!ids.length) return amounts
  const target = onto && onto in amounts ? onto : ids[0]
  return { ...amounts, [target]: amounts[target] + (total - sumVals(amounts)) }
}
/** Scale existing percentages to exactly 100% (largest remainder); equal if all zero. */
export function autoFixPercent(percents: Record<Id, number>): Record<Id, number> {
  const ids = Object.keys(percents)
  if (!ids.length) return percents
  const w = ids.map((i) => Math.max(0, percents[i]))
  const parts = largestRemainder(10000, sum(w) === 0 ? w.map(() => 1) : w)
  return Object.fromEntries(ids.map((id, i) => [id, parts[i]]))
}

/** Validate payers sum to total. */
export function validatePayers(total: Money, payers: Record<Id, Money>): Validation {
  const entries = Object.entries(payers)
  if (!entries.length) return { ok: false, remaining: total, code: 'no_payer', message: 'Who paid?' }
  const rem = total - sumVals(payers)
  return rem === 0 ? { ok: true, remaining: 0 } : { ok: false, remaining: rem, code: 'payer_sum', message: `Paid amounts are off by ${rem}` }
}

/** Add a member to an existing equal/shares expense (for "include in past expenses"). */
export function includeMemberInSpec(spec: SplitSpec, id: Id): SplitSpec {
  if (spec.mode === 'equal' && !spec.participants.includes(id)) return { ...spec, participants: [...spec.participants, id] }
  if (spec.mode === 'shares' && !(id in spec.shares)) return { ...spec, shares: { ...spec.shares, [id]: 1 } }
  return spec
}
