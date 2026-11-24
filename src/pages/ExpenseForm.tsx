import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { balanceDelta, computeBalances } from '../core/balances'
import { CURRENCY_DECIMALS, decimals, formatMoney, parseAmount, toDecimalString } from '../core/currency'
import { sanitizeText, todayLocal } from '../core/misc'
import { autoFixExact, autoFixPercent, computeItemized, validatePayers, validateSplit } from '../core/split'
import type { Category, Expense, SplitSpec } from '../core/types'
import ItemizedEditor, { draftsToItems, emptyExtras, extrasFromItemized, extrasToItemized, itemsToDrafts, type Draft, type ExtrasDraft } from '../components/ItemizedEditor'
import { Avatar, AvatarToggle, Banner, Field, Modal, useToast } from '../components/ui'
import { useGroupData } from '../components/hooks'
import { db } from '../db/db'
import { newBase, saveExpense, setDeleted, uuid } from '../db/repo'
import { compressReceipt } from '../lib/image'
import { getRate } from '../lib/rates'
import { Icon } from '../components/icons'
import { computeShares } from '../core/split'

type Mode = 'equal' | 'exact' | 'percent' | 'shares' | 'itemized'
const MODES: [Mode, string][] = [['equal', 'Equally'], ['exact', 'Exact'], ['percent', '%'], ['shares', 'Shares'], ['itemized', 'Itemized']]
const CATS: Category[] = ['food', 'travel', 'stay', 'shopping', 'rent', 'utilities', 'fun', 'other']

const pctToBp = (s: string): number | null => (/^\d{1,3}(\.\d{1,2})?$/.test(s.trim()) ? Math.round(parseFloat(s) * 100) : null)
const bpToStr = (bp: number) => String(bp / 100)

export default function ExpenseForm() {
  const { id = '', eid } = useParams()
  const nav = useNavigate()
  const toast = useToast()
  const { data, loading, missing } = useGroupData(id)
  const [existing, setExisting] = useState<Expense | null | undefined>(eid ? undefined : null)

  useEffect(() => { if (eid) void db.expenses.get(eid).then((e) => setExisting(e ?? null)) }, [eid])
  if (loading || existing === undefined) return <p className="p-6 muted" role="status">Loading…</p>
  if (missing || !data) return <p className="p-6">Group not found. <Link className="underline" to="/">Home</Link></p>
  if (eid && !existing) return <p className="p-6">Expense not found. <Link className="underline" to={`/g/${id}`}>Back</Link></p>
  return <Form key={eid ?? 'new'} data={data} existing={existing} />
}

