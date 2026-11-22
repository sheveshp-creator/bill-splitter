import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CURRENCY_DECIMALS } from '../core/currency'
import { Banner, Field, useToast } from '../components/ui'
import { db } from '../db/db'
import { createGroup } from '../db/repo'
import { backupDue, exportAll, importBackup, looksEvicted, markHasData } from '../lib/backup'
import { createDemoGroup } from '../lib/demo'
import { dismissInstall, requestPersistence, useInstallHint } from '../lib/pwa'
import { download } from '../lib/share'
import { useSyncUi } from '../sync/engine'

export default function Home() {
  const nav = useNavigate()
  const toast = useToast()
  const groups = useLiveQuery(async () => {
    const [g, l] = [await db.groups.toArray(), await db.local.toArray()]
    return g.filter((x) => !x.deleted).map((x) => ({ ...x, local: l.find((y) => y.groupId === x.id) })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }, [])
  const [evicted, setEvicted] = useState(false)
  const [due, setDue] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [me, setMe] = useState('')
  const [cur, setCur] = useState('INR')
  const [link, setLink] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const install = useInstallHint()
  const sync = useSyncUi()

  useEffect(() => {
    void (async () => {
      await requestPersistence()                                        // first launch: ask the browser not to evict our data
      if (!(await db.meta.get('firstUse'))) await db.meta.put({ key: 'firstUse', value: new Date().toISOString() })
      setEvicted(await looksEvicted()); setDue(await backupDue())
    })()
  }, [groups?.length])

  const restore = async (f?: File) => {
    if (!f) return
    try { const s = await importBackup(JSON.parse(await f.text())); toast(`Restored ${s.groups} group(s)`); setEvicted(false) }
    catch (e) { toast((e as Error).message || 'Could not read that backup') }
  }
  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    const { group } = await createGroup(name, cur, me)
    await markHasData()
    nav(`/g/${group.id}`)
  }
  const openLink = () => {
    const t = link.trim().split('/join/').pop() ?? ''
    if (t) nav(`/join/${t}`)
  }

  return (
    <main className="p-4">
      <header className="hero mb-4">
        <div className="flex items-center justify-between"><span className="text-3xl" aria-hidden>💸</span><span className="text-sm hero-sub" role="status">{!sync.online ? '● Offline' : 'Works offline'}</span></div>
        <h1 className="text-3xl font-extrabold mt-2">Bill Splitter</h1>
        <p className="hero-sub">Split trips, dinners and rent. No sign-up needed.</p>
      </header>

      {install.kind === 'prompt' && <Banner onClose={() => { dismissInstall(); location.reload() }}>Install this app for quick access and offline use. <button className="underline font-semibold" onClick={install.install}>Install</button></Banner>}
      {install.kind === 'ios' && <Banner onClose={() => { dismissInstall(); location.reload() }}>To install on iPhone/iPad: tap <b>Share</b> (the square with an arrow) then <b>Add to Home Screen</b>. Installed apps keep their data longer on iOS.</Banner>}
      {evicted && <Banner tone="error">Your data seems to have been cleared by the browser (this can happen on iOS). Restore from a backup file, or open a group invite link to re-sync it. <button className="underline font-semibold" onClick={() => fileRef.current?.click()}>Restore backup…</button></Banner>}
      {due && !evicted && <Banner tone="warn">It's been a while since your last backup. Your data lives only on this device until a group is shared. <button className="underline font-semibold" onClick={async () => { download(`bill-splitter-backup-${new Date().toISOString().slice(0, 10)}.json`, new Blob([JSON.stringify(await exportAll())], { type: 'application/json' })); setDue(false) }}>Back up now</button></Banner>}

      <ul className="space-y-3 mb-6" aria-label="Your groups">
        {groups?.length === 0 && <li className="card text-center py-8"><div className="text-5xl mb-2" aria-hidden>🧳</div><p className="font-semibold">No groups yet</p><p className="muted">Start one for each trip or event, or explore the demo.</p></li>}
        {groups?.map((g) => (
          <li key={g.id}>
            <Link to={`/g/${g.id}`} className="card flex items-center gap-3 min-h-[68px]">
              <span className="icon-circle !bg-teal-100 dark:!bg-teal-900 font-bold text-teal-800 dark:text-teal-200">{g.name.trim()[0]?.toUpperCase()}</span>
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate">{g.name}</div>
                <div className="muted">{g.local?.token ? `Shared · ${g.local.role}` : 'On this device only'}{g.archived ? ' · archived' : ''}</div>
              </div>
              <span aria-hidden>›</span>
            </Link>
          </li>
        ))}
      </ul>

      {creating ? (
        <form onSubmit={create} className="card mb-4">
          <h2 className="font-bold mb-3">New group</h2>
          <Field label="Group or trip name" htmlFor="gname"><input id="gname" className="input" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Goa trip" autoFocus /></Field>
          <Field label="Your name" htmlFor="myname"><input id="myname" className="input" required maxLength={50} value={me} onChange={(e) => setMe(e.target.value)} placeholder="Amit" /></Field>
          <Field label="Base currency" htmlFor="cur" hint="Balances are shown in this currency.">
            <select id="cur" className="input" value={cur} onChange={(e) => setCur(e.target.value)}>{Object.keys(CURRENCY_DECIMALS).map((c) => <option key={c}>{c}</option>)}</select>
          </Field>
          <div className="flex gap-2"><button className="btn-primary flex-1">Create</button><button type="button" className="btn-ghost" onClick={() => setCreating(false)}>Cancel</button></div>
        </form>
      ) : (
        <button className="btn-primary w-full mb-3 !min-h-[52px] text-base" onClick={() => setCreating(true)}>＋ New group</button>
      )}

      <div className="card space-y-3">
        <div className="flex gap-2">
          <input aria-label="Paste an invite link" className="input" placeholder="Paste an invite link to join" value={link} onChange={(e) => setLink(e.target.value)} />
          <button className="btn-ghost" onClick={openLink} disabled={!link.trim()}>Join</button>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost" onClick={async () => nav(`/g/${await createDemoGroup()}`)}>Try demo group</button>
          <button className="btn-ghost" onClick={() => fileRef.current?.click()}>Restore backup</button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden aria-label="Backup file" onChange={(e) => void restore(e.target.files?.[0])} />
        </div>
      </div>
      <p className="muted mt-4">Your data is stored on this device and works offline. To use it on other devices or with friends, open a group and turn on sharing. Back up regularly.</p>
    </main>
  )
}
