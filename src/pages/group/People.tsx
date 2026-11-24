import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { canRemoveMember, isSelfSettlement, remapMemberInExpense, remapMemberInSettlement } from '../../core/balances'
import { formatMoney, parseAmount } from '../../core/currency'
import { isValidVpa, sanitizeText, todayLocal } from '../../core/misc'
import { includeMemberInSpec } from '../../core/split'
import type { Member, RecurringRule } from '../../core/types'
import type { GroupData } from '../../components/hooks'
import QR from '../../components/QR'
import { Avatar, Banner, Field, Modal, copy, useToast } from '../../components/ui'
import { db } from '../../db/db'
import { addMember, newBase, saveExpense, saveRecord, setDeleted, uuid } from '../../db/repo'
import { exportAll, importBackup } from '../../lib/backup'
import { download, shareText } from '../../lib/share'
import { createInvite, enableSharing, inviteUrl, regenerateInvite, revokeInvite, syncGroup } from '../../sync/engine'
import { isConfigured, remote } from '../../sync/remote'

export default function People({ data }: { data: GroupData }) {
  return (
    <div className="space-y-4">
      <Sharing data={data} />
      <Members data={data} />
      <Recurring data={data} />
      <DataSection data={data} />
    </div>
  )
}

/* ------------------------------------------------------------------ sharing */
function Sharing({ data }: { data: GroupData }) {
  const toast = useToast()
  const { group, local } = data
  const [role, setRole] = useState<'viewer' | 'editor' | 'owner'>('editor')
  const [hours, setHours] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [qr, setQr] = useState<string | null>(null)
  const isOwner = local?.role === 'owner' && !!local.token

  // prune links that were revoked elsewhere
  useEffect(() => {
    if (!isOwner || !local?.token) return
    void remote.listLinks(local.token).then(async (ls) => {
      const live = new Set(ls.filter((l) => !l.revokedAt).map((l) => l.id))
      const kept = (local.links ?? []).filter((l) => live.has(l.id))
      if (kept.length !== (local.links ?? []).length) await db.local.update(group.id, { links: kept })
    }).catch(() => {})
  }, [isOwner, local?.token, group.id])   // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (f: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    try { await f(); if (ok) toast(ok) } catch (e) { toast(errMsg((e as { code?: string }).code)) } finally { setBusy(false) }
  }

  return (
    <section className="card" aria-label="Sharing">
      <h2 className="font-bold mb-2">Share this group</h2>
      {!isConfigured() && <Banner tone="warn">Sync isn't configured on this deployment (missing Supabase keys). The app still works fully on this device.</Banner>}
      {!local?.token ? (
        <>
          <p className="muted mb-3">Right now this group exists only on this device. Turn on sharing to get an invite link and QR code. Friends open it, pick their name and everyone stays in sync, with no accounts.</p>
          <button className="btn-primary w-full" disabled={busy || !isConfigured()} onClick={() => void run(() => enableSharing(group.id), 'Sharing is on')}>Turn on sharing</button>
        </>
      ) : isOwner ? (
        <>
          <div className="flex flex-wrap gap-2 mb-3">
            <select aria-label="Link access level" className="input !w-auto" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
              <option value="viewer">Viewer (read-only)</option><option value="editor">Editor</option><option value="owner">Owner</option></select>
            <select aria-label="Link expiry" className="input !w-auto" value={hours} onChange={(e) => setHours(e.target.value)}>
              <option value="">Never expires</option><option value="24">Expires in 24 h</option><option value="168">Expires in 7 days</option></select>
            <button className="btn-primary" disabled={busy} onClick={() => void run(() => createInvite(group.id, role, hours ? Number(hours) : null), 'Link created')}>New link</button>
          </div>
          <ul className="space-y-3">
            {(local.links ?? []).length === 0 && <li className="muted">No active links yet.</li>}
            {(local.links ?? []).map((l) => {
              const url = inviteUrl(l.token)
              return (
                <li key={l.id} className="rounded-xl border border-slate-200 dark:border-slate-800 p-3">
                  <div className="flex justify-between mb-1"><b className="capitalize">{l.role} link</b><span className="muted">{new Date(l.createdAt).toLocaleDateString()}</span></div>
                  <input readOnly aria-label={`${l.role} link`} className="input !text-xs mb-2" value={url} onFocus={(e) => e.currentTarget.select()} />
                  <div className="flex flex-wrap gap-2">
                    <button className="btn-ghost !min-h-[40px]" onClick={async () => toast((await shareText(`Join "${group.name}" on Bill Splitter: ${url}`)) === 'copied' ? 'Link copied' : 'Shared')}>Share</button>
                    <button className="btn-ghost !min-h-[40px]" onClick={async () => { await copy(url); toast('Copied') }}>Copy</button>
                    <button className="btn-ghost !min-h-[40px]" onClick={() => setQr(url)}>QR</button>
                    <button className="btn-ghost !min-h-[40px]" disabled={busy} onClick={() => void run(() => regenerateInvite(group.id, l.id, l.role), 'New link generated, the old one stopped working')}>Regenerate</button>
                    <button className="btn-danger !min-h-[40px]" disabled={busy} onClick={() => void run(() => revokeInvite(group.id, l.id), 'Link revoked')}>Revoke</button>
                  </div>
                </li>
              )
            })}
          </ul>
          <p className="muted mt-3">Anyone with a link can join with that access level. Revoking cuts access immediately, even for people already inside.</p>
        </>
      ) : <p className="muted">You joined with <b>{local.role}</b> access. Only the owner can manage links.</p>}
      {local?.token && <button className="btn-ghost w-full mt-3" onClick={() => void syncGroup(group.id)}>Sync now{local.lastSyncedAt ? ` (last: ${new Date(local.lastSyncedAt).toLocaleTimeString()})` : ''}</button>}
      {qr && <Modal title="Scan to join" onClose={() => setQr(null)}><QR text={qr} label="Invite QR code" /><p className="muted text-center mt-2">Point a phone camera here to open the group.</p></Modal>}
    </section>
  )
}
const errMsg = (c?: string) => ({ offline: "You're offline.", forbidden: 'Only the owner can do that.', rate_limited: 'Too many requests, wait a minute.', not_configured: 'Sync is not configured.' } as Record<string, string>)[c ?? ''] ?? 'Something went wrong. Try again.'

