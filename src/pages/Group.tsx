import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { formatMoney } from '../core/currency'
import { Avatar, Banner } from '../components/ui'
import { useGroupData } from '../components/hooks'
import { db } from '../db/db'
import { generateDueRecurring } from '../lib/recurring'
import { syncGroup, useSyncUi } from '../sync/engine'
import Activity from './group/Activity'
import Balances from './group/Balances'
import Expenses from './group/Expenses'
import People from './group/People'

const TABS = ['Expenses', 'Balances', 'Activity', 'People'] as const
type Tab = (typeof TABS)[number]
const ICONS: Record<Tab, string> = { Expenses: '🧾', Balances: '⚖️', Activity: '🕘', People: '👥' }

export default function GroupPage() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const { data, loading, missing } = useGroupData(id)
  const [tab, setTab] = useState<Tab>('Expenses')
  const sync = useSyncUi()

  useEffect(() => { void generateDueRecurring(id); void syncGroup(id) }, [id])

  if (loading) return <p className="p-6 muted" role="status">Loading…</p>
  if (missing || !data) return <main className="p-6"><p className="mb-3">Group not found on this device.</p><Link to="/" className="btn-ghost">Home</Link></main>

  const { group, local, names } = data
  const status = local?.status ?? 'local'
  const dead = status === 'revoked' || status === 'expired' || status === 'invalid'
  const unseen = data.conflicts.filter((c) => !c.seen)
  const me = local?.meId
  const myBal = me ? data.balances[me] ?? 0 : 0

  const pill = dead ? '⛔ Access ended' : !local?.token ? '📱 This device only' : !sync.online ? '● Offline' : sync.syncing ? '↻ Syncing…' : '✓ Synced'

  return (
    <main className="p-4 pb-32">
      <header className="hero mb-4">
        <div className="flex items-center gap-2 mb-3">
          <Link to="/" aria-label="All groups" className="rounded-full bg-white/20 w-10 h-10 inline-flex items-center justify-center text-lg">←</Link>
          <span className="flex-1 text-sm hero-sub truncate" role="status">{pill} · {data.role}{group.archived ? ' · archived' : ''}</span>
          {me && names[me] && <Avatar id={me} name={names[me]} />}
        </div>
        <h1 className="text-2xl font-extrabold truncate">{group.name}</h1>
        {me ? (
          <div className="mt-3">
            <div className="text-sm hero-sub">{myBal > 0 ? 'You get back' : myBal < 0 ? 'You owe' : "You're all settled up"}</div>
            <div className="text-4xl font-extrabold tracking-tight">{myBal === 0 ? '🎉' : formatMoney(Math.abs(myBal), group.baseCurrency)}</div>
          </div>
        ) : <p className="mt-2 hero-sub text-sm">{data.live.length} people · {data.expenses.filter((e) => !e.deleted).length} expenses</p>}
      </header>

      {dead && <Banner tone="error">{status === 'revoked' ? 'The owner revoked your access link.' : status === 'expired' ? 'Your access link has expired.' : 'Your access link is no longer valid.'} You can still see your local copy, but changes will no longer sync. Ask for a new link to rejoin.</Banner>}
      {group.archived && <Banner tone="warn">This group is archived{data.role === 'owner' ? '. You can unarchive it from the People tab.' : ' and is read-only.'}</Banner>}
      {!local?.token && <Banner>This group is saved only on this device/browser. Turn on sharing in the <button className="underline font-semibold" onClick={() => setTab('People')}>People tab</button> to sync it, and back up regularly.</Banner>}
      {!me && data.canEdit && <Banner tone="warn">Pick which person you are in the <button className="underline font-semibold" onClick={() => setTab('People')}>People tab</button>.</Banner>}
      {unseen.map((c) => (
        <Banner key={c.id} tone="warn" onClose={() => void db.conflicts.update(c.id!, { seen: true })}>
          <b>Edit conflict on “{c.label}”.</b> Someone else changed {c.fields.map((f) => f.field).join(', ')} at the same time. The most recent change was kept
          ({c.fields.map((f) => `${f.field}: ${f.winner === 'mine' ? 'yours' : 'theirs'}`).join(', ')}). Open the activity log to review or undo.
        </Banner>
      ))}
      {data.invalid > 0 && <Banner tone="error">Some data in this group is inconsistent and balances could not be calculated. Check the latest expenses.</Banner>}

      {tab === 'Expenses' && <Expenses data={data} />}
      {tab === 'Balances' && <Balances data={data} />}
      {tab === 'Activity' && <Activity data={data} />}
      {tab === 'People' && <People data={data} />}

      <nav role="tablist" aria-label="Group sections" className="fixed bottom-0 inset-x-0 z-40 bg-white/90 dark:bg-slate-900/90 backdrop-blur border-t border-slate-200 dark:border-slate-800 pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto max-w-xl grid grid-cols-4">
          {TABS.map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => { setTab(t); window.scrollTo({ top: 0 }) }}
              className={`flex flex-col items-center justify-center gap-0.5 min-h-[58px] text-xs font-semibold ${tab === t ? 'text-teal-700 dark:text-teal-300' : 'text-slate-500'}`}>
              <span aria-hidden className="text-xl leading-none">{ICONS[t]}</span>{t}
              {tab === t && <span className="h-1 w-6 rounded-full bg-teal-600 -mb-1" />}
            </button>
          ))}
        </div>
      </nav>

      {data.canEdit && tab !== 'People' && (
        <button onClick={() => nav(`/g/${id}/expense/new`)} aria-label="Add expense"
          className="fixed bottom-24 right-4 btn-primary !rounded-full !min-h-[56px] px-6 text-base shadow-xl">＋ Add expense</button>
      )}
    </main>
  )
}
