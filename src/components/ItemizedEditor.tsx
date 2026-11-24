import { useRef, useState } from 'react'
import { parseAmount, toDecimalString } from '../core/currency'
import { computeItemized } from '../core/split'
import type { Charge, ItemizedExtras, ReceiptItem } from '../core/types'
import { formatMoney } from '../core/currency'
import { compressReceipt } from '../lib/image'
import { LOW_CONFIDENCE, parseReceipt, runOcr } from '../lib/ocr'
import { uuid } from '../db/repo'
import { AvatarToggle } from './ui'
import { Icon } from './icons'

export interface Draft { id: string; name: string; qty: number; priceStr: string; units: string[][]; confidence?: number }
export interface ChargeDraft { type: 'percent' | 'flat'; value: string }
export interface ExtrasDraft { tax: ChargeDraft; tip: ChargeDraft; service: ChargeDraft; discount: ChargeDraft; discountBeforeTax: boolean; distribution: 'proportional' | 'equal' }
export const emptyExtras = (): ExtrasDraft => ({ tax: { type: 'percent', value: '' }, tip: { type: 'percent', value: '' }, service: { type: 'percent', value: '' }, discount: { type: 'flat', value: '' }, discountBeforeTax: true, distribution: 'proportional' })

export const draftsToItems = (d: Draft[], cur: string): ReceiptItem[] =>
  d.map((x) => ({ id: x.id, name: x.name, qty: x.qty, unitPrice: parseAmount(x.priceStr, cur) ?? 0, units: x.units.map((s) => ({ sharers: s })), confidence: x.confidence }))
export const itemsToDrafts = (items: ReceiptItem[], cur: string): Draft[] =>
  items.map((i) => ({ id: i.id, name: i.name, qty: i.qty, priceStr: toDecimalString(i.unitPrice, cur), units: i.units.map((u) => u.sharers), confidence: i.confidence }))

const parseCharge = (c: ChargeDraft, cur: string): Charge | undefined => {
  const s = c.value.trim()
  if (!s) return undefined
  if (c.type === 'flat') { const v = parseAmount(s, cur); return v === null ? undefined : { type: 'flat', value: v } }
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return undefined
  return { type: 'percent', value: Math.round(parseFloat(s) * 100) }
}
const chargeToDraft = (c: Charge | undefined, cur: string, fallback: 'percent' | 'flat'): ChargeDraft =>
  !c ? { type: fallback, value: '' } : c.type === 'flat' ? { type: 'flat', value: toDecimalString(c.value, cur) } : { type: 'percent', value: String(c.value / 100) }
export const extrasToItemized = (e: ExtrasDraft, cur: string): ItemizedExtras => ({
  tax: parseCharge(e.tax, cur), tip: parseCharge(e.tip, cur), service: parseCharge(e.service, cur), discount: parseCharge(e.discount, cur),
  discountBeforeTax: e.discountBeforeTax, distribution: e.distribution,
})
export const extrasFromItemized = (x: ItemizedExtras, cur: string): ExtrasDraft => ({
  tax: chargeToDraft(x.tax, cur, 'percent'), tip: chargeToDraft(x.tip, cur, 'percent'), service: chargeToDraft(x.service, cur, 'percent'), discount: chargeToDraft(x.discount, cur, 'flat'),
  discountBeforeTax: x.discountBeforeTax, distribution: x.distribution,
})

interface Props {
  members: { id: string; name: string }[]
  currency: string
  drafts: Draft[]; setDrafts: (d: Draft[]) => void
  extras: ExtrasDraft; setExtras: (e: ExtrasDraft) => void
  onPhoto: (b: Blob) => void
  disabled?: boolean
}

