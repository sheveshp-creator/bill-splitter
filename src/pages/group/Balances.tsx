import { useState } from 'react'
import { CURRENCY_DECIMALS, convert, decimals, formatMoney, parseAmount, toDecimalString } from '../../core/currency'
import { todayLocal } from '../../core/misc'
import type { Settlement, Transfer } from '../../core/types'
import type { GroupData } from '../../components/hooks'
import QR from '../../components/QR'
import { Icon } from '../../components/icons'
import { Avatar, Banner, Field, Modal, copy, useToast } from '../../components/ui'
import { newBase, saveSettlement, setDeleted, uuid } from '../../db/repo'
import { getRate } from '../../lib/rates'
import { download, expensesToCsv, paymentRequestLink, reminderMessage, shareImage, shareText, summaryPdf, summaryPng, summaryText } from '../../lib/share'

export default function Balances({ data }: { data: GroupData }) {
  const toast = useToast()
  const { group, names, balances, transfers, members } = data
  const cur = group.baseCurrency
  const [simplify, setSimplify] = useState(true)
  const [settle, setSettle] = useState<Transfer | 'new' | null>(null)
  const [qr, setQr] = useState<{ link: string; title: string } | null>(null)
  const rows = data.live.map((m) => ({ m, v: balances[m.id] ?? 0 }))
  const archivedWithBalance = members.filter((m) => m.archived && !m.deleted && (balances[m.id] ?? 0) !== 0)
  const text = summaryText(group.name, transfers, names, cur)
  const upiOf = (id: string) => members.find((m) => m.id === id)?.upiId

  return (
    <section aria-label="Balances" className="space-y-4">
      <div className="card">
        <h2 className="section-title mb-2">Net balances</h2>
        <ul className="space-y-2">
          {[...rows, ...archivedWithBalance.map((m) => ({ m, v: balances[m.id] ?? 0 }))].map(({ m, v }) => (
            <li key={m.id} className="flex items-center gap-3"><Avatar id={m.id} name={names[m.id]} />
              <span className="flex-1 truncate">{names[m.id]}{m.archived && ' (archived)'}</span>
              <span className={`num font-medium ${v > 0 ? 'text-get' : v < 0 ? 'text-owe' : 'muted'}`}>
                {v > 0 ? 'gets back ' : v < 0 ? 'owes ' : 'settled '}{v !== 0 && formatMoney(Math.abs(v), cur)}</span></li>
          ))}
        </ul>
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-2">
          <h2 className="section-title">{simplify ? 'Simplified payments' : 'Everyone vs. everyone'}</h2>
          <button className="chip" aria-pressed={simplify} onClick={() => setSimplify(!simplify)}>{simplify ? 'Simplified' : 'Simplify debts'}</button>
        </div>
        {transfers.length === 0 ? <p className="muted">Everyone is settled up. Nothing left to pay.</p> : (
          <ul className="space-y-3">
            {(simplify ? transfers : pairwise(balances)).map((t) => {
              const link = paymentRequestLink(upiOf(t.to), names[t.to], t.amount, cur, `${group.name}`)
              return (
                <li key={`${t.from}-${t.to}`} className="border-t first:border-0 border-slate-200 dark:border-slate-800 pt-3 first:pt-0">
                  <div className="flex items-center gap-2 mb-2"><Avatar id={t.from} name={names[t.from]} size={28} /><span className="flex-1"><b>{names[t.from]}</b> pays <b>{names[t.to]}</b></span><b className="num font-medium">{formatMoney(t.amount, cur)}</b></div>
                  <div className="flex flex-wrap gap-2">
                    {data.canEdit && <button className="btn-primary !min-h-[40px]" onClick={() => setSettle(t)}>Record payment</button>}
                    {link && <><a className="btn-ghost !min-h-[40px]" href={link}>Pay via UPI</a><button className="btn-ghost !min-h-[40px]" onClick={() => setQr({ link, title: `${names[t.from]} → ${names[t.to]} ${formatMoney(t.amount, cur)}` })}>UPI QR</button></>}
                    <button className="btn-ghost !min-h-[40px]" onClick={async () => { const m = reminderMessage(names[t.from], names[t.to], t.amount, cur, group.name, upiOf(t.to)); toast((await shareText(m)) === 'copied' ? 'Reminder copied' : 'Shared') }}>Remind</button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        {!simplify && <p className="muted mt-2">Each person's net position matched against each other (without optimizing transaction count).</p>}
        {data.canEdit && <button className="btn-ghost mt-3 w-full" onClick={() => setSettle('new')}>+ Record a payment between any two people</button>}
      </div>

      <div className="card space-y-2">
        <h2 className="section-title">Share summary</h2>
        <pre className="whitespace-pre-wrap text-sm muted">{text}</pre>
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost" onClick={async () => toast((await shareText(text)) === 'copied' ? 'Copied to clipboard' : 'Shared')}>Share text</button>
          <button className="btn-ghost" onClick={async () => { const r = await shareImage(await summaryPng(group.name, transfers, names, cur), 'summary.png', text); toast(r === 'downloaded' ? 'Image saved' : 'Shared') }}>Share image</button>
          <button className="btn-ghost" onClick={async () => download(`${group.name}.pdf`, await summaryPdf(group.name, data.expenses, transfers, names, cur))}>PDF</button>
          <button className="btn-ghost" onClick={() => download(`${group.name}.csv`, new Blob([expensesToCsv(data.expenses, names)], { type: 'text/csv' }))}>CSV</button>
          <button className="btn-ghost" onClick={async () => { await copy(text); toast('Copied') }}>Copy</button>
        </div>
      </div>

      <div className="card">
        <h2 className="section-title mb-2">Payments made</h2>
        {data.settlements.filter((s) => !s.deleted).length === 0 && <p className="muted">None yet.</p>}
        <ul className="space-y-2">
          {data.settlements.filter((s) => !s.deleted).sort((a, b) => b.date.localeCompare(a.date)).map((s) => (
            <li key={s.id} className="flex items-center gap-2"><span className="flex-1 min-w-0 truncate">{names[s.from]} → {names[s.to]} <span className="muted">{s.date}{s.note && ` · ${s.note}`}</span></span>
              <b>{formatMoney(s.amount, s.currency)}</b>
              {data.canEdit && <button className="btn-ghost !px-3 !min-h-[36px]" aria-label="Delete payment" onClick={() => void setDeleted('settlement', s.id, true, 'a payment')}><Icon name="trash" size={16} /></button>}</li>
          ))}
        </ul>
      </div>

      {settle && <SettleSheet data={data} initial={settle === 'new' ? undefined : settle} onClose={() => setSettle(null)} />}
      {qr && <Modal title="Scan to pay" onClose={() => setQr(null)}><QR text={qr.link} label={`UPI payment QR: ${qr.title}`} /><p className="text-center mt-3 font-medium">{qr.title}</p></Modal>}
    </section>
  )
}

/** Non-optimized view: each debtor pays creditors proportionally (for comparison only). */
function pairwise(b: Record<string, number>): Transfer[] {
  const cred = Object.entries(b).filter(([, v]) => v > 0), debt = Object.entries(b).filter(([, v]) => v < 0)
  const total = cred.reduce((s, [, v]) => s + v, 0)
  const out: Transfer[] = []
  for (const [d, dv] of debt) {
    let left = -dv
    cred.forEach(([c, cv], i) => { const amt = i === cred.length - 1 ? left : Math.round((-dv * cv) / total); const a = Math.min(amt, left); if (a > 0) out.push({ from: d, to: c, amount: a }); left -= a })
  }
  return out
}

function SettleSheet({ data, initial, onClose }: { data: GroupData; initial?: Transfer; onClose: () => void }) {
  const toast = useToast()
  const base = data.group.baseCurrency
  const [from, setFrom] = useState(initial?.from ?? data.live[0]?.id ?? '')
  const [to, setTo] = useState(initial?.to ?? data.live[1]?.id ?? '')
  const [currency, setCurrency] = useState(base)
  const [amt, setAmt] = useState(initial ? toDecimalString(initial.amount, base) : '')
  const [rateStr, setRateStr] = useState('1')
  const [date, setDate] = useState(todayLocal())
  const [note, setNote] = useState('')
  const minor = parseAmount(amt, currency)
  const rate = currency === base ? 1 : Number(rateStr)
  const rateOk = currency === base || (rate > 0 && Number.isFinite(rate))
  const inBase = minor !== null && rateOk ? convert(minor, rate, currency, base) : null
  const owed = initial?.amount
  const err = from === to ? 'Choose two different people.' : minor === null || minor <= 0 ? `Enter an amount above 0 (up to ${decimals(currency)} decimals).` : !rateOk ? 'Enter an exchange rate.' : ''

  const changeCur = async (c: string) => { setCurrency(c); if (c === base) return setRateStr('1'); const r = await getRate(c, base); setRateStr(r ? String(r.rate) : '') }
  const save = async () => {
    if (err || minor === null) return
    const s: Settlement = { id: uuid(), groupId: data.group.id, from, to, amount: minor, currency, rate, date, note, ...newBase() }
    await saveSettlement(s); toast('Payment recorded'); onClose()
  }
  return (
    <Modal title="Record payment" onClose={onClose}>
      <div className="flex gap-2">
        <div className="flex-1"><Field label="From" htmlFor="sf"><select id="sf" className="input" value={from} onChange={(e) => setFrom(e.target.value)}>{data.live.map((m) => <option key={m.id} value={m.id}>{data.names[m.id]}</option>)}</select></Field></div>
        <div className="flex-1"><Field label="To" htmlFor="st"><select id="st" className="input" value={to} onChange={(e) => setTo(e.target.value)}>{data.live.map((m) => <option key={m.id} value={m.id}>{data.names[m.id]}</option>)}</select></Field></div>
      </div>
      <div className="flex gap-2">
        <div className="flex-[2]"><Field label="Amount" htmlFor="sa"><input id="sa" inputMode="decimal" className="input" value={amt} onChange={(e) => setAmt(e.target.value)} /></Field></div>
        <div className="flex-1"><Field label="Currency" htmlFor="sc"><select id="sc" className="input" value={currency} onChange={(e) => void changeCur(e.target.value)}>{Object.keys(CURRENCY_DECIMALS).map((c) => <option key={c}>{c}</option>)}</select></Field></div>
      </div>
      {currency !== base && <Field label={`Rate: 1 ${currency} = ? ${base}`} htmlFor="sr" hint={inBase !== null ? `Counts as ${formatMoney(inBase, base)} toward the balance.` : undefined}><input id="sr" inputMode="decimal" className="input" value={rateStr} onChange={(e) => setRateStr(e.target.value)} /></Field>}
      {owed !== undefined && inBase !== null && inBase < owed && !err && <Banner>Partial payment: {formatMoney(owed - inBase, base)} will still be owed.</Banner>}
      {owed !== undefined && inBase !== null && inBase > owed && !err && <Banner tone="warn">That's {formatMoney(inBase - owed, base)} more than owed. The extra becomes credit in their favour.</Banner>}
      <Field label="Date" htmlFor="sd"><input id="sd" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <Field label="Note (optional)" htmlFor="sn"><input id="sn" className="input" maxLength={120} value={note} onChange={(e) => setNote(e.target.value)} placeholder="UPI, cash…" /></Field>
      {err && amt !== '' && <p role="alert" className="err mb-2">{err}</p>}
      <button className="btn-primary w-full" disabled={!!err} onClick={() => void save()}>Save payment</button>
    </Modal>
  )
}
