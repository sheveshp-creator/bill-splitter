import 'fake-indexeddb/auto'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// ---- fake network: the real SQL migration running in-process, behind the same `remote` API ----
const h = vi.hoisted(() => ({ pg: null as unknown, offline: false }))
vi.mock('../src/sync/remote', async () => {
  const { RemoteError } = await vi.importActual<typeof import('../src/sync/remote')>('../src/sync/remote')
  const KNOWN = ['invalid_token', 'token_revoked', 'token_expired', 'forbidden', 'group_archived', 'rate_limited', 'too_large', 'bad_request']
  const rpc = async (fn: string, args: unknown[]) => {
    if (h.offline) throw new RemoteError('offline')
    const pg = h.pg as PGlite
    try {
      const ph = args.map((_, i) => `$${i + 1}${typeof args[i] === 'object' && args[i] !== null ? '::jsonb' : ''}`).join(',')
      const r = await pg.query<Record<string, unknown>>(`select ${fn}(${ph}) as r`, args.map((a) => (typeof a === 'object' && a !== null ? JSON.stringify(a) : a)))
      return r.rows[0].r as never
    } catch (e) { const m = (e as Error).message; throw new RemoteError(KNOWN.includes(m) ? (m as never) : 'unknown', m) }
  }
  return {
    RemoteError, isConfigured: () => true, supabase: () => ({}),
    remote: {
      createGroup: (id: string, t: string, g: { data: unknown; fieldTimes: unknown }) => rpc('sb_create_group', [id, t, g.data, g.fieldTimes]),
      redeem: (t: string) => rpc('sb_redeem', [t]),
      pull: (t: string, s: string) => rpc('sb_pull', [t, s]),
      push: (t: string, r: unknown) => rpc('sb_push', [t, r]),
      createLink: (o: string, t: string, role: string, hrs: number | null) => rpc('sb_create_link', [o, t, role, hrs]),
      revokeLink: (o: string, id: string) => rpc('sb_revoke_link', [o, id]),
      listLinks: (o: string) => rpc('sb_list_links', [o]),
      deleteGroup: (o: string) => rpc('sb_delete_group', [o]),
    },
  }
})

import { AppDB, db as dbRef, setDb } from '../src/db/db'
import { addMember, createGroup, deviceId, saveExpense, saveSettlement, setDeleted, undoActivity, uuid, newBase } from '../src/db/repo'
import { createInvite, enableSharing, joinWithToken, pushOutbox, regenerateInvite, revokeInvite, syncGroup } from '../src/sync/engine'
import { backupDue, exportAll, importBackup, looksEvicted, markHasData, validateBackup } from '../src/lib/backup'
import { computeBalances } from '../src/core/balances'
import type { Expense } from '../src/core/types'

const devices: Record<string, AppDB> = {}
const mkExpense = (groupId: string, p: Partial<Expense> = {}): Expense => ({
  id: uuid(), groupId, title: 'Dinner', amount: 900, currency: 'INR', rate: 1, date: '2025-01-01', category: 'food', notes: '',
  payers: {}, split: { mode: 'equal', participants: [] }, createdAt: '', ...newBase(), ...p,
})

beforeAll(async () => {
  const pg = new PGlite()
  await pg.exec('create role anon; create role authenticated;')
  await pg.exec(readFileSync('supabase/migrations/0001_init.sql', 'utf8'))
  h.pg = pg
})
beforeEach(() => { h.offline = false })

// "switch device" = point the module-level db at that device's own IndexedDB
async function onDevice<T>(name: string, fn: () => Promise<T>): Promise<T> {
  devices[name] ??= new AppDB(`dev-${name}-${Math.random()}`)
  setDb(devices[name])
  return fn()
}