/* ------------------------------------------------------------------ members */
function Members({ data }: { data: GroupData }) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [added, setAdded] = useState<Member | null>(null)
  const [removing, setRemoving] = useState<Member | null>(null)
  const [merging, setMerging] = useState<Member | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [upi, setUpi] = useState('')
  const me = data.local?.meId
  const list = data.members.filter((m) => !m.deleted)

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    const m = await addMember(data.group.id, name); setName('')
    if (data.expenses.some((x) => !x.deleted)) setAdded(m)
  }
  const patchMember = (m: Member, p: Partial<Member>, summary: string) => saveRecord('member', m.groupId, { ...m, ...p }, { action: 'member', summary })

  return (
    <section className="card" aria-label="Members">
      <h2 className="font-bold mb-2">People</h2>
      <ul className="space-y-3">
        {list.map((m) => (
          <li key={m.id} className="border-t first:border-0 border-slate-200 dark:border-slate-800 pt-3 first:pt-0">
            <div className="flex items-center gap-3">
              <Avatar id={m.id} name={data.names[m.id]} />
              {editing === m.id ? (
                <form className="flex-1 space-y-2" onSubmit={async (e) => { e.preventDefault()
                  if (upi.trim() && !isValidVpa(upi.trim())) return toast('That UPI ID looks wrong (e.g. name@bank)')
                  await patchMember(m, { name: sanitizeText(draft, 50) || m.name, upiId: upi.trim() || undefined }, `Renamed ${m.name} to ${draft}`); setEditing(null) }}>
                  <input aria-label="Name" className="input" value={draft} maxLength={50} onChange={(e) => setDraft(e.target.value)} />
                  {data.group.baseCurrency === 'INR' && <input aria-label="UPI ID" className="input" placeholder="UPI ID (optional, India)" value={upi} onChange={(e) => setUpi(e.target.value)} />}
                  <div className="flex gap-2"><button className="btn-primary !min-h-[40px]">Save</button><button type="button" className="btn-ghost !min-h-[40px]" onClick={() => setEditing(null)}>Cancel</button></div>
                </form>
              ) : (
                <div className="flex-1 min-w-0"><div className="font-medium truncate">{data.names[m.id]}{m.id === me && ' (you)'}{m.archived && ' · archived'}</div>
                  {m.upiId && <div className="muted truncate">{m.upiId}</div>}</div>
              )}
            </div>
            {editing !== m.id && data.canEdit && (
              <div className="flex flex-wrap gap-2 mt-2 ml-12">
                {m.id !== me && data.local && <button className="chip" onClick={() => void db.local.update(data.group.id, { meId: m.id })}>This is me</button>}
                <button className="chip" onClick={() => { setEditing(m.id); setDraft(m.name); setUpi(m.upiId ?? '') }}>Edit</button>
                <button className="chip" onClick={() => void patchMember(m, { archived: !m.archived }, `${m.archived ? 'Unarchived' : 'Archived'} ${m.name}`)}>{m.archived ? 'Unarchive' : 'Archive'}</button>
                <button className="chip" onClick={() => setMerging(m)}>Merge…</button>
                <button className="chip" onClick={() => setRemoving(m)}>Remove</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {data.canEdit && (
        <form onSubmit={add} className="flex gap-2 mt-4">
          <input aria-label="New person's name" className="input" required maxLength={50} placeholder="Add a person by name" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn-primary">Add</button>
        </form>
      )}

      {added && (
        <Modal title={`Add ${added.name} to past expenses?`} onClose={() => setAdded(null)}>
          <p className="mb-3">Equal and share-based expenses can include {added.name} retroactively, which re-splits them. Otherwise {added.name} only joins future expenses.</p>
          <div className="flex gap-2"><button className="btn-ghost flex-1" onClick={() => setAdded(null)}>Only new ones</button>
            <button className="btn-primary flex-1" onClick={async () => {
              let n = 0
              for (const e of data.expenses) if (!e.deleted) { const s = includeMemberInSpec(e.split, added.id); if (s !== e.split) { await saveExpense({ ...e, split: s }, false); n++ } }
              toast(`Updated ${n} expense(s)`); setAdded(null)
            }}>Include in past ones</button></div>
        </Modal>
      )}

      {removing && (() => {
        const chk = canRemoveMember(data.balances, removing.id)
        return (
          <Modal title={`Remove ${removing.name}?`} onClose={() => setRemoving(null)}>
            {!chk.ok ? (<>
              <Banner tone="error">{removing.name} {chk.balance > 0 ? 'is owed' : 'owes'} {formatMoney(Math.abs(chk.balance), data.group.baseCurrency)}. Settle up first, or archive them: they stay in the history and balances but can't be added to new expenses.</Banner>
              <button className="btn-primary w-full" onClick={async () => { await patchMember(removing, { archived: true }, `Archived ${removing.name}`); setRemoving(null) }}>Archive instead</button></>
            ) : (<>
              <p className="mb-3">{removing.name} is fully settled. They'll be hidden, and past expenses will still show their name.</p>
              <div className="flex gap-2"><button className="btn-ghost flex-1" onClick={() => setRemoving(null)}>Cancel</button>
                <button className="btn-danger flex-1" onClick={async () => { await setDeleted('member', removing.id, true, removing.name); setRemoving(null) }}>Remove</button></div></>)}
          </Modal>
        )
      })()}

      {merging && <MergeSheet data={data} from={merging} onClose={() => setMerging(null)} />}
    </section>
  )
}

function MergeSheet({ data, from, onClose }: { data: GroupData; from: Member; onClose: () => void }) {
  const toast = useToast()
  const targets = data.members.filter((m) => !m.deleted && m.id !== from.id)
  const [into, setInto] = useState(targets[0]?.id ?? '')
  const go = async () => {
    for (const e of data.expenses) {
      if (JSON.stringify(e).includes(from.id)) await saveRecord('expense', e.groupId, remapMemberInExpense(e, from.id, into), { action: 'update', summary: `Merged ${from.name} in "${e.title}"`, silent: true })
    }
    for (const s of data.settlements) {
      if (s.from !== from.id && s.to !== from.id) continue
      const r = remapMemberInSettlement(s, from.id, into)
      await saveRecord('settlement', s.groupId, isSelfSettlement(r) ? { ...r, deleted: true } : r, { action: 'update', summary: 'Merged payment', silent: true })
    }
    await saveRecord('member', from.groupId, { ...from, deleted: true, archived: true, mergedInto: into }, { action: 'member', summary: `Merged ${from.name} into ${data.names[into]}` })
    if (data.local?.meId === from.id) await db.local.update(from.groupId, { meId: into })
    toast('Merged'); onClose()
  }
  return (
    <Modal title={`Merge ${from.name}`} onClose={onClose}>
      <p className="mb-3">All of {from.name}'s expenses, shares and payments move to the person you pick. Their balances add together. This is useful when a guest later signs up under their own name.</p>
      <Field label="Merge into" htmlFor="mi"><select id="mi" className="input" value={into} onChange={(e) => setInto(e.target.value)}>{targets.map((m) => <option key={m.id} value={m.id}>{data.names[m.id]}</option>)}</select></Field>
      <button className="btn-primary w-full" disabled={!into} onClick={() => void go()}>Merge</button>
    </Modal>
  )
}

/* ---------------------------------------------------------------- recurring */
function Recurring({ data }: { data: GroupData }) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState(''); const [amt, setAmt] = useState(''); const [payer, setPayer] = useState(data.local?.meId ?? data.live[0]?.id ?? '')
  const [freq, setFreq] = useState<RecurringRule['frequency']>('monthly'); const [start, setStart] = useState(todayLocal())
  const cur = data.group.baseCurrency
  const minor = parseAmount(amt, cur)
  const rules = data.recurring.filter((r) => !r.deleted)
  const save = async () => {
    if (minor === null || !title.trim() || !payer) return
    const rule: RecurringRule = {
      id: uuid(), groupId: data.group.id, frequency: freq, interval: 1, startDate: start, ...newBase(),
      template: { groupId: data.group.id, title: sanitizeText(title, 120), amount: minor, currency: cur, rate: 1, payers: { [payer]: minor }, split: { mode: 'equal', participants: data.live.filter((m) => !m.archived).map((m) => m.id) }, category: 'rent', notes: '' },
    }
    await saveRecord('recurring', data.group.id, rule, { action: 'create', summary: `Recurring: ${rule.template.title}` })
    setOpen(false); setTitle(''); setAmt(''); toast('Saved. Expenses are created automatically when due.')
  }
  return (
    <section className="card" aria-label="Recurring expenses">
      <div className="flex items-center justify-between mb-2"><h2 className="font-bold">Recurring</h2>{data.canEdit && <button className="chip" onClick={() => setOpen(!open)}>{open ? 'Close' : '+ Add'}</button>}</div>
      {rules.length === 0 && !open && <p className="muted">Rent, subscriptions and other repeating costs are added automatically.</p>}
      <ul className="space-y-2">{rules.map((r) => (
        <li key={r.id} className="flex items-center gap-2"><span className="flex-1">{r.template.title} <span className="muted">· {formatMoney(r.template.amount, r.template.currency)} {r.frequency}</span></span>
          {data.canEdit && <button className="btn-ghost !px-3 !min-h-[36px]" aria-label={`Stop ${r.template.title}`} onClick={() => void saveRecord('recurring', r.groupId, { ...r, deleted: true }, { action: 'delete', summary: `Stopped recurring ${r.template.title}` })}>Stop</button>}</li>))}</ul>
      {open && (
        <div className="mt-3">
          <Field label="Title" htmlFor="rt"><input id="rt" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Flat rent" /></Field>
          <div className="flex gap-2"><div className="flex-1"><Field label={`Amount (${cur})`} htmlFor="ra"><input id="ra" inputMode="decimal" className="input" value={amt} onChange={(e) => setAmt(e.target.value)} /></Field></div>
            <div className="flex-1"><Field label="Every" htmlFor="rf"><select id="rf" className="input" value={freq} onChange={(e) => setFreq(e.target.value as typeof freq)}><option value="weekly">week</option><option value="monthly">month</option><option value="yearly">year</option></select></Field></div></div>
          <div className="flex gap-2"><div className="flex-1"><Field label="Paid by" htmlFor="rp"><select id="rp" className="input" value={payer} onChange={(e) => setPayer(e.target.value)}>{data.live.map((m) => <option key={m.id} value={m.id}>{data.names[m.id]}</option>)}</select></Field></div>
            <div className="flex-1"><Field label="Starting" htmlFor="rs"><input id="rs" type="date" className="input" value={start} onChange={(e) => setStart(e.target.value)} /></Field></div></div>
          <p className="muted mb-2">Split equally between everyone currently active.</p>
          <button className="btn-primary w-full" disabled={minor === null || !title.trim()} onClick={() => void save()}>Save recurring expense</button>
        </div>
      )}
    </section>
  )
}

/* --------------------------------------------------------------------- data */
function DataSection({ data }: { data: GroupData }) {
  const toast = useToast(); const nav = useNavigate()
  const fileRef = useRef<HTMLInputElement>(null)
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => { void navigator.storage?.persisted?.().then(setPersisted) }, [])
  const { group, local } = data
  return (
    <section className="card space-y-3" aria-label="Data and backup">
      <h2 className="font-bold">Data &amp; backup</h2>
      <p className="muted">{persisted === false ? '⚠ Your browser may clear this data if storage runs low (common on iPhone). Install the app to the Home Screen, share the group, and keep backups.' : persisted ? '✓ Storage is marked persistent.' : 'Data lives in this browser on this device.'}</p>
      <div className="flex flex-wrap gap-2">
        <button className="btn-ghost" onClick={async () => download(`bill-splitter-backup-${todayLocal()}.json`, new Blob([JSON.stringify(await exportAll())], { type: 'application/json' }))}>Back up everything</button>
        <button className="btn-ghost" onClick={() => fileRef.current?.click()}>Restore backup</button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden aria-label="Backup file" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; try { const s = await importBackup(JSON.parse(await f.text())); toast(`Restored: ${s.added} added, ${s.updated} updated`) } catch (er) { toast((er as Error).message) } }} />
      </div>
      <p className="muted">Backups include every group on this device (and any invite links you hold). Keep the file private.</p>
      {local?.role === 'owner' && (
        <button className="btn-ghost w-full" onClick={() => void saveRecord('group', group.id, { ...group, archived: !group.archived }, { action: 'group', summary: group.archived ? 'Unarchived group' : 'Archived group' }).then(() => toast(group.archived ? 'Group is active again' : 'Group archived (read-only for others)'))}>{group.archived ? 'Unarchive group' : 'Archive group'}</button>
      )}
      <button className="btn-ghost w-full" onClick={() => setConfirm(true)}>Remove this group from this device</button>
      {confirm && (
        <Modal title="Remove from this device?" onClose={() => setConfirm(false)}>
          <p className="mb-3">{local?.token ? 'The group stays on the server and you can rejoin with a link.' : 'This group exists ONLY here. Back it up first, or it will be gone for good.'}</p>
          <div className="flex gap-2"><button className="btn-ghost flex-1" onClick={() => setConfirm(false)}>Cancel</button>
            <button className="btn-danger flex-1" onClick={async () => {
              const gid = group.id
              await db.transaction('rw', [db.groups, db.members, db.expenses, db.settlements, db.recurring, db.activity, db.local, db.outbox, db.photos], async () => {
                await Promise.all([db.members, db.expenses, db.settlements, db.recurring, db.activity, db.outbox, db.photos].map((t) => (t as typeof db.members).where('groupId').equals(gid).delete()))
                await db.groups.delete(gid); await db.local.delete(gid)
              })
              nav('/', { replace: true })
            }}>Remove</button></div>
        </Modal>
      )}
    </section>
  )
}
