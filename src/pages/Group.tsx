import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { formatMoney } from '../core/currency'
import { Avatar, Banner } from '../components/ui'
import { Icon } from '../components/icons'
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
const ICONS: Record<Tab, string> = { Expenses: 'expenses', Balances: 'balances', Activity: 'activity', People: 'people' }

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

  const pill = dead ? { icon: 'ban', text: 'Access ended' } : !local?.token ? { icon: 'phone', text: 'This device only' } : !sync.online ? { icon: 'cloud', text: 'Offline, will sync later' } : sync.syncing ? { icon: 'repeat', text: 'Syncing' } : { icon: 'check', text: 'Synced' }
  const live = data.expenses.filter((e) => !e.deleted)

  return (
    <main className="p-4 pb-32">
      <header className="ticket">
        <div className="flex items-center gap-3 mb-4">
          <Link to="/" aria-label="All groups" className="inline-flex items-center justify-center w-9 h-9 rounded border border-on-ink/40"><Icon name="back" size={18} /></Link>
          <span className="flex-1 text-xs uppercase tracking-widest t-sub truncate inline-flex items-center gap-1.5" role="status"><Icon name={pill.icon} size={14} />{pill.text} · {data.role}{group.archived ? ' · archived' : ''}</span>
          {me && names[me] && <Avatar id={me} name={names[me]} size={32} />}
        </div>
        <h1 className="text-3xl font-extrabold leading-tight truncate">{group.name}</h1>
        <div className="perf" />
        {me ? (
          <div className="flex items-end justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-widest t-sub">{myBal > 0 ? 'You are owed' : myBal < 0 ? 'You owe' : 'Your balance'}</div>
              <div className="num text-4xl font-medium mt-1" style={myBal !== 0 ? { color: 'rgb(var(--mark))' } : undefined}>{myBal === 0 ? 'Settled' : formatMoney(Math.abs(myBal), group.baseCurrency)}</div>
            </div>
            <div className="text-right text-xs t-sub num leading-5">{data.live.length} people<br />{live.length} expenses</div>
          </div>
        ) : <p className="t-sub text-sm num">{data.live.length} people · {live.length} expenses</p>}
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

      <nav role="tablist" aria-label="Group sections" className="fixed bottom-0 inset-x-0 z-40 bg-card border-t-2 border-ink pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto max-w-xl grid grid-cols-4">
          {TABS.map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => { setTab(t); window.scrollTo({ top: 0 }) }}
              className={`relative flex flex-col items-center justify-center gap-1 min-h-[60px] text-[11px] uppercase tracking-wider font-semibold ${tab === t ? 'text-ink bg-mark/50' : 'text-muted'}`}>
              <Icon name={ICONS[t]} size={20} strokeWidth={tab === t ? 2.2 : 1.75} />{t}
            </button>
          ))}
        </div>
      </nav>

      {data.canEdit && tab !== 'People' && (
        <button onClick={() => nav(`/g/${id}/expense/new`)} aria-label="Add expense"
          className="fixed bottom-20 right-4 btn-primary !min-h-[52px] px-5 text-base"><Icon name="plus" size={20} strokeWidth={2.4} />Add expense</button>
      )}
    </main>
  )
}