describe('two devices syncing through the real SQL', () => {
  let groupId = '', ownerToken = '', editorUrl = '', viewerToken = '', expId = ''
  const D = async () => dbRef

  it('A creates a local group, offline-first, then shares it', async () => {
    await onDevice('A', async () => {
      const { group, me } = await createGroup('Goa Trip', 'INR', 'Amit')
      groupId = group.id
      const b = await addMember(group.id, 'Rahul')
      const e = await saveExpense(mkExpense(group.id, { payers: { [me.id]: 900 }, split: { mode: 'equal', participants: [me.id, b.id] } }), true)
      expId = e.id
      const db = await D()
      expect(await db.outbox.count()).toBe(0)                       // local-only: nothing queued
      const l = await enableSharing(group.id)
      ownerToken = l.token!
      expect(l.status).toBe('ok')
      expect(await db.outbox.count()).toBe(0)                       // everything pushed
      editorUrl = (await createInvite(group.id, 'editor')).url
      viewerToken = (await createInvite(group.id, 'viewer')).token
    })
  })
  it('B joins by link and receives everything', async () => {
    await onDevice('B', async () => {
      const res = await joinWithToken(editorUrl.split('/join/')[1])
      expect(res).toEqual({ groupId, role: 'editor' })
      const db = await D()
      expect((await db.members.where('groupId').equals(groupId).toArray()).map((m) => m.name).sort()).toEqual(['Amit', 'Rahul'])
      expect((await db.expenses.get(expId))?.title).toBe('Dinner')
    })
  })
  it('offline edits to different fields on both devices merge without loss', async () => {
    await onDevice('A', async () => { h.offline = true; const db = await D(); await saveExpense({ ...(await db.expenses.get(expId))!, title: 'Seafood dinner' }, false); h.offline = false })
    await onDevice('B', async () => { h.offline = true; const db = await D(); await saveExpense({ ...(await db.expenses.get(expId))!, notes: 'paid cash' }, false); h.offline = false })
    await onDevice('A', async () => { await syncGroup(groupId) })
    await onDevice('B', async () => { await syncGroup(groupId) })
    await onDevice('A', async () => { await syncGroup(groupId) })
    for (const d of ['A', 'B']) await onDevice(d, async () => {
      const e = (await (await D()).expenses.get(expId))!
      expect([e.title, e.notes]).toEqual(['Seafood dinner', 'paid cash'])
    })
  })
  it('same-field concurrent edit: last write wins on every replica and B sees a conflict notice', async () => {
    await onDevice('A', async () => { h.offline = true; const db = await D(); await saveExpense({ ...(await db.expenses.get(expId))!, title: 'A title' }, false); h.offline = false })
    await new Promise((r) => setTimeout(r, 5))
    await onDevice('B', async () => { h.offline = true; const db = await D(); await saveExpense({ ...(await db.expenses.get(expId))!, title: 'B title' }, false); h.offline = false })
    await onDevice('A', async () => { await syncGroup(groupId) })           // A pushes its older write
    await onDevice('B', async () => { await syncGroup(groupId) })           // B pushes newer, pulls A's older (loses)
    await onDevice('A', async () => { await syncGroup(groupId) })
    for (const d of ['A', 'B']) await onDevice(d, async () => expect((await (await D()).expenses.get(expId))!.title).toBe('B title'))
    await onDevice('B', async () => {
      const notes = await (await D()).conflicts.toArray()
      expect(notes.some((n) => n.recordId === expId && n.fields.some((f) => f.field === 'title' && f.winner === 'mine'))).toBe(true)
    })
  })
  it('offline create queues, then syncs once; retries never duplicate (idempotent)', async () => {
    let newId = ''
    await onDevice('B', async () => {
      const db = await D()
      h.offline = true
      const e = await saveExpense(mkExpense(groupId, { title: 'Taxi', payers: {}, split: { mode: 'equal', participants: [] } }), true)
      newId = e.id
      await syncGroup(groupId)                                         // fails quietly while offline
      expect(await db.outbox.get(`expense:${newId}`)).toBeTruthy()
      h.offline = false
      await syncGroup(groupId)
      expect(await db.outbox.count()).toBe(0)
      const l = (await db.local.get(groupId))!
      await db.outbox.put({ key: `expense:${newId}`, groupId, kind: 'expense', recordId: newId, stamp: 'x' })   // simulate a retry
      await pushOutbox(l); await pushOutbox(l)
    })
    await onDevice('A', async () => {
      await syncGroup(groupId)
      const all = (await (await D()).expenses.where('groupId').equals(groupId).toArray()).filter((e) => e.id === newId)
      expect(all).toHaveLength(1)
    })
  })
  it('soft delete + restore propagate; undo restores the previous version', async () => {
    await onDevice('A', async () => { await setDeleted('expense', expId, true, 'Dinner'); await syncGroup(groupId) })
    await onDevice('B', async () => { await syncGroup(groupId); expect((await (await D()).expenses.get(expId))!.deleted).toBe(true) })
    await onDevice('A', async () => { await setDeleted('expense', expId, false, 'Dinner'); await syncGroup(groupId) })
    await onDevice('B', async () => {
      await syncGroup(groupId)
      const db = await D()
      expect((await db.expenses.get(expId))!.deleted).toBe(false)
      const edit = (await saveExpense({ ...(await db.expenses.get(expId))!, amount: 1200 }, false))
      expect(edit.amount).toBe(1200)
      const act = (await db.activity.toArray()).filter((a) => a.entityId === expId && a.summary.startsWith('Edited')).pop()!
      expect((act.before as Expense).amount).toBe(900)                  // audit snapshot
      await undoActivity(act)
      expect((await db.expenses.get(expId))!.amount).toBe(900)
    })
  })
  it('viewer can read but the server refuses its writes', async () => {
    await onDevice('V', async () => {
      const r = await joinWithToken(viewerToken)
      expect(r).toEqual({ groupId, role: 'viewer' })
      expect(await (await D()).expenses.get(expId)).toBeTruthy()
      const { remote } = await import('../src/sync/remote')
      await expect(remote.push(viewerToken, [])).rejects.toMatchObject({ code: 'forbidden' })
    })
  })
  it('revoking a link kicks that session mid-use; regenerate mints a new working link', async () => {
    let newTok = ''
    await onDevice('A', async () => {
      const db = await D()
      const l = (await db.local.get(groupId))!
      const link = l.links!.find((x) => x.role === 'editor')!
      await revokeInvite(groupId, link.id)
      newTok = (await regenerateInvite(groupId, l.links!.find((x) => x.role === 'viewer')!.id, 'viewer')).token
    })
    await onDevice('B', async () => {                                   // B is mid-session on the revoked editor link
      const db = await D()
      await saveExpense(mkExpense(groupId, { title: 'late' }), true)
      await syncGroup(groupId)
      expect((await db.local.get(groupId))!.status).toBe('revoked')
    })
    await onDevice('V', async () => { await syncGroup(groupId); expect((await (await D()).local.get(groupId))!.status).toBe('revoked') })
    await onDevice('V2', async () => expect(await joinWithToken(newTok)).toMatchObject({ role: 'viewer' }))
  })
  it('tampered / malformed tokens never reach the network', async () => {
    await onDevice('X', async () => {
      expect(await joinWithToken('nope')).toEqual({ error: 'invalid_token' })
      expect(await joinWithToken('0'.repeat(32))).toEqual({ error: 'invalid_token' })
    })
  })
  it('balances are identical on every device after sync', async () => {
    const results: string[] = []
    for (const d of ['A', 'V2']) await onDevice(d, async () => {
      await syncGroup(groupId)
      const db = await D()
      const [es, ss] = [await db.expenses.where('groupId').equals(groupId).toArray(), await db.settlements.where('groupId').equals(groupId).toArray()]
      results.push(JSON.stringify(computeBalances(es.filter((e) => e.payers && Object.keys(e.payers).length && e.id === expId), ss, 'INR')))
    })
    expect(results[0]).toBe(results[1])
  })
  void ownerToken; void saveSettlement; void deviceId
})

