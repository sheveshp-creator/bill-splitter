import { dueOccurrences, recurringExpenseId, todayLocal } from '../core/misc'
import type { Expense } from '../core/types'
import { db } from '../db/db'
import { saveRecord } from '../db/repo'

/** Generate any due occurrences. Deterministic ids => two devices doing this never duplicate. */
export async function generateDueRecurring(groupId: string): Promise<number> {
  let n = 0
  const rules = (await db.recurring.where('groupId').equals(groupId).toArray()).filter((r) => !r.deleted)
  for (const rule of rules) {
    const due = dueOccurrences(rule, todayLocal())
    for (const date of due) {
      const id = recurringExpenseId(rule.id, date)
      if (await db.expenses.get(id)) continue
      const e: Expense = { ...rule.template, id, date, recurringId: rule.id, createdAt: new Date().toISOString(), updatedAt: '', deleted: false }
      await saveRecord('expense', groupId, e, { action: 'create', summary: `Recurring: ${e.title} (${date})` })
      n++
    }
    if (due.length) await saveRecord('recurring', groupId, { ...rule, lastGenerated: due[due.length - 1] }, { action: 'update', summary: 'Recurring updated', silent: true })
  }
  return n
}
