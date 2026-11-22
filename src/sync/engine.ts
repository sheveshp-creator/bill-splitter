import { useSyncExternalStore } from 'react'
import { db, tableFor, type GroupLocal, type SyncStatus } from '../db/db'
import { enqueueAll } from '../db/repo'
import { fromWire, generateToken, isWellFormedToken, mergeRecord, toWire, type Kind, type WireRecord } from './merge'
import { RemoteError, isConfigured, remote } from './remote'
import type { Syncable } from '../core/types'

/* ---------- tiny observable store for UI ---------- */
interface SyncUi { online: boolean; syncing: boolean; error?: string; configured: boolean }
let ui: SyncUi = { online: typeof navigator === 'undefined' ? true : navigator.onLine, syncing: false, configured: isConfigured() }
const subs = new Set<() => void>()
const setUi = (p: Partial<SyncUi>) => { ui = { ...ui, ...p }; subs.forEach((f) => f()) }
export const useSyncUi = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f) }, () => ui)

const FATAL: Record<string, SyncStatus> = { token_revoked: 'revoked', token_expired: 'expired', invalid_token: 'invalid' }
const BATCH = 50
const OVERLAP_MS = 5000

/** Server cursor minus a safety overlap (late-committing transactions). Merges are idempotent, so re-reading is harmless. */
export function cursorWithOverlap(cursor: string | undefined): string {
  if (!cursor) return ''
  const t = Date.parse(cursor.slice(0, 23) + 'Z')
  return Number.isNaN(t) ? '' : new Date(t - OVERLAP_MS).toISOString()
}

export async function pushOutbox(l: GroupLocal): Promise<void> {
  if (!l.token || l.role === 'viewer') return
  for (;;) {
    const rows = await db.outbox.where('groupId').equals(l.groupId).limit(BATCH).toArray()
    if (!rows.length) return
    const wires: WireRecord[] = []
    const sent: typeof rows = []
    for (const r of rows) {
      const rec = (await tableFor(r.kind).get(r.recordId as never)) as Syncable | undefined
      if (rec) { wires.push(toWire(r.kind, rec)); sent.push(r) } else await db.outbox.delete(r.key)
    }
    if (wires.length) await remote.push(l.token, wires)
    // only drop rows that were not re-queued by a newer local edit while the request was in flight
    await db.transaction('rw', db.outbox, async () => {
      for (const r of sent) {
        const cur = await db.outbox.get(r.key)
        if (cur && cur.stamp === r.stamp) await db.outbox.delete(r.key)
      }
    })
  }
}

export async function applyRemote(groupId: string, records: WireRecord[]): Promise<number> {
  let changed = 0
  for (const w of records) {
    const remoteRec = fromWire<Syncable>(w)
    const table = tableFor(w.kind as Kind)
    await db.transaction('rw', [table, db.outbox, db.conflicts], async () => {
      const local = (await table.get(w.id as never)) as Syncable | undefined
      const pending = (await db.outbox.get(`${w.kind}:${w.id}`))?.base
      const { merged, conflicts, changed: ch } = mergeRecord(local, remoteRec, pending)
      if (ch) { await table.put(merged as never); changed++ }
      if (conflicts.length) {
        const label = ((merged as never as { title?: string; name?: string }).title ?? (merged as never as { name?: string }).name ?? w.kind) as string
        await db.conflicts.add({ groupId, kind: w.kind as Kind, recordId: w.id, label, at: new Date().toISOString(), seen: false, fields: conflicts })
      }
    })
  }
  return changed
}

export async function pullAll(l: GroupLocal): Promise<void> {
  if (!l.token) return
  let cursor = l.lastPull
  for (;;) {
    const res = await remote.pull(l.token, cursorWithOverlap(cursor))
    await applyRemote(l.groupId, res.records)
    cursor = res.cursor
    const archived = res.archived
    await db.local.update(l.groupId, { lastPull: cursor, role: res.role, status: archived ? 'archived' : 'ok', lastSyncedAt: new Date().toISOString() })
    if (!res.more) break
  }
}

