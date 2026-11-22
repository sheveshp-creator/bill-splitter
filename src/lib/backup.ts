import type { ActivityEntry, Expense, Group, Member, RecurringRule, Settlement, Syncable } from '../core/types'
import { db, tableFor, type GroupLocal } from '../db/db'
import { enqueueAll } from '../db/repo'
import { mergeRecord, type Kind } from '../sync/merge'

export const BACKUP_VERSION = 1
export interface BackupFile {
  app: 'bill-splitter'; version: number; exportedAt: string
  groups: Group[]; members: Member[]; expenses: Expense[]; settlements: Settlement[]; recurring: RecurringRule[]; activity: ActivityEntry[]
  local: GroupLocal[]
  photos: { id: string; groupId: string; dataUrl: string; updatedAt: string }[]
}

const blobToDataUrl = (b: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = rej; r.readAsDataURL(b) })
const dataUrlToBlob = async (u: string) => (await fetch(u)).blob()

export async function exportAll(): Promise<BackupFile> {
  const photos = await db.photos.toArray()
  const f: BackupFile = {
    app: 'bill-splitter', version: BACKUP_VERSION, exportedAt: new Date().toISOString(),
    groups: await db.groups.toArray(), members: await db.members.toArray(), expenses: await db.expenses.toArray(),
    settlements: await db.settlements.toArray(), recurring: await db.recurring.toArray(), activity: await db.activity.toArray(),
    local: await db.local.toArray(),
    photos: await Promise.all(photos.map(async (p) => ({ id: p.id, groupId: p.groupId, dataUrl: await blobToDataUrl(p.blob), updatedAt: p.updatedAt }))),
  }
  await db.meta.put({ key: 'lastBackup', value: f.exportedAt })
  try { localStorage.setItem('bs_last_backup', f.exportedAt) } catch { /* private mode */ }
  return f
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const KINDS: [keyof BackupFile, Kind][] = [['groups', 'group'], ['members', 'member'], ['expenses', 'expense'], ['settlements', 'settlement'], ['recurring', 'recurring'], ['activity', 'activity']]

/** Throws a readable Error for anything that is not a well-formed backup. Never trusts shape. */
export function validateBackup(x: unknown): BackupFile {
  if (!isObj(x) || x.app !== 'bill-splitter') throw new Error('This is not a Bill Splitter backup file.')
  if (typeof x.version !== 'number' || x.version > BACKUP_VERSION) throw new Error('This backup was made by a newer version of the app.')
  for (const [key] of KINDS) {
    const arr = x[key]
    if (!Array.isArray(arr)) throw new Error(`Backup is missing "${key}".`)
    for (const r of arr) if (!isObj(r) || typeof r.id !== 'string' || (key !== 'groups' && typeof r.groupId !== 'string')) throw new Error(`Backup contains a malformed record in "${key}".`)
  }
  if (!Array.isArray(x.local) || !Array.isArray(x.photos)) throw new Error('Backup is incomplete.')
  return x as unknown as BackupFile
}

export interface ImportSummary { groups: number; added: number; updated: number }
/** Restore is a MERGE (per-field LWW), so restoring an old backup never clobbers newer data. */
export async function importBackup(raw: unknown): Promise<ImportSummary> {
  const f = validateBackup(raw)
  let added = 0, updated = 0
  for (const [key, kind] of KINDS) {
    const table = tableFor(kind)
    for (const rec of f[key] as unknown as Syncable[]) {
      const local = (await table.get(rec.id as never)) as Syncable | undefined
      const { merged, changed } = mergeRecord(local, rec)
      if (changed) { await table.put(merged as never); local ? updated++ : added++ }
    }
  }
  for (const l of f.local) {
    const ex = await db.local.get(l.groupId)
    if (!ex) await db.local.put(l)
  }
  for (const p of f.photos) if (!(await db.photos.get(p.id))) await db.photos.put({ id: p.id, groupId: p.groupId, blob: await dataUrlToBlob(p.dataUrl), updatedAt: p.updatedAt })
  for (const l of await db.local.toArray()) if (l.token) await enqueueAll(l.groupId)   // re-push anything the server may have lost
  return { groups: f.groups.length, added, updated }
}

export const BACKUP_REMINDER_DAYS = 14
export async function backupDue(now = Date.now()): Promise<boolean> {
  if ((await db.groups.count()) === 0) return false
  let last = ((await db.meta.get('lastBackup'))?.value as string | undefined)
  try { last = last ?? localStorage.getItem('bs_last_backup') ?? undefined } catch { /* */ }
  if (!last) {
    const first = (await db.meta.get('firstUse'))?.value as string | undefined
    return first ? now - Date.parse(first) > BACKUP_REMINDER_DAYS * 864e5 : false
  }
  return now - Date.parse(last) > BACKUP_REMINDER_DAYS * 864e5
}

/** Storage was wiped (iOS eviction): we remember that data existed. */
export async function markHasData() { try { localStorage.setItem('bs_had_data', '1') } catch { /* */ } await db.meta.put({ key: 'hadData', value: true }) }
export async function looksEvicted(): Promise<boolean> {
  if ((await db.groups.count()) > 0) return false
  let flag = !!(await db.meta.get('hadData'))
  try { flag = flag || localStorage.getItem('bs_had_data') === '1' } catch { /* */ }
  return flag
}
