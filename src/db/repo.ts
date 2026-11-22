import type { ActivityEntry, Expense, Group, Member, Settlement, Syncable } from '../core/types'
import { sanitizeNotes, sanitizeText } from '../core/misc'
import { changedFields, makeStamp, stampChanges, type Kind } from '../sync/merge'
import { db, tableFor, type GroupLocal } from './db'

export const uuid = () => crypto.randomUUID()

export async function deviceId(): Promise<string> {
  const row = await db.meta.get('deviceId')
  if (row) return row.value as string
  const id = uuid().slice(0, 6)
  await db.meta.put({ key: 'deviceId', value: id })
  return id
}

type Opts = { action: ActivityEntry['action']; summary: string; actorId?: string; silent?: boolean }

/**
 * THE write path. Local-first: stamps changed fields, writes record + activity + outbox in one
 * IndexedDB transaction. Network is never touched here.
 */
export async function saveRecord<T extends Syncable & { groupId?: string }>(kind: Kind, groupId: string, next: T, o: Opts): Promise<T> {
  const dev = await deviceId()
  return db.transaction('rw', [db.groups, db.members, db.expenses, db.settlements, db.recurring, db.activity, db.outbox, db.local], async () => {
    const stamp = makeStamp(dev)
    const table = tableFor(kind)
    const prev = (await table.get(next.id as never)) as T | undefined
    const rec = stampChanges(prev, next, stamp)
    await table.put(rec as never)
    const syncing = !!(await db.local.get(groupId))?.token
    if (syncing) {
      const key = `${kind}:${rec.id}`
      const base = { ...((await db.outbox.get(key))?.base ?? {}) }
      for (const f of changedFields(prev, next)) if (!(f in base)) base[f] = prev?.fieldTimes?.[f] ?? ''
      await db.outbox.put({ key, groupId, kind, recordId: rec.id, stamp, base })
    }
    if (!o.silent && kind !== 'activity') {
      const me = (await db.local.get(groupId))?.meId
      const act: ActivityEntry = {
        id: uuid(), groupId, at: new Date().toISOString(), actor: o.actorId ?? me ?? '', action: o.action,
        entity: kind as ActivityEntry['entity'], entityId: rec.id, summary: sanitizeText(o.summary, 200),
        before: prev ? JSON.parse(JSON.stringify(prev)) : undefined, updatedAt: new Date().toISOString(), deleted: false,
      }
      const actStamped = stampChanges(undefined, act, stamp)
      await db.activity.put(actStamped)
      if (syncing) await db.outbox.put({ key: `activity:${act.id}`, groupId, kind: 'activity', recordId: act.id, stamp })
    }
    return rec
  })
}

export const newBase = () => ({ updatedAt: '', deleted: false })

export async function createGroup(name: string, baseCurrency: string, myName: string): Promise<{ group: Group; me: Member }> {
  const now = new Date().toISOString()
  const group: Group = { id: uuid(), name: sanitizeText(name, 80) || 'Untitled', baseCurrency, archived: false, createdAt: now, ...newBase() }
  const me: Member = { id: uuid(), groupId: group.id, name: sanitizeText(myName, 50) || 'Me', archived: false, ...newBase() }
  await db.local.put({ groupId: group.id, meId: me.id, role: 'owner', status: 'local' })
  await saveRecord('group', group.id, group, { action: 'create', summary: `Created group "${group.name}"` })
  await saveRecord('member', group.id, me, { action: 'member', summary: `${me.name} joined` })
  return { group, me }
}

export async function addMember(groupId: string, name: string): Promise<Member> {
  const m: Member = { id: uuid(), groupId, name: sanitizeText(name, 50) || 'Guest', archived: false, ...newBase() }
  await saveRecord('member', groupId, m, { action: 'member', summary: `Added ${m.name}` })
  return m
}

export async function saveExpense(e: Expense, isNew: boolean) {
  const clean = { ...e, title: sanitizeText(e.title, 120), notes: sanitizeNotes(e.notes) }
  return saveRecord('expense', e.groupId, clean, { action: isNew ? 'create' : 'update', summary: `${isNew ? 'Added' : 'Edited'} "${clean.title}"` })
}
export async function saveSettlement(s: Settlement) {
  return saveRecord('settlement', s.groupId, { ...s, note: sanitizeText(s.note, 120) }, { action: 'settle', summary: 'Recorded a payment' })
}
export async function setDeleted(kind: 'expense' | 'settlement' | 'member', id: string, deleted: boolean, label: string) {
  const rec = (await tableFor(kind).get(id as never)) as (Syncable & { groupId: string }) | undefined
  if (!rec) return
  await saveRecord(kind, rec.groupId, { ...rec, deleted }, { action: deleted ? 'delete' : 'restore', summary: `${deleted ? 'Deleted' : 'Restored'} ${label}` })
}

/** Undo = re-apply the snapshot taken before the change (or soft-delete if it was a create). */
export async function undoActivity(a: ActivityEntry) {
  if (a.entity === 'group' || !a.entityId) return
  const kind = a.entity as Kind
  const cur = (await tableFor(kind).get(a.entityId as never)) as (Syncable & { groupId: string }) | undefined
  if (!cur) return
  const target = a.before ? (a.before as Syncable & { groupId: string }) : { ...cur, deleted: true }
  await saveRecord(kind, cur.groupId, { ...target, id: cur.id }, { action: 'update', summary: `Undid: ${a.summary}` })
}

/** When a local group gets a token (shared for the first time) push everything. */
export async function enqueueAll(groupId: string) {
  const dev = await deviceId()
  const stamp = makeStamp(dev)
  const rows: { key: string; groupId: string; kind: Kind; recordId: string; stamp: string }[] = []
  for (const kind of ['group', 'member', 'expense', 'settlement', 'recurring', 'activity'] as Kind[]) {
    const table = tableFor(kind)
    const all = kind === 'group' ? [await table.get(groupId as never)].filter(Boolean) : await table.where('groupId').equals(groupId).toArray()
    for (const r of all as unknown as { id: string }[]) rows.push({ key: `${kind}:${r.id}`, groupId, kind, recordId: r.id, stamp })
  }
  await db.outbox.bulkPut(rows)
}

export const setLocal = (groupId: string, patch: Partial<GroupLocal>) => db.local.update(groupId, patch)
