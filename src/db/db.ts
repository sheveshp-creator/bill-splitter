import Dexie, { type Table } from 'dexie'
import type { ActivityEntry, Expense, Group, Member, RecurringRule, Settlement } from '../core/types'
import type { FieldConflict, Kind } from '../sync/merge'

export interface Photo { id: string; groupId: string; blob: Blob; updatedAt: string }
export interface OutboxRow { key: string; groupId: string; kind: Kind; recordId: string; stamp: string
  /** per unsent field: the stamp it had before my first unsent edit (conflict baseline) */
  base?: Record<string, string> }
export type SyncStatus = 'local' | 'ok' | 'revoked' | 'expired' | 'invalid' | 'archived'
export interface GroupLocal {
  groupId: string
  /** which member "I" am on this device */
  meId?: string
  /** plain token for this device's access (absent for purely local groups) */
  token?: string
  role: 'owner' | 'editor' | 'viewer'
  status: SyncStatus
  lastPull?: string
  lastSyncedAt?: string
  /** plain tokens of links this (owner) device created, so they can be re-shown */
  links?: { id: string; token: string; role: 'editor' | 'viewer'; createdAt: string }[]
}
export interface ConflictNotice {
  id?: number; groupId: string; kind: Kind; recordId: string; label: string; at: string; seen: boolean
  fields: FieldConflict[]
}
export interface RateRow { key: string; rate: number; fetchedAt: string }

export class AppDB extends Dexie {
  groups!: Table<Group, string>
  members!: Table<Member, string>
  expenses!: Table<Expense, string>
  settlements!: Table<Settlement, string>
  recurring!: Table<RecurringRule, string>
  activity!: Table<ActivityEntry, string>
  photos!: Table<Photo, string>
  outbox!: Table<OutboxRow, string>
  local!: Table<GroupLocal, string>
  conflicts!: Table<ConflictNotice, number>
  rates!: Table<RateRow, string>
  meta!: Table<{ key: string; value: unknown }, string>

  constructor(name = 'bill-splitter') {
    super(name)
    this.version(1).stores({
      groups: 'id, updatedAt',
      members: 'id, groupId',
      expenses: 'id, groupId, date',
      settlements: 'id, groupId',
      recurring: 'id, groupId',
      activity: 'id, groupId, at',
      photos: 'id, groupId',
      outbox: 'key, groupId',
      local: 'groupId',
      conflicts: '++id, groupId',
      rates: 'key',
      meta: 'key',
    })
  }
}
export let db = new AppDB()
/** test hook */
export const setDb = (d: AppDB) => { db = d }

export const TABLE_OF = {
  group: 'groups', member: 'members', expense: 'expenses', settlement: 'settlements', recurring: 'recurring', activity: 'activity',
} as const
export const tableFor = (k: Kind) => (db as never as Record<string, Table<never, string>>)[TABLE_OF[k]]
