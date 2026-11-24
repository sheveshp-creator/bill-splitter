import { todayLocal } from '../core/misc'
import { itemizedTotal } from '../core/split'
import type { Expense, ItemizedExtras, ReceiptItem, RecurringRule, Settlement } from '../core/types'
import { addMember, createGroup, newBase, saveRecord, uuid } from '../db/repo'

const ago = (n: number) => todayLocal(new Date(Date.now() - n * 864e5))
/** 1st of this month, so the demo shows at most one recurring charge */
const monthStart = () => todayLocal(new Date(new Date().getFullYear(), new Date().getMonth(), 1))

/** Seed a realistic demo group covering every split mode, multi-payer, multi-currency, recurring & a settlement. */
export async function createDemoGroup(): Promise<string> {
  const { group, me } = await createGroup('Beach Trip (demo)', 'USD', 'You')
  const [sam, jordan, kid] = [await addMember(group.id, 'Sam'), await addMember(group.id, 'Jordan'), await addMember(group.id, 'Riley (kid)')]
  const all = [me.id, sam.id, jordan.id, kid.id]
  const base = { groupId: group.id, currency: 'USD', rate: 1, notes: '', createdAt: new Date().toISOString(), ...newBase() }
  const ex = (p: Partial<Expense> & Pick<Expense, 'title' | 'amount' | 'payers' | 'split' | 'date'>): Expense => ({ id: uuid(), category: 'other', ...base, ...p })

  const items: ReceiptItem[] = [
    { id: uuid(), name: 'Fish tacos', unitPrice: 1200, qty: 3, units: [{ sharers: [me.id] }, { sharers: [sam.id] }, { sharers: [jordan.id] }] },
    { id: uuid(), name: 'Craft beer', unitPrice: 600, qty: 2, units: [{ sharers: [me.id] }, { sharers: [sam.id] }] },
    { id: uuid(), name: 'Nachos (shared)', unitPrice: 1800, qty: 1, units: [{ sharers: all }] },
    { id: uuid(), name: 'Kids juice', unitPrice: 300, qty: 1, units: [{ sharers: [kid.id] }], confidence: 52 },
  ]
  const extras: ItemizedExtras = { tax: { type: 'percent', value: 800 }, tip: { type: 'percent', value: 1500 }, discount: { type: 'flat', value: 500 }, discountBeforeTax: true, distribution: 'proportional' }
  const dinner = itemizedTotal(items, extras)
  const list: Expense[] = [
    ex({ title: 'Beach house (2 nights)', category: 'stay', date: ago(6), amount: 120000, payers: { [me.id]: 70000, [sam.id]: 50000 }, split: { mode: 'equal', participants: all } }),
    ex({ title: 'Airport taxi', category: 'travel', date: ago(6), amount: 9000, payers: { [jordan.id]: 9000 }, split: { mode: 'exact', amounts: { [me.id]: 3000, [sam.id]: 3000, [jordan.id]: 3000 } } }),
    ex({ title: 'Seafood dinner', category: 'food', date: ago(5), amount: dinner, payers: { [sam.id]: dinner }, split: { mode: 'itemized', items, extras } }),
    ex({ title: 'Groceries', category: 'shopping', date: ago(5), amount: 12805, payers: { [me.id]: 12805 }, split: { mode: 'shares', shares: { [me.id]: 1, [sam.id]: 1, [jordan.id]: 1, [kid.id]: 0.5 } } }),
    ex({ title: 'Scooter rental', category: 'travel', date: ago(4), amount: 6000, payers: { [jordan.id]: 6000 }, split: { mode: 'percent', percents: { [me.id]: 5000, [sam.id]: 3000, [jordan.id]: 2000 } } }),
    ex({ title: 'Parasailing', category: 'fun', date: ago(4), amount: 15000, payers: { [me.id]: 15000 }, split: { mode: 'equal', participants: [me.id, sam.id, jordan.id], adjustments: { [sam.id]: 1000, [jordan.id]: -1000 } } }),
    ex({ title: 'Souvenirs (EUR)', category: 'shopping', date: ago(3), currency: 'EUR', rate: 1.08, amount: 4500, payers: { [jordan.id]: 4500 }, split: { mode: 'equal', participants: all } }),
    ex({ title: 'Ferry refund (credit note)', category: 'travel', date: ago(2), amount: -3500, payers: { [me.id]: -3500 }, split: { mode: 'equal', participants: [me.id, sam.id, jordan.id] } }),
  ]
  for (const e of list) await saveRecord('expense', group.id, e, { action: 'create', summary: `Added "${e.title}"`, silent: true })
  const s: Settlement = { id: uuid(), groupId: group.id, from: sam.id, to: me.id, amount: 20000, currency: 'USD', rate: 1, date: ago(1), note: 'Part payment', ...newBase() }
  await saveRecord('settlement', group.id, s, { action: 'settle', summary: 'Recorded a payment', silent: true })
  const rule: RecurringRule = {
    id: uuid(), groupId: group.id, frequency: 'monthly', interval: 1, startDate: monthStart(), ...newBase(),
    template: { groupId: group.id, title: 'Streaming plan (shared)', amount: 1599, currency: 'USD', rate: 1, payers: { [me.id]: 1599 }, split: { mode: 'equal', participants: [me.id, sam.id, jordan.id] }, category: 'utilities', notes: '' },
  }
  await saveRecord('recurring', group.id, rule, { action: 'create', summary: 'Recurring: streaming plan', silent: true })
  return group.id
}