export default function ItemizedEditor({ members, currency, drafts, setDrafts, extras, setExtras, onPhoto, disabled }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const ids = members.map((m) => m.id)
  const items = draftsToItems(drafts, currency)
  const r = computeItemized(items, extrasToItemized(extras, currency))

  const patch = (id: string, p: Partial<Draft>) => setDrafts(drafts.map((d) => (d.id === id ? { ...d, ...p } : d)))
  const setQty = (d: Draft, q: number) => {
    const qty = Math.max(1, Math.min(99, q || 1))
    patch(d.id, { qty, units: Array.from({ length: qty }, (_, i) => d.units[i] ?? []) })
  }
  const toggle = (d: Draft, unit: number, id: string) =>
    patch(d.id, { units: d.units.map((u, i) => (i !== unit ? u : u.includes(id) ? u.filter((x) => x !== id) : [...u, id])) })

  async function scan(f?: File) {
    if (!f) return
    setErr(''); setBusy('Preparing photo…')
    try {
      const img = await compressReceipt(f)
      onPhoto(img)
      setBusy('Reading receipt… 0%')
      const lines = await runOcr(img, (p) => setBusy(`Reading receipt… ${Math.round(p * 100)}%`))
      const parsed = parseReceipt(lines, currency)
      if (!parsed.items.length) setErr("Couldn't find any line items. Add them manually below.")
      setDrafts([...drafts, ...itemsToDrafts(parsed.items, currency)])
      const flat = (v: number): ChargeDraft => ({ type: 'flat', value: toDecimalString(v, currency) })
      setExtras({
        ...extras,
        tax: parsed.tax ? flat(parsed.tax) : extras.tax, service: parsed.service ? flat(parsed.service) : extras.service,
        tip: parsed.tip ? flat(parsed.tip) : extras.tip, discount: parsed.discount ? flat(parsed.discount) : extras.discount,
      })
    } catch (e) { setErr((e as Error).message || 'Could not read the receipt. You can still add items manually.') }
    finally { setBusy(null); if (fileRef.current) fileRef.current.value = '' }
  }

  return (
    <section aria-label="Itemized receipt" className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-ghost" disabled={disabled || !!busy} onClick={() => fileRef.current?.click()}><Icon name="camera" size={18} />Scan receipt</button>
        <button type="button" className="btn-ghost" disabled={disabled}
          onClick={() => setDrafts([...drafts, { id: uuid(), name: '', qty: 1, priceStr: '', units: [[]] }])}>+ Add item</button>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden aria-label="Receipt photo" onChange={(e) => void scan(e.target.files?.[0])} />
      </div>
      {busy && <p role="status" className="muted">{busy}</p>}
      {err && <p role="alert" className="err">{err}</p>}
      {drafts.some((d) => (d.confidence ?? 100) < LOW_CONFIDENCE) && <p className="muted">Items outlined in amber were hard to read. Please double-check them.</p>}

      {drafts.map((d, idx) => {
        const low = (d.confidence ?? 100) < LOW_CONFIDENCE
        const priceBad = d.priceStr !== '' && parseAmount(d.priceStr, currency) === null
        return (
          <div key={d.id} className={`card !p-3 ${low ? '!border-mark !border-4' : ''}`}>
            <div className="flex gap-2 mb-2">
              <input aria-label={`Item ${idx + 1} name`} className="input" placeholder="Item" value={d.name} disabled={disabled} maxLength={80} onChange={(e) => patch(d.id, { name: e.target.value })} />
              <button type="button" className="btn-ghost !px-3" aria-label={`Remove item ${d.name || idx + 1}`} disabled={disabled} onClick={() => setDrafts(drafts.filter((x) => x.id !== d.id))}><Icon name="trash" size={16} /></button>
            </div>
            <div className="flex gap-2 mb-2">
              <label className="flex-1"><span className="label">Qty</span>
                <input inputMode="numeric" className="input" value={d.qty} disabled={disabled} onChange={(e) => setQty(d, parseInt(e.target.value, 10))} /></label>
              <label className="flex-[2]"><span className="label">Price each ({currency})</span>
                <input inputMode="decimal" className={`input ${priceBad ? '!border-red-500' : ''}`} value={d.priceStr} disabled={disabled} onChange={(e) => patch(d.id, { priceStr: e.target.value })} aria-invalid={priceBad} /></label>
            </div>
            {priceBad && <p className="err mb-2" role="alert">Max {currency === 'JPY' ? 0 : currency === 'KWD' ? 3 : 2} decimals.</p>}
            {d.units.map((u, ui) => (
              <div key={ui} className="mb-1">
                {d.qty > 1 && <div className="muted">Unit {ui + 1} of {d.qty}</div>}
                <div className="flex flex-wrap items-center">
                  {members.map((m) => <AvatarToggle key={m.id} id={m.id} name={m.name} on={u.includes(m.id)} disabled={disabled} onToggle={() => toggle(d, ui, m.id)} />)}
                  <button type="button" className="chip ml-1" disabled={disabled} onClick={() => patch(d.id, { units: d.units.map((x, i) => (i === ui ? (x.length === ids.length ? [] : ids) : x)) })}>All</button>
                </div>
                {u.length === 0 && <p className="err">Tap who shares this{d.qty > 1 ? ' unit' : ''}.</p>}
              </div>
            ))}
          </div>
        )
      })}

      <fieldset className="card space-y-3" disabled={disabled}>
        <legend className="font-semibold px-1">Tax, tip &amp; discounts</legend>
        {(['tax', 'service', 'tip', 'discount'] as const).map((k) => (
          <div key={k} className="flex gap-2 items-end">
            <label className="flex-1"><span className="label">{k === 'service' ? 'Service charge' : k}</span>
              <input inputMode="decimal" className="input" value={extras[k].value} onChange={(e) => setExtras({ ...extras, [k]: { ...extras[k], value: e.target.value } })} /></label>
            <div role="group" aria-label={`${k} type`} className="flex">
              {(['percent', 'flat'] as const).map((t) => (
                <button type="button" key={t} aria-pressed={extras[k].type === t} className={`chip ${extras[k].type === t ? 'chip-on' : ''}`}
                  onClick={() => setExtras({ ...extras, [k]: { ...extras[k], type: t } })}>{t === 'percent' ? '%' : currency}</button>
              ))}
            </div>
          </div>
        ))}
        <label className="flex items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={extras.discountBeforeTax} onChange={(e) => setExtras({ ...extras, discountBeforeTax: e.target.checked })} /> Apply discount before tax</label>
        <label className="flex items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={extras.distribution === 'equal'} onChange={(e) => setExtras({ ...extras, distribution: e.target.checked ? 'equal' : 'proportional' })} /> Split tax/tip equally (instead of in proportion to what each person ordered)</label>
      </fieldset>

      <div className="card muted space-y-1" aria-live="polite">
        <div className="flex justify-between"><span>Items</span><span>{formatMoney(r.subtotal, currency)}</span></div>
        {r.discount > 0 && <div className="flex justify-between"><span>Discount</span><span>-{formatMoney(r.discount, currency)}</span></div>}
        {r.tax > 0 && <div className="flex justify-between"><span>Tax</span><span>{formatMoney(r.tax, currency)}</span></div>}
        {r.service > 0 && <div className="flex justify-between"><span>Service</span><span>{formatMoney(r.service, currency)}</span></div>}
        {r.tip > 0 && <div className="flex justify-between"><span>Tip</span><span>{formatMoney(r.tip, currency)}</span></div>}
        <div className="flex justify-between font-semibold text-ink border-t-2 border-dashed border-rule pt-2 mt-1"><span>Total</span><span className="num">{formatMoney(r.total, currency)}</span></div>
      </div>
    </section>
  )
}
