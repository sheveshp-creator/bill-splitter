import { useState } from 'react'
import { Link } from 'react-router-dom'
import { formatMoney } from '../../core/currency'
import type { GroupData } from '../../components/hooks'
import { Icon } from '../../components/icons'
import { setDeleted } from '../../db/repo'
import { computeShares } from '../../core/split'
import type { Expense } from '../../core/types'
import { todayLocal } from '../../core/misc'

function myShare(e: Expense, me: string): number | null { try { return computeShares(e.amount, e.split)[me] ?? 0 } catch { return null } }
function dayLabel(d: string) {
  const t = todayLocal(); const y = todayLocal(new Date(Date.now() - 864e5))
  return d === t ? 'Today' : d === y ? 'Yesterday' : new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

export default function Expenses({ data }: { data: GroupData }) {
  const [showDeleted, setShowDeleted] = useState(false)
  const base = data.group.baseCurrency
  const list = data.expenses.filter((e) => showDeleted || !e.deleted).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
  const total = data.expenses.filter((e) => !e.deleted).reduce((s, e) => s + Math.round(e.amount * e.rate * 10 ** (decimalsDiff(e.currency, base))), 0)
  const me = data.local?.meId
  const grouped: [string, typeof list][] = []
  for (const e of list) { const g = grouped[grouped.length - 1]; if (g && g[0] === e.date) g[1].push(e); else grouped.push([e.date, [e]]) }
  const deletedCount = data.expenses.filter((e) => e.deleted).length

  return (
    <section aria-label="Expenses">
      <div className="card mb-4 flex justify-between items-center"><span className="muted">Total spent by the group</span><b className="num text-xl font-medium">{formatMoney(total, base)}</b></div>
      {list.length === 0 && <div className="card text-center py-10 border-dashed"><p className="display text-xl font-semibold">No expenses yet</p><p className="muted mt-1">Tap “Add expense” to log the first one.</p></div>}
      {grouped.map(([date, items]) => (
        <div key={date} className="mb-4">
          <h3 className="label !mb-2 px-1 flex items-center gap-3">{dayLabel(date)}<span className="flex-1 rule-dash" /></h3>
          <ul className="space-y-2">
            {items.map((e) => {
              const mine = me ? myShare(e, me) : null
              return (
                <li key={e.id}>
                  <div className={`card !p-3 flex items-center gap-3 ${e.deleted ? 'opacity-60' : ''}`}>
                    <span className="icon-circle"><Icon name={e.category} size={22} /></span>
                    <Link to={`/g/${data.group.id}/expense/${e.id}`} className="flex-1 min-w-0">
                      <div className={`font-semibold truncate ${e.deleted ? 'line-through' : ''}`}>{e.title}</div>
                      <div className="muted truncate">{Object.keys(e.payers).map((p) => data.names[p] ?? '?').join(', ') || '—'} paid{e.recurringId ? ' · recurring' : ''}</div>
                    </Link>
                    <div className="text-right">
                      <div className="num font-medium">{formatMoney(e.amount, e.currency)}</div>
                      {mine !== null && <div className="muted">your share {formatMoney(mine, e.currency)}</div>}
                    </div>
                    {e.deleted && data.canEdit && <button className="btn-ghost !px-3" onClick={() => void setDeleted('expense', e.id, false, `"${e.title}"`)}>Restore</button>}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
      {deletedCount > 0 && <button className="chip mt-3" aria-pressed={showDeleted} onClick={() => setShowDeleted(!showDeleted)}>{showDeleted ? 'Hide' : 'Show'} {deletedCount} deleted</button>}
    </section>
  )
}
import { decimals } from '../../core/currency'
const decimalsDiff = (from: string, to: string) => decimals(to) - decimals(from)
