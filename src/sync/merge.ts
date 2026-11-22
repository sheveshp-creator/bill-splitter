import type { Syncable } from '../core/types'

export type Kind = 'group' | 'member' | 'expense' | 'settlement' | 'recurring' | 'activity'
const META = new Set(['id', 'updatedAt', 'fieldTimes'])

/** Totally ordered, unique-per-device timestamp: "<ISO>~<device>" (lexical compare == chronological). */
export const makeStamp = (deviceId: string, now = new Date()) => `${now.toISOString()}~${deviceId}`
export const stampToIso = (s: string) => s.split('~')[0]

export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}
const fieldsOf = (r: object) => Object.keys(r).filter((k) => !META.has(k) && (r as never)[k] !== undefined)

/** Names of fields whose value differs between prev and next. */
export function changedFields<T extends Syncable>(prev: T | undefined, next: T): string[] {
  const out: string[] = []
  for (const f of new Set([...(prev ? fieldsOf(prev) : []), ...fieldsOf(next)])) {
    if (!prev || stableStringify((prev as never)[f]) !== stableStringify((next as never)[f])) out.push(f)
  }
  return out
}

/** Return `next` with fieldTimes bumped for fields whose value differs from `prev`. */
export function stampChanges<T extends Syncable>(prev: T | undefined, next: T, stamp: string): T {
  const ft: Record<string, string> = { ...(prev?.fieldTimes ?? {}) }
  for (const f of new Set([...(prev ? fieldsOf(prev) : []), ...fieldsOf(next)])) {
    const a = prev ? (prev as never)[f] : undefined
    const b = (next as never)[f]
    if (!prev || stableStringify(a) !== stableStringify(b)) ft[f] = stamp
  }
  return { ...next, fieldTimes: ft, updatedAt: stampToIso(stamp) }
}

export interface FieldConflict { field: string; mine: unknown; theirs: unknown; winner: 'mine' | 'theirs' }
export interface MergeResult<T> { merged: T; conflicts: FieldConflict[]; changed: boolean }

/**
 * Per-field last-write-wins. `base` maps each field I edited but have not pushed yet to the stamp
 * it had BEFORE my edit. A conflict notice is produced only when the remote also changed that
 * field since (remote stamp newer than base) to a different value, i.e. both sides edited it.
 */
export function mergeRecord<T extends Syncable>(local: T | undefined, remote: T, base?: Record<string, string>): MergeResult<T> {
  if (!local) return { merged: remote, conflicts: [], changed: true }
  const out: Record<string, unknown> = {}
  const ft: Record<string, string> = {}
  const conflicts: FieldConflict[] = []
  for (const f of new Set([...fieldsOf(local), ...fieldsOf(remote)])) {
    const lt = local.fieldTimes?.[f] ?? ''
    const rt = remote.fieldTimes?.[f] ?? ''
    const lv = (local as never)[f], rv = (remote as never)[f]
    const remoteWins = rt > lt
    out[f] = remoteWins ? rv : lv
    ft[f] = remoteWins ? rt : lt
    if (base && f in base && rt > base[f] && lt !== rt && stableStringify(lv) !== stableStringify(rv)) {
      conflicts.push({ field: f, mine: lv, theirs: rv, winner: remoteWins ? 'theirs' : 'mine' })
    }
  }
  const updatedAt = local.updatedAt > remote.updatedAt ? local.updatedAt : remote.updatedAt
  const merged = { ...out, id: local.id, fieldTimes: ft, updatedAt } as unknown as T
  const changed = stableStringify(merged) !== stableStringify(local)
  return { merged, conflicts, changed }
}

/** Wire format <-> record */
export interface WireRecord { kind: Kind; id: string; data: Record<string, unknown>; fieldTimes: Record<string, string> }
export function toWire(kind: Kind, r: Syncable): WireRecord {
  const data: Record<string, unknown> = {}
  for (const f of fieldsOf(r)) data[f] = (r as never)[f]
  return { kind, id: r.id, data, fieldTimes: r.fieldTimes ?? {} }
}
export function fromWire<T extends Syncable>(w: WireRecord & { updatedAt?: string }): T {
  const maxT = Object.values(w.fieldTimes).map(stampToIso).sort().pop() ?? w.updatedAt ?? new Date(0).toISOString()
  return { ...w.data, id: w.id, fieldTimes: w.fieldTimes, updatedAt: maxT } as unknown as T
}

/** Token helpers: 128-bit random, url-safe hex. */
export function generateToken(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}
export const isWellFormedToken = (t: string) => /^[0-9a-f]{32}$/.test(t)