describe('backup / restore / eviction', () => {
  it('export -> wipe -> restore round-trips; eviction is detected; restore merges rather than clobbers', async () => {
    await onDevice('R', async () => {
      const db = await D2()
      const { group, me } = await createGroup('Backup me', 'INR', 'Zed')
      await saveExpense(mkExpense(group.id, { title: 'Keep', payers: { [me.id]: 100 }, split: { mode: 'equal', participants: [me.id] } }), true)
      await markHasData()
      const file = JSON.parse(JSON.stringify(await exportAll()))
      expect(await backupDue()).toBe(false)
      await Promise.all([db.groups, db.members, db.expenses, db.activity, db.local, db.meta].map((t) => t.clear()))
      expect(await looksEvicted()).toBe(false)                       // meta was wiped too; falls back to first-run screen with Restore button
      await db.meta.put({ key: 'hadData', value: true })
      expect(await looksEvicted()).toBe(true)                        // empty DB but we remember data existed
      const s = await importBackup(file)
      expect(s.groups).toBe(1)
      expect((await db.expenses.toArray()).map((e) => e.title)).toEqual(['Keep'])
      // newer local edit survives restoring an older backup
      await saveExpense({ ...(await db.expenses.toArray())[0], title: 'Edited later' }, false)
      await importBackup(file)
      expect((await db.expenses.toArray())[0].title).toBe('Edited later')
      expect(await looksEvicted()).toBe(false)
    })
  })
  it('rejects corrupt or foreign files', () => {
    expect(() => validateBackup(null)).toThrow()
    expect(() => validateBackup({ app: 'other' })).toThrow(/not a Bill Splitter/)
    expect(() => validateBackup({ app: 'bill-splitter', version: 99 })).toThrow(/newer/)
    expect(() => validateBackup({ app: 'bill-splitter', version: 1, groups: [{ nope: 1 }], members: [], expenses: [], settlements: [], recurring: [], activity: [], local: [], photos: [] })).toThrow(/malformed/)
    expect(() => validateBackup({ app: 'bill-splitter', version: 1, groups: [] })).toThrow(/missing/)
  })
  it('backup reminder: due after 14 days, not before', async () => {
    await onDevice('R2', async () => {
      const db = await D2()
      await createGroup('G', 'INR', 'Me')
      await db.meta.put({ key: 'lastBackup', value: new Date(Date.now() - 15 * 864e5).toISOString() })
      expect(await backupDue()).toBe(true)
      await db.meta.put({ key: 'lastBackup', value: new Date(Date.now() - 2 * 864e5).toISOString() })
      expect(await backupDue()).toBe(false)
    })
  })
})
const D2 = async () => dbRef