const running = new Map<string, Promise<void>>()
/** Pull then push one group. Concurrent calls coalesce. Never throws; surfaces state via db.local.status + ui. */
export function syncGroup(groupId: string): Promise<void> {
  const existing = running.get(groupId)
  if (existing) return existing
  const p = (async () => {
    const l = await db.local.get(groupId)
    if (!l?.token || l.status === 'revoked' || l.status === 'expired' || l.status === 'invalid') return
    setUi({ syncing: true, error: undefined })
    try {
      // pull FIRST so field conflicts against my unsent edits are detected (and visible) before the server merges them
      await pullAll(l)
      await pushOutbox((await db.local.get(groupId))!)
    } catch (e) {
      const code = e instanceof RemoteError ? e.code : 'unknown'
      if (FATAL[code]) await db.local.update(groupId, { status: FATAL[code] })
      else if (code === 'group_archived') await db.local.update(groupId, { status: 'archived' })
      else if (code !== 'offline') setUi({ error: code })
    } finally { setUi({ syncing: false }); running.delete(groupId) }
  })()
  running.set(groupId, p)
  return p
}

export async function syncAll() {
  for (const l of await db.local.toArray()) if (l.token) await syncGroup(l.groupId)
}

/* ---------- sharing ---------- */
export const inviteUrl = (token: string, origin = typeof location === 'undefined' ? '' : location.origin) => `${origin}/join/${token}`

/** Make a local-only group shareable: registers it on the server with this device as owner. */
export async function enableSharing(groupId: string): Promise<GroupLocal> {
  const l = await db.local.get(groupId)
  if (!l) throw new Error('unknown group')
  if (l.token) return l
  const g = await db.groups.get(groupId)
  if (!g) throw new Error('unknown group')
  const token = generateToken()
  await remote.createGroup(groupId, token, toWire('group', g))
  await db.local.update(groupId, { token, role: 'owner', status: 'ok' })
  await enqueueAll(groupId)
  await syncGroup(groupId)
  return (await db.local.get(groupId))!
}

export async function createInvite(groupId: string, role: 'owner' | 'editor' | 'viewer', hours: number | null = null) {
  const l = await db.local.get(groupId)
  if (!l?.token || l.role !== 'owner') throw new RemoteError('forbidden')
  const token = generateToken()
  const id = await remote.createLink(l.token, token, role, hours)
  if (role !== 'owner') {
    await db.local.update(groupId, { links: [...(l.links ?? []), { id, token, role: role as 'editor' | 'viewer', createdAt: new Date().toISOString() }] })
  }
  return { id, token, url: inviteUrl(token) }
}
export async function revokeInvite(groupId: string, linkId: string) {
  const l = await db.local.get(groupId)
  if (!l?.token || l.role !== 'owner') throw new RemoteError('forbidden')
  await remote.revokeLink(l.token, linkId)
  await db.local.update(groupId, { links: (l.links ?? []).filter((x) => x.id !== linkId) })
}
/** Regenerate = revoke old + mint new, same role. */
export async function regenerateInvite(groupId: string, linkId: string, role: 'editor' | 'viewer') {
  await revokeInvite(groupId, linkId)
  return createInvite(groupId, role)
}

export type JoinResult = { groupId: string; role: GroupLocal['role'] } | { error: RemoteError['code'] }
export async function joinWithToken(token: string): Promise<JoinResult> {
  if (!isWellFormedToken(token)) return { error: 'invalid_token' }
  try {
    const r = await remote.redeem(token)
    const existing = await db.local.get(r.group_id)
    // never downgrade an owner's own device to a lesser link
    if (!existing || !existing.token) await db.local.put({ ...(existing ?? {}), groupId: r.group_id, token, role: r.role, status: r.archived ? 'archived' : 'ok' } as GroupLocal)
    await syncGroup(r.group_id)
    return { groupId: r.group_id, role: existing?.role === 'owner' ? 'owner' : r.role }
  } catch (e) { return { error: e instanceof RemoteError ? e.code : 'unknown' } }
}

/* ---------- lifecycle ---------- */
let started = false
let timer: ReturnType<typeof setInterval> | undefined
let kickTimer: ReturnType<typeof setTimeout> | undefined
export const kick = () => { clearTimeout(kickTimer); kickTimer = setTimeout(() => void syncAll(), 400) }

export function startSync(pollMs = 8000) {
  if (started || typeof window === 'undefined') return
  started = true
  window.addEventListener('online', () => { setUi({ online: true }); void syncAll() })
  window.addEventListener('offline', () => setUi({ online: false }))
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void syncAll() })
  db.outbox.hook('creating', () => { kick() })
  timer = setInterval(() => { if (document.visibilityState === 'visible' && navigator.onLine) void syncAll() }, pollMs)
  void syncAll()
}
export const stopSync = () => { clearInterval(timer); started = false }
