/** Shared domain types. All money is INTEGER minor units (paise/cents/fils). */
export type Id = string
export type Money = number

export interface Syncable {
  id: Id
  /** ISO timestamp, set on every local write */
  updatedAt: string
  deleted: boolean
  /** per-field last-modified map, used for field-level last-write-wins */
  fieldTimes?: Record<string, string>
}

export type Role = 'owner' | 'editor' | 'viewer'

export interface Group extends Syncable {
  name: string
  baseCurrency: string
  archived: boolean
  createdAt: string
}

export interface Member extends Syncable {
  groupId: Id
  name: string
  /** archived members keep history but cannot be added to new expenses */
  archived: boolean
  upiId?: string
  /** set when merged into another member; balances already remapped */
  mergedInto?: Id
}

export type Category = 'food' | 'travel' | 'stay' | 'shopping' | 'rent' | 'utilities' | 'fun' | 'other'

/** Basis points: 10000 = 100%. Avoids float percentages. */
export type Bp = number

export interface ItemUnit {
  /** ids of people sharing this single unit */
  sharers: Id[]
}
export interface ReceiptItem {
  id: Id
  name: string
  /** price of ONE unit, minor units (may be negative for discount lines) */
  unitPrice: Money
  qty: number
  /** length === qty, units[i].sharers = who shares unit i */
  units: ItemUnit[]
  /** OCR confidence 0..100, undefined for manual entries */
  confidence?: number
}
export interface Charge {
  type: 'percent' | 'flat'
  /** basis points if percent, minor units if flat */
  value: number
}
export interface ItemizedExtras {
  tax?: Charge
  tip?: Charge
  service?: Charge
  discount?: Charge
  /** true: discount reduces the base on which tax/tip/service are computed */
  discountBeforeTax: boolean
  distribution: 'proportional' | 'equal'
}

export type SplitSpec =
  | { mode: 'equal'; participants: Id[]; adjustments?: Record<Id, Money> }
  | { mode: 'exact'; amounts: Record<Id, Money> }
  | { mode: 'percent'; percents: Record<Id, Bp>; adjustments?: Record<Id, Money> }
  | { mode: 'shares'; shares: Record<Id, number>; adjustments?: Record<Id, Money> }
  | { mode: 'itemized'; items: ReceiptItem[]; extras: ItemizedExtras }

export interface Expense extends Syncable {
  groupId: Id
  title: string
  /** total in `currency` minor units. For itemized this must equal itemizedTotal() */
  amount: Money
  currency: string
  /** rate: 1 unit of `currency` = rate units of group base currency, frozen at entry */
  rate: number
  /** local calendar date YYYY-MM-DD (no timezone shifting) */
  date: string
  payers: Record<Id, Money>
  split: SplitSpec
  category: Category
  notes: string
  photoId?: Id
  recurringId?: Id
  createdAt: string
}

export interface Settlement extends Syncable {
  groupId: Id
  from: Id
  to: Id
  amount: Money
  currency: string
  rate: number
  date: string
  note: string
}

export interface RecurringRule extends Syncable {
  groupId: Id
  template: Omit<Expense, 'id' | 'date' | 'updatedAt' | 'deleted' | 'createdAt' | 'fieldTimes' | 'recurringId'>
  frequency: 'weekly' | 'monthly' | 'yearly'
  interval: number
  startDate: string
  endDate?: string
  lastGenerated?: string
}

export interface ActivityEntry extends Syncable {
  groupId: Id
  at: string
  actor: string
  action: 'create' | 'update' | 'delete' | 'restore' | 'settle' | 'member' | 'group'
  entity: 'expense' | 'settlement' | 'member' | 'group' | 'recurring'
  entityId: Id
  summary: string
  /** snapshot of the record BEFORE the change, enabling undo + audit */
  before?: unknown
}

export type Balances = Record<Id, Money>
export interface Transfer { from: Id; to: Id; amount: Money }