function Form({ data, existing }: { data: NonNullable<ReturnType<typeof useGroupData>['data']>; existing: Expense | null }) {
  const nav = useNavigate()
  const toast = useToast()
  const { group, names } = data
  const base = group.baseCurrency
  const isNew = !existing
  const refd = new Set(existing ? [...Object.keys(existing.payers)] : [])
  const people = data.members.filter((m) => !m.deleted && (!m.archived || refd.has(m.id) || existing?.split.mode === 'equal' && existing.split.participants.includes(m.id)))
  const ids = people.map((p) => p.id)
  const ro = !data.canEdit

  /* ---------- initial state (new or from existing) ---------- */
  const s0 = existing?.split
  const cur0 = existing?.currency ?? base
  const [title, setTitle] = useState(existing?.title ?? '')
  const [amountStr, setAmountStr] = useState(existing && existing.split.mode !== 'itemized' ? toDecimalString(existing.amount, cur0) : '')
  const [currency, setCurrency] = useState(cur0)
  const [rateStr, setRateStr] = useState(existing ? String(existing.rate) : '1')
  const [rateNote, setRateNote] = useState('')
  const [date, setDate] = useState(existing?.date ?? todayLocal())
  const [category, setCategory] = useState<Category>(existing?.category ?? 'food')
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [photo, setPhoto] = useState<Blob | null>(null)
  const [photoUrl, setPhotoUrl] = useState<string>('')

  const payerIds0 = existing ? Object.keys(existing.payers) : []
  const [multiPay, setMultiPay] = useState(payerIds0.length > 1)
  const [payer, setPayer] = useState(payerIds0[0] ?? data.local?.meId ?? ids[0] ?? '')
  const [payAmts, setPayAmts] = useState<Record<string, string>>(Object.fromEntries(Object.entries(existing?.payers ?? {}).map(([k, v]) => [k, toDecimalString(v, cur0)])))

  const [mode, setMode] = useState<Mode>(s0?.mode ?? 'equal')
  const [parts, setParts] = useState<Set<string>>(new Set(s0?.mode === 'equal' ? s0.participants : ids))
  const [exact, setExact] = useState<Record<string, string>>(s0?.mode === 'exact' ? Object.fromEntries(Object.entries(s0.amounts).map(([k, v]) => [k, toDecimalString(v, cur0)])) : {})
  const [pct, setPct] = useState<Record<string, string>>(s0?.mode === 'percent' ? Object.fromEntries(Object.entries(s0.percents).map(([k, v]) => [k, bpToStr(v)])) : {})
  const [shares, setShares] = useState<Record<string, string>>(s0?.mode === 'shares' ? Object.fromEntries(Object.entries(s0.shares).map(([k, v]) => [k, String(v)])) : Object.fromEntries(ids.map((i) => [i, '1'])))
  const adj0 = s0 && s0.mode !== 'exact' && s0.mode !== 'itemized' ? s0.adjustments : undefined
  const [adj, setAdj] = useState<Record<string, string>>(Object.fromEntries(Object.entries(adj0 ?? {}).map(([k, v]) => [k, toDecimalString(v, cur0)])))
  const [showAdj, setShowAdj] = useState(!!adj0 && Object.keys(adj0).length > 0)
  const [drafts, setDrafts] = useState<Draft[]>(s0?.mode === 'itemized' ? itemsToDrafts(s0.items, cur0) : [])
  const [extras, setExtras] = useState<ExtrasDraft>(s0?.mode === 'itemized' ? extrasFromItemized(s0.extras, cur0) : emptyExtras())
  const [confirmDel, setConfirmDel] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (existing?.photoId) void db.photos.get(existing.photoId).then((p) => p && setPhotoUrl(URL.createObjectURL(p.blob)))
  }, [existing?.photoId])
  useEffect(() => { if (!photo) return; const u = URL.createObjectURL(photo); setPhotoUrl(u); return () => URL.revokeObjectURL(u) }, [photo])

  /* ---------- exchange rate: fetch when currency changes (never rewrites an existing expense's frozen rate) ---------- */
  const changeCurrency = async (c: string) => {
    setCurrency(c)
    if (c === base) { setRateStr('1'); setRateNote(''); return }
    const r = await getRate(c, base)
    if (r) { setRateStr(String(r.rate)); setRateNote(r.source === 'live' ? 'Live rate (editable)' : 'Cached rate (offline) — editable') }
    else { setRateStr(''); setRateNote('No rate available — enter one manually.') }
  }
  const rate = currency === base ? 1 : Number(rateStr)
  const rateOk = currency === base || (Number.isFinite(rate) && rate > 0)

  /* ---------- derive amount, split spec, errors ---------- */
  const itemizedExtras = useMemo(() => extrasToItemized(extras, currency), [extras, currency])
  const draftItems = useMemo(() => draftsToItems(drafts, currency), [drafts, currency])
  const amount: number | null = mode === 'itemized' ? computeItemized(draftItems, itemizedExtras).total : parseAmount(amountStr, currency)

  const parseMap = (m: Record<string, string>) => {
    const out: Record<string, number> = {}; let bad = false
    for (const [k, v] of Object.entries(m)) { if (v.trim() === '') continue; const n = parseAmount(v, currency); if (n === null) bad = true; else out[k] = n }
    return { out, bad }
  }
  const adjP = showAdj ? parseMap(adj) : { out: {}, bad: false }
  const adjustments = Object.keys(adjP.out).length ? adjP.out : undefined

  const { spec, specBad } = useMemo((): { spec: SplitSpec; specBad: boolean } => {
    if (mode === 'equal') return { spec: { mode, participants: ids.filter((i) => parts.has(i)), adjustments }, specBad: adjP.bad }
    if (mode === 'exact') { const p = parseMap(exact); return { spec: { mode, amounts: p.out }, specBad: p.bad } }
    if (mode === 'percent') {
      const o: Record<string, number> = {}; let bad = false
      for (const [k, v] of Object.entries(pct)) { if (!v.trim()) continue; const b = pctToBp(v); if (b === null) bad = true; else o[k] = b }
      return { spec: { mode, percents: o, adjustments }, specBad: bad || adjP.bad }
    }
    if (mode === 'shares') {
      const o: Record<string, number> = {}; let bad = false
      for (const [k, v] of Object.entries(shares)) { if (!v.trim()) continue; const n = Number(v); if (!(n >= 0) || Math.round(n * 100) !== n * 100 && Math.abs(Math.round(n * 100) - n * 100) > 1e-9) bad = true; else o[k] = n }
      return { spec: { mode, shares: o, adjustments }, specBad: bad || adjP.bad }
    }
    return { spec: { mode: 'itemized', items: draftItems, extras: itemizedExtras }, specBad: false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, parts, exact, pct, shares, adj, showAdj, draftItems, itemizedExtras, currency])

  const payers: Record<string, number> = useMemo(() => {
    if (amount === null) return {}
    if (!multiPay) return payer ? { [payer]: amount } : {}
    return parseMap(payAmts).out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multiPay, payer, payAmts, amount, currency])
  const payBad = multiPay && parseMap(payAmts).bad

  const splitV = amount === null ? null : validateSplit(amount, spec)
  const payV = amount === null ? null : validatePayers(amount, payers)
  const amountErr = amount === null && mode !== 'itemized' && amountStr !== '' ? `Enter a valid amount (up to ${decimals(currency)} decimals).` : ''
  const errors: string[] = []
  if (!title.trim()) errors.push('Add a title.')
  if (amount === null) errors.push('Enter an amount.')
  if (amount !== null && mode === 'itemized' && draftItems.length && draftItems.some((i) => i.unitPrice === 0 && drafts.find((d) => d.id === i.id)?.priceStr === '')) errors.push('Every item needs a price.')
  if (splitV && !splitV.ok) {
    const r = splitV.remaining
    errors.push(splitV.code === 'exact_sum' ? (r > 0 ? `${formatMoney(r, currency)} of the total is not assigned yet.` : `Assigned amounts exceed the total by ${formatMoney(-r, currency)}.`)
      : splitV.code === 'percent_sum' ? `Percentages must add up to 100% (${r > 0 ? `${r / 100}% left` : `${-r / 100}% over`}).`
      : splitV.message ?? 'Fix the split.')
  }
  if (specBad) errors.push('Some split values are not valid numbers.')
  if (payV && !payV.ok) errors.push(payV.code === 'payer_sum' ? `Paid amounts must add up to the total (${formatMoney(Math.abs(payV.remaining), currency)} ${payV.remaining > 0 ? 'missing' : 'extra'}).` : payV.message ?? 'Fix who paid.')
  if (payBad) errors.push('Some paid amounts are not valid.')
  if (!rateOk) errors.push('Enter an exchange rate.')
  const valid = errors.length === 0

  /* ---------- balance impact preview (edits) ---------- */
  const draftExpense = (): Expense | null => {
    if (!valid || amount === null) return null
    const photoId = existing?.photoId ?? (photo ? uuid() : undefined)
    return {
      ...(existing ?? { id: uuid(), groupId: group.id, createdAt: new Date().toISOString(), ...newBase() }),
      title: sanitizeText(title, 120), amount, currency, rate: rate, date, payers, split: spec, category, notes, photoId,
    } as Expense
  }
  const delta = useMemo(() => {
    if (!existing || !valid) return {}
    const e = draftExpense(); if (!e) return {}
    try {
      const others = data.expenses.filter((x) => x.id !== e.id)
      return balanceDelta(computeBalances([...others, existing], data.settlements, base), computeBalances([...others, e], data.settlements, base))
    } catch { return {} }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valid, amount, spec, payers, rate, currency, existing])
  const deleteDelta = useMemo(() => {
    if (!existing) return {}
    const others = data.expenses.filter((x) => x.id !== existing.id)
    try { return balanceDelta(computeBalances(data.expenses, data.settlements, base), computeBalances(others, data.settlements, base)) } catch { return {} }
  }, [existing, data.expenses, data.settlements, base])

  async function save() {
    const e = draftExpense()
    if (!e || ro) return
    setSaving(true)
    try {
      if (photo && e.photoId) await db.photos.put({ id: e.photoId, groupId: group.id, blob: photo, updatedAt: new Date().toISOString() })
      await saveExpense(e, isNew)
      toast(isNew ? 'Expense added' : 'Expense updated')
      nav(`/g/${group.id}`, { replace: true })
    } catch (err) { toast((err as Error).message); setSaving(false) }
  }

  const exactAmts = mode === 'exact' ? (spec as { amounts: Record<string, number> }).amounts : {}
  const exactTarget = Object.keys(exactAmts)[0] ?? ids[0]
  const fixExact = () => {
    if (amount === null) return
    const fixed = autoFixExact(amount, Object.keys(exactAmts).length ? exactAmts : { [exactTarget]: 0 }, exactTarget)
    setExact(Object.fromEntries(Object.entries(fixed).map(([k, v]) => [k, toDecimalString(v, currency)])))
  }

  const memberRow = (m: { id: string }, input: React.ReactNode) => (
    <div key={m.id} className="flex items-center gap-3 mb-2"><Avatar id={m.id} name={names[m.id]} /><span className="flex-1 truncate">{names[m.id]}</span>{input}</div>
  )
  const fmtDelta = (d: Record<string, number>) => Object.entries(d).map(([k, v]) => `${names[k] ?? '?'} ${v > 0 ? '+' : ''}${formatMoney(v, base)}`).join(', ')

  return (
    <main className="p-4 pb-32">
      <div className="flex items-center justify-between mb-3">
        <Link to={`/g/${group.id}`} className="btn-ghost !min-h-[40px]"><Icon name="back" size={18} />Back</Link>
        <h1 className="text-xl font-semibold">{isNew ? 'New expense' : 'Edit expense'}</h1>
        <span className="w-16" />
      </div>
      {ro && <Banner tone="warn">You have view-only access to this group.</Banner>}

      <fieldset disabled={ro || saving} className="min-w-0">
        <Field label="Title" htmlFor="title"><input id="title" className="input" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Dinner, taxi, groceries…" /></Field>

        {mode !== 'itemized' ? (
          <div className="flex gap-2">
            <div className="flex-[2]"><Field label="Amount" htmlFor="amt" error={amountErr}>
              <input id="amt" inputMode="decimal" autoFocus={isNew} className="input num !text-3xl !font-medium !min-h-[64px]" value={amountStr} onChange={(e) => setAmountStr(e.target.value)} placeholder="0.00" aria-invalid={!!amountErr} /></Field></div>
            <div className="flex-1"><Field label="Currency" htmlFor="cur">
              <select id="cur" className="input" value={currency} onChange={(e) => void changeCurrency(e.target.value)}>{Object.keys(CURRENCY_DECIMALS).map((c) => <option key={c}>{c}</option>)}</select></Field></div>
          </div>
        ) : (
          <Field label="Currency" htmlFor="cur" hint="The total is calculated from the items below.">
            <select id="cur" className="input" value={currency} onChange={(e) => void changeCurrency(e.target.value)}>{Object.keys(CURRENCY_DECIMALS).map((c) => <option key={c}>{c}</option>)}</select></Field>
        )}
        {currency !== base && (
          <Field label={`Exchange rate: 1 ${currency} = ? ${base}`} htmlFor="rate" hint={rateNote || 'Frozen at entry. Later rate changes never alter this expense.'} error={!rateOk ? 'Enter a rate above 0.' : ''}>
            <input id="rate" inputMode="decimal" className="input" value={rateStr} onChange={(e) => setRateStr(e.target.value)} />
            {amount !== null && rateOk && <p className="muted mt-1">≈ {formatMoney(Math.round(amount * rate * 10 ** (decimals(base) - decimals(currency))), base)}</p>}
          </Field>
        )}

        <div role="radiogroup" aria-label="Category" className="flex gap-2 overflow-x-auto pb-2 mb-3 -mx-1 px-1">
          {CATS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={category === c} onClick={() => setCategory(c)}
              className={`chip shrink-0 gap-1 ${category === c ? 'chip-on' : ''}`}><Icon name={c} size={16} /><span className="capitalize">{c}</span></button>
          ))}
        </div>

        {/* ---- payers ---- */}
        <section className="card mb-3" aria-label="Who paid">
          <div className="flex items-center justify-between mb-2"><h2 className="section-title">Paid by</h2>
            <button type="button" className="chip" onClick={() => { setMultiPay(!multiPay); if (!multiPay && amount !== null) setPayAmts({ [payer]: toDecimalString(amount, currency) }) }}>{multiPay ? 'One person' : 'Multiple people'}</button></div>
          {!multiPay ? (
            <div role="radiogroup" aria-label="Paid by" className="flex flex-wrap">{people.map((m) => <AvatarToggle key={m.id} id={m.id} name={names[m.id]} on={payer === m.id} onToggle={() => setPayer(m.id)} />)}</div>
          ) : (
            <>
              {people.map((m) => memberRow(m, <input aria-label={`${names[m.id]} paid`} inputMode="decimal" className="input !w-28" placeholder="0" value={payAmts[m.id] ?? ''} onChange={(e) => setPayAmts({ ...payAmts, [m.id]: e.target.value })} />))}
              {payV && !payV.ok && amount !== null && (
                <p className="err" role="alert">{payV.remaining > 0 ? `${formatMoney(payV.remaining, currency)} still unaccounted for` : `Over by ${formatMoney(-payV.remaining, currency)}`}
                  <button type="button" className="underline ml-2" onClick={() => { const k = Object.keys(payers)[0] ?? ids[0]; setPayAmts({ ...payAmts, [k]: toDecimalString((payers[k] ?? 0) + payV.remaining, currency) }) }}>Fix it</button></p>
              )}
            </>
          )}
          <p className="muted mt-2">The payer doesn't have to be one of the people sharing the cost.</p>
        </section>

        {/* ---- split ---- */}
        <section className="card mb-3" aria-label="How to split">
          <h2 className="section-title mb-2">Split</h2>
          <div role="tablist" aria-label="Split mode" className="flex flex-wrap gap-2 mb-3">
            {MODES.map(([m, label]) => <button type="button" role="tab" aria-selected={mode === m} key={m} className={`chip ${mode === m ? 'chip-on' : ''}`} onClick={() => setMode(m)}>{label}</button>)}
          </div>

          {mode === 'equal' && (
            <div className="flex flex-wrap">{people.map((m) => <AvatarToggle key={m.id} id={m.id} name={names[m.id]} on={parts.has(m.id)} onToggle={() => { const n = new Set(parts); n.has(m.id) ? n.delete(m.id) : n.add(m.id); setParts(n) }} />)}
              <button type="button" className="chip self-center ml-1" onClick={() => setParts(parts.size === ids.length ? new Set() : new Set(ids))}>All</button></div>
          )}
          {mode === 'exact' && people.map((m) => memberRow(m, <input aria-label={`${names[m.id]} owes`} inputMode="decimal" className="input !w-28" placeholder="0" value={exact[m.id] ?? ''} onChange={(e) => setExact({ ...exact, [m.id]: e.target.value })} />))}
          {mode === 'percent' && people.map((m) => memberRow(m, <span className="flex items-center gap-1"><input aria-label={`${names[m.id]} percent`} inputMode="decimal" className="input !w-24" placeholder="0" value={pct[m.id] ?? ''} onChange={(e) => setPct({ ...pct, [m.id]: e.target.value })} />%</span>))}
          {mode === 'shares' && (<>{people.map((m) => memberRow(m, <input aria-label={`${names[m.id]} shares`} inputMode="decimal" className="input !w-24" placeholder="1" value={shares[m.id] ?? ''} onChange={(e) => setShares({ ...shares, [m.id]: e.target.value })} />))}
            <p className="muted">E.g. 1 per adult, 0.5 per child, 0 to leave someone out.</p></>)}
          {mode === 'itemized' && <ItemizedEditor members={people.map((m) => ({ id: m.id, name: names[m.id] }))} currency={currency} drafts={drafts} setDrafts={setDrafts} extras={extras} setExtras={setExtras} onPhoto={setPhoto} disabled={ro} />}

          {/* live split feedback */}
          {splitV && !splitV.ok && (
            <div role="alert" className="mt-3 rounded-xl bg-red-50 dark:bg-red-950 p-3 text-sm text-red-800 dark:text-red-200">
              {mode === 'exact' && <>{splitV.remaining > 0 ? `${formatMoney(splitV.remaining, currency)} remaining to assign` : `Over by ${formatMoney(-splitV.remaining, currency)}`}
                <button type="button" className="underline font-semibold ml-2" onClick={fixExact}>Put the rest on {names[exactTarget]}</button></>}
              {mode === 'percent' && <>{splitV.remaining > 0 ? `${splitV.remaining / 100}% remaining` : `Over by ${-splitV.remaining / 100}%`}
                <button type="button" className="underline font-semibold ml-2" onClick={() => setPct(Object.fromEntries(Object.entries(autoFixPercent((spec as { percents: Record<string, number> }).percents)).map(([k, v]) => [k, bpToStr(v)])))}>Scale to 100%</button></>}
              {(mode === 'equal' || mode === 'shares' || mode === 'itemized') && splitV.message}
            </div>
          )}

          {mode !== 'exact' && mode !== 'itemized' && (
            <div className="mt-3">
              <button type="button" className="chip" aria-expanded={showAdj} onClick={() => setShowAdj(!showAdj)}>± Adjustments</button>
              {showAdj && <div className="mt-2"><p className="muted mb-2">Add (+) or subtract (−) an amount for a person, e.g. +200 for extra drinks. The rest is split as above.</p>
                {people.map((m) => memberRow(m, <input aria-label={`${names[m.id]} adjustment`} inputMode="decimal" className="input !w-28" placeholder="+/- 0" value={adj[m.id] ?? ''} onChange={(e) => setAdj({ ...adj, [m.id]: e.target.value })} />))}</div>}
            </div>
          )}
        </section>

        {valid && amount !== null && (() => { try { const sh = computeShares(amount, spec); return (
          <section className="card mb-3" aria-label="Preview" aria-live="polite">
            <h2 className="section-title mb-2">Each person pays</h2>
            <ul className="space-y-1">{Object.entries(sh).filter(([, v]) => v !== 0).map(([k, v]) => <li key={k} className="flex items-center gap-2"><Avatar id={k} name={names[k] ?? '?'} size={24} /><span className="flex-1">{names[k] ?? '?'}</span><b className="num font-medium">{formatMoney(v, currency)}</b></li>)}</ul>
          </section>) } catch { return null } })()}

        <details className="card mb-3" open={!!existing && (!!existing.notes || !!existing.photoId)}>
          <summary className="font-semibold cursor-pointer min-h-[44px] flex items-center">More details: date, notes, photo</summary>
          <div className="mt-3">
            <Field label="Date" htmlFor="date" hint="Backdate if you're logging this later."><input id="date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="Notes" htmlFor="notes"><textarea id="notes" className="input !py-2" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            <Field label="Receipt photo" htmlFor="photo" hint="Compressed to ~250 KB, location data removed. Stored on this device.">
              <input id="photo" type="file" accept="image/*" className="input !py-2" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; try { setPhoto(await compressReceipt(f)) } catch (er) { toast((er as Error).message) } }} />
              {photoUrl && <img src={photoUrl} alt="Receipt" className="mt-2 max-h-48 rounded-xl border" />}
            </Field>
          </div>
        </details>
      </fieldset>

      {existing && Object.keys(delta).length > 0 && (
        <Banner tone="warn"><b>Balance impact of this edit:</b> {fmtDelta(delta)}{data.settlements.length > 0 && ' — some payments have already been recorded, so these differences are what people now owe or are owed on top of them.'}</Banner>
      )}
      {!valid && errors.length > 0 && <ul className="err mb-3 list-disc pl-5" aria-live="polite">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}

      <div className="fixed bottom-0 inset-x-0 bg-card border-t-2 border-ink p-3 pb-[max(.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto max-w-xl flex gap-2">
          {existing && !ro && <button type="button" className="btn-ghost" onClick={() => setConfirmDel(true)}>Delete</button>}
          <button type="button" className="btn-primary flex-1" disabled={!valid || ro || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save expense'}</button>
        </div>
      </div>

      {confirmDel && existing && (
        <Modal title="Delete this expense?" onClose={() => setConfirmDel(false)}>
          <p className="mb-2">It will be moved out of the balances. You can restore it from the activity log.</p>
          {Object.keys(deleteDelta).length > 0 && <Banner tone="warn">Balance change: {fmtDelta(deleteDelta)}{data.settlements.length > 0 && '. Payments already recorded stay as they are and may now count as extra credit.'}</Banner>}
          <div className="flex gap-2"><button className="btn-ghost flex-1" onClick={() => setConfirmDel(false)}>Cancel</button>
            <button className="btn-danger flex-1" onClick={async () => { await setDeleted('expense', existing.id, true, `"${existing.title}"`); toast('Deleted'); nav(`/g/${group.id}`, { replace: true }) }}>Delete</button></div>
        </Modal>
      )}
    </main>
  )
}
