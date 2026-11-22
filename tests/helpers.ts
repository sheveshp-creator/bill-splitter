import type { Expense, Settlement, SplitSpec } from '../src/core/types'
let n = 0
export function exp(p: Partial<Expense> & { amount: number; payers: Record<string, number>; split: SplitSpec }): Expense {
  return {
    id: `e${++n}`, groupId: 'g', title: 't', currency: 'INR', rate: 1, date: '2025-01-01', category: 'other', notes: '',
    updatedAt: '', deleted: false, createdAt: '', ...p,
  }
}
export function settle(from: string, to: string, amount: number, p: Partial<Settlement> = {}): Settlement {
  return { id: `s${++n}`, groupId: 'g', from, to, amount, currency: 'INR', rate: 1, date: '2025-01-02', note: '', updatedAt: '', deleted: false, ...p }
}
