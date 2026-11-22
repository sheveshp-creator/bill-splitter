import { describe, expect, it } from 'vitest'
import { fromWire, generateToken, isWellFormedToken, makeStamp, mergeRecord, stampChanges, toWire } from '../src/sync/merge'
import type { Syncable } from '../src/core/types'

interface R extends Syncable { title: string; amount: number; notes?: string }
const base = (p: Partial<R> = {}): R => ({ id: 'x', title: 'Dinner', amount: 100, updatedAt: '', deleted: false, ...p })
const S = (t: string, d = 'aaa') => `2025-01-01T00:00:${t}.000Z~${d}`

describe('stamping', () => {
  it('only changed fields get a new stamp', () => {
    const a = stampChanges(undefined, base(), S('00'))
    const b = stampChanges(a, { ...a, amount: 200 }, S('05'))
    expect(b.fieldTimes!.amount).toBe(S('05')); expect(b.fieldTimes!.title).toBe(S('00'))
  })
  it('stamps are unique per device and chronologically sortable', () => {
    expect(makeStamp('a1', new Date(1000)) < makeStamp('a1', new Date(2000))).toBe(true)
    expect(makeStamp('a1', new Date(1000)) !== makeStamp('b2', new Date(1000))).toBe(true)
  })
})

describe('field-level last-write-wins', () => {
  const orig = stampChanges(undefined, base(), S('00'))
  it('edits to DIFFERENT fields both survive, in either merge order', () => {
    const mine = stampChanges(orig, { ...orig, title: 'Lunch' }, S('10', 'mmm'))
    const theirs = stampChanges(orig, { ...orig, amount: 250 }, S('11', 'ttt'))
    const a = mergeRecord(mine, theirs, { title: S('00') }).merged
    const b = mergeRecord(theirs, mine, { amount: S('00') }).merged
    expect(a).toMatchObject({ title: 'Lunch', amount: 250 })
    expect(a).toEqual(b)                                     // commutative => replicas converge
    expect(mergeRecord(mine, theirs, { title: S('00') }).conflicts).toEqual([])
    expect(mergeRecord(theirs, mine, { amount: S('00') }).conflicts).toEqual([])
  })
  it('same field: later write wins and a visible conflict is reported', () => {
    const mine = stampChanges(orig, { ...orig, amount: 300 }, S('10', 'mmm'))
    const theirs = stampChanges(orig, { ...orig, amount: 400 }, S('12', 'ttt'))
    const r = mergeRecord(mine, theirs, { amount: S('00') })
    expect(r.merged.amount).toBe(400)
    expect(r.conflicts).toEqual([{ field: 'amount', mine: 300, theirs: 400, winner: 'theirs' }])
    const r2 = mergeRecord(theirs, mine, { amount: S('00') })
    expect(r2.merged.amount).toBe(400); expect(r2.conflicts[0].winner).toBe('mine')
  })
  it('no conflict notice if I have nothing pending', () => {
    const theirs = stampChanges(orig, { ...orig, amount: 400 }, S('12', 'ttt'))
    expect(mergeRecord(orig, theirs).conflicts).toEqual([])
  })
  it('idempotent: re-applying the same remote record changes nothing', () => {
    const theirs = stampChanges(orig, { ...orig, amount: 400 }, S('12', 'ttt'))
    const once = mergeRecord(orig, theirs).merged
    const twice = mergeRecord(once, theirs)
    expect(twice.changed).toBe(false); expect(twice.merged).toEqual(once)
  })
  it('delete vs concurrent edit: later of the two on the `deleted` field wins; restore works', () => {
    const del = stampChanges(orig, { ...orig, deleted: true }, S('10', 'mmm'))
    const edit = stampChanges(orig, { ...orig, title: 'X' }, S('11', 'ttt'))
    const m = mergeRecord(del, edit, { deleted: S('00') }).merged
    expect(m.deleted).toBe(true); expect(m.title).toBe('X')            // edit kept, but still deleted
    const restored = stampChanges(del, { ...del, deleted: false }, S('20', 'mmm'))
    expect(mergeRecord(del, restored).merged.deleted).toBe(false)
  })
  it('object-valued fields compare structurally (key order irrelevant)', () => {
    type Q = Syncable & { payers: Record<string, number> }
    const a = stampChanges(undefined, { id: 'q', updatedAt: '', deleted: false, payers: { a: 1, b: 2 } } as Q, S('00'))
    const b = { ...a, payers: { b: 2, a: 1 } }
    expect(mergeRecord(a, b, {}).changed).toBe(false)
  })
  it('wire round trip', () => {
    const r = stampChanges(undefined, base({ notes: 'n' }), S('01'))
    const back = fromWire<R>(toWire('expense', r))
    expect(back).toMatchObject({ id: 'x', title: 'Dinner', notes: 'n' }); expect(back.fieldTimes).toEqual(r.fieldTimes)
  })
})

describe('tokens', () => {
  it('128-bit, hex, unguessable-looking, unique', () => {
    const set = new Set(Array.from({ length: 500 }, generateToken))
    expect(set.size).toBe(500)
    for (const t of set) { expect(t).toHaveLength(32); expect(isWellFormedToken(t)).toBe(true) }
  })
  it('tampered tokens are rejected by shape before any network call', () => {
    for (const bad of ['', 'abc', 'g'.repeat(32), 'A'.repeat(32), generateToken() + '0', '../etc/passwd']) expect(isWellFormedToken(bad)).toBe(false)
  })
})
