import { convert } from './currency'
import { computeShares } from './split'
import type { Balances, Expense, Id, Member, Money, Settlement, Transfer } from './types'

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

/**
 * Convert an allocation (id -> minor amount) to another currency so that the converted
 * parts sum to convert(sum). Rounds each part, then distributes the leftover ±1 steps over
 * the largest-magnitude entries (deterministic). Keeps balances summing to exactly 0.
 */
export function convertAllocation(vals: Record<Id, Money>, rate: number, from: string, to: string): Record<Id, Money> {
  if (from === to && rate === 1) return { ...vals }
  const ids = Object.keys(vals).sort()
  const out: Record<Id, Money> = {}
  for (const id of ids) out[id] = convert(vals[id], rate, from, to)
  let diff = convert(sum(ids.map((i) => vals[i])), rate, from, to) - sum(ids.map((i) => out[i]))
  const order = [...ids].sort((a, b) => Math.abs(vals[b]) - Math.abs(vals[a]) || (a < b ? -1 : 1))
  let k = 0
  while (diff !== 0 && order.length) {
    const step = diff > 0 ? 1 : -1
    out[order[k % order.length]] += step
    diff -= step
    k++
  }
  return out
}

/** Net balance per person in the group base currency. Positive = is owed money. */
export function computeBalances(
  expenses: Expense[], settlements: Settlement[], base: string, memberIds: Id[] = [],
): Balances {
  const bal: Balances = {}
  const add = (id: Id, v: Money) => { bal[id] = (bal[id] ?? 0) + v }
  for (const id of memberIds) bal[id] = 0
  for (const e of expenses) {
    if (e.deleted) continue
    const owed = convertAllocation(computeShares(e.amount, e.split), e.rate, e.currency, base)
    const paid = convertAllocation(e.payers, e.rate, e.currency, base)
    for (const [id, v] of Object.entries(paid)) add(id, v)
    for (const [id, v] of Object.entries(owed)) add(id, -v)
  }
  for (const s of settlements) {
    if (s.deleted) continue
    const amt = convert(s.amount, s.rate, s.currency, base)
    add(s.from, amt)
    add(s.to, -amt)
  }
  return bal
}

/**
 * Greedy debt simplification. Repeatedly match the largest debtor with the largest
 * creditor, transferring min(|debt|, credit). Each step zeroes at least one person, so at
 * most (n-1) transfers result. Circular debts have zero net and vanish. Deterministic.
 */
export function simplifyDebts(balances: Balances): Transfer[] {
  const cred = Object.entries(balances).filter(([, v]) => v > 0).map(([id, v]) => ({ id, v }))
  const debt = Object.entries(balances).filter(([, v]) => v < 0).map(([id, v]) => ({ id, v: -v }))
  const byAmt = (a: { id: string; v: number }, b: { id: string; v: number }) => b.v - a.v || (a.id < b.id ? -1 : 1)
  const out: Transfer[] = []
  while (cred.length && debt.length) {
    cred.sort(byAmt); debt.sort(byAmt)
    const c = cred[0], d = debt[0]
    const amt = Math.min(c.v, d.v)
    out.push({ from: d.id, to: c.id, amount: amt })
    c.v -= amt; d.v -= amt
    if (c.v === 0) cred.shift()
    if (d.v === 0) debt.shift()
  }
  return out
}

/** Per-person difference after - before (for "this edit changed balances by..." notices). */
export function balanceDelta(before: Balances, after: Balances): Balances {
  const out: Balances = {}
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[id] ?? 0) - (before[id] ?? 0)
    if (d !== 0) out[id] = d
  }
  return out
}

export type RemoveCheck = { ok: true } | { ok: false; reason: 'nonzero_balance'; balance: Money }
/** Members with a non-zero balance must be archived, not deleted. */
export function canRemoveMember(balances: Balances, id: Id): RemoveCheck {
  const b = balances[id] ?? 0
  return b === 0 ? { ok: true } : { ok: false, reason: 'nonzero_balance', balance: b }
}

/** Rewrite every reference to `from` into `into` (member merge). Pure; returns new records. */
export function remapMemberInExpense(e: Expense, from: Id, into: Id): Expense {
  const mapRec = (r: Record<Id, number>) => {
    const o: Record<Id, number> = {}
    for (const [k, v] of Object.entries(r)) { const nk = k === from ? into : k; o[nk] = (o[nk] ?? 0) + v }
    return o
  }
  const mapIds = (a: Id[]) => [...new Set(a.map((x) => (x === from ? into : x)))]
  const s = e.split
  let split = s
  switch (s.mode) {
    case 'equal': split = { ...s, participants: mapIds(s.participants), adjustments: s.adjustments && mapRec(s.adjustments) }; break
    case 'exact': split = { ...s, amounts: mapRec(s.amounts) }; break
    case 'percent': split = { ...s, percents: mapRec(s.percents), adjustments: s.adjustments && mapRec(s.adjustments) }; break
    case 'shares': split = { ...s, shares: mapRec(s.shares), adjustments: s.adjustments && mapRec(s.adjustments) }; break
    case 'itemized': split = { ...s, items: s.items.map((it) => ({ ...it, units: it.units.map((u) => ({ sharers: mapIds(u.sharers) })) })) }; break
  }
  return { ...e, payers: mapRec(e.payers), split }
}
export function remapMemberInSettlement(s: Settlement, from: Id, into: Id): Settlement {
  return { ...s, from: s.from === from ? into : s.from, to: s.to === from ? into : s.to }
}
/** After merge a settlement could become from===to; callers should drop those (net zero). */
export const isSelfSettlement = (s: Settlement) => s.from === s.to

export function nameCollisions(members: Pick<Member, 'id' | 'name' | 'deleted'>[]): Id[] {
  const seen = new Map<string, Id[]>()
  for (const m of members) if (!m.deleted) { const k = m.name.trim().toLowerCase(); seen.set(k, [...(seen.get(k) ?? []), m.id]) }
  return [...seen.values()].filter((v) => v.length > 1).flat()
}
/** Disambiguate duplicate display names: "Sam", "Sam (2)". */
export function displayNames(members: Pick<Member, 'id' | 'name'>[]): Record<Id, string> {
  const count: Record<string, number> = {}
  const out: Record<Id, string> = {}
  for (const m of members) {
    const k = m.name.trim().toLowerCase()
    count[k] = (count[k] ?? 0) + 1
    out[m.id] = count[k] > 1 ? `${m.name} (${count[k]})` : m.name
  }
  return out
}
