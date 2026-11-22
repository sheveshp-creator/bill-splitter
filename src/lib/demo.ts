import { todayLocal } from '../core/misc'
import { itemizedTotal } from '../core/split'
import type { Expense, ItemizedExtras, ReceiptItem, RecurringRule, Settlement } from '../core/types'
import { db } from '../db/db'
import { addMember, createGroup, newBase, saveRecord, uuid } from '../db/repo'

const ago = (n: number) => todayLocal(new Date(Date.now() - n * 864e5))
/** 1st of this month, so the demo shows at most one recurring charge */
const monthStart = () => todayLocal(new Date(new Date().getFullYear(), new Date().getMonth(), 1))

/** Seed a realistic demo group covering every split mode, multi-payer, multi-currency, recurring & a settlement. */
export async function createDemoGroup(): Promise<string> {
  const { group, me } = await createGroup('Goa Trip (demo)', 'INR', 'You')
  const [rahul, priya, kid] = [await addMember(group.id, 'Rahul'), await addMember(group.id, 'Priya'), await addMember(group.id, 'Aarav (kid)')]
  const all = [me.id, rahul.id, priya.id, kid.id]
  await db.members.update(rahul.id, { upiId: 'rahul@okhdfcbank' })
  const base = { groupId: group.id, currency: 'INR', rate: 1, notes: '', createdAt: new Date().toISOString(), ...newBase() }
  const ex = (p: Partial<Expense> & Pick<Expense, 'title' | 'amount' | 'payers' | 'split' | 'date'>): Expense => ({ id: uuid(), category: 'other', ...base, ...p })

  const items: ReceiptItem[] = [
    { id: uuid(), name: 'Fish thali', unitPrice: 45000, qty: 3, units: [{ sharers: [me.id] }, { sharers: [rahul.id] }, { sharers: [priya.id] }] },
    { id: uuid(), name: 'Kingfisher', unitPrice: 30000, qty: 2, units: [{ sharers: [me.id] }, { sharers: [rahul.id] }] },
    { id: uuid(), name: 'Starters (shared)', unitPrice: 60000, qty: 1, units: [{ sharers: [me.id, rahul.id, priya.id, kid.id] }] },
    { id: uuid(), name: 'Kids juice', unitPrice: 8000, qty: 1, units: [{ sharers: [kid.id] }], confidence: 52 },
  ]
  const extras: ItemizedExtras = { tax: { type: 'percent', value: 500 }, service: { type: 'percent', value: 1000 }, discount: { type: 'flat', value: 5000 }, discountBeforeTax: true, distribution: 'proportional' }
  const list: Expense[] = [
    ex({ title: 'Villa (2 nights)', category: 'stay', date: ago(6), amount: 2400000, payers: { [me.id]: 1400000, [rahul.id]: 1000000 }, split: { mode: 'equal', participants: all } }),
    ex({ title: 'Cab from airport', category: 'travel', date: ago(6), amount: 180000, payers: { [priya.id]: 180000 }, split: { mode: 'exact', amounts: { [me.id]: 60000, [rahul.id]: 60000, [priya.id]: 60000 } } }),
    ex({ title: 'Beach shack dinner', category: 'food', date: ago(5), amount: itemizedTotal(items, extras), payers: { [rahul.id]: itemizedTotal(items, extras) }, split: { mode: 'itemized', items, extras } }),
    ex({ title: 'Groceries', category: 'shopping', date: ago(5), amount: 320050, payers: { [me.id]: 320050 }, split: { mode: 'shares', shares: { [me.id]: 1, [rahul.id]: 1, [priya.id]: 1, [kid.id]: 0.5 } } }),
    ex({ title: 'Scooter rental', category: 'travel', date: ago(4), amount: 150000, payers: { [priya.id]: 150000 }, split: { mode: 'percent', percents: { [me.id]: 5000, [rahul.id]: 3000, [priya.id]: 2000 } } }),
    ex({ title: 'Parasailing', category: 'fun', date: ago(4), amount: 400000, payers: { [me.id]: 400000 }, split: { mode: 'equal', participants: [me.id, rahul.id, priya.id], adjustments: { [rahul.id]: 20000, [priya.id]: -20000 } } }),
    ex({ title: 'Souvenirs (USD)', category: 'shopping', date: ago(3), currency: 'USD', rate: 83.25, amount: 6000, payers: { [priya.id]: 6000 }, split: { mode: 'equal', participants: all } }),
    ex({ title: 'Airport refund (credit note)', category: 'travel', date: ago(2), amount: -90000, payers: { [me.id]: -90000 }, split: { mode: 'equal', participants: [me.id, rahul.id, priya.id] } }),
  ]
  for (const e of list) await saveRecord('expense', group.id, e, { action: 'create', summary: `Added "${e.title}"`, silent: true })
  const s: Settlement = { id: uuid(), groupId: group.id, from: rahul.id, to: me.id, amount: 500000, currency: 'INR', rate: 1, date: ago(1), note: 'Part payment', ...newBase() }
  await saveRecord('settlement', group.id, s, { action: 'settle', summary: 'Recorded a payment', silent: true })
  const rule: RecurringRule = {
    id: uuid(), groupId: group.id, frequency: 'monthly', interval: 1, startDate: monthStart(), ...newBase(),
    template: { groupId: group.id, title: 'Netflix (shared)', amount: 64900, currency: 'INR', rate: 1, payers: { [me.id]: 64900 }, split: { mode: 'equal', participants: [me.id, rahul.id, priya.id] }, category: 'utilities', notes: '' },
  }
  await saveRecord('recurring', group.id, rule, { action: 'create', summary: 'Recurring: Netflix', silent: true })
  return group.id
}
