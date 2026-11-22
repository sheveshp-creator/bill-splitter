import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo } from 'react'
import { computeBalances, displayNames, simplifyDebts } from '../core/balances'
import { db } from '../db/db'

export function useGroupData(groupId: string) {
  const data = useLiveQuery(async () => {
    const [group, members, expenses, settlements, activity, local, conflicts, recurring] = await Promise.all([
      db.groups.get(groupId),
      db.members.where('groupId').equals(groupId).toArray(),
      db.expenses.where('groupId').equals(groupId).toArray(),
      db.settlements.where('groupId').equals(groupId).toArray(),
      db.activity.where('groupId').equals(groupId).toArray(),
      db.local.get(groupId),
      db.conflicts.where('groupId').equals(groupId).toArray(),
      db.recurring.where('groupId').equals(groupId).toArray(),
    ])
    return { group, members, expenses, settlements, activity, local, conflicts, recurring }
  }, [groupId])

  return useMemo(() => {
    if (!data || !data.group) return { loading: !data, missing: !!data && !data.group, data: null as never }
    const { group, members, expenses, settlements } = data
    const live = members.filter((m) => !m.deleted)
    const names = displayNames([...members].sort((a, b) => a.id.localeCompare(b.id)))
    let balances: Record<string, number> = {}
    let invalid = 0
    try { balances = computeBalances(expenses, settlements, group.baseCurrency, live.map((m) => m.id)) } catch { invalid++ }
    const transfers = simplifyDebts(balances)
    const role = data.local?.role ?? 'viewer'
    const canEdit = role !== 'viewer' && !(group.archived && role !== 'owner') && !['revoked', 'expired', 'invalid'].includes(data.local?.status ?? '')
    return { loading: false, missing: false, data: { ...data, group, live, names, balances, transfers, role, canEdit, invalid } }
  }, [data])
}
export type GroupData = NonNullable<ReturnType<typeof useGroupData>['data']>
