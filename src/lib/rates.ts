import { db } from '../db/db'

/** Free, keyless ECB rates (frankfurter.app). Cached in IndexedDB; manual entry always possible. */
export async function getRate(from: string, to: string): Promise<{ rate: number; source: 'live' | 'cached' } | null> {
  if (from === to) return { rate: 1, source: 'live' }
  const key = `${from}>${to}`
  try {
    if (navigator.onLine) {
      const res = await fetch(`https://api.frankfurter.app/latest?from=${from}&to=${to}`)
      if (res.ok) {
        const j = (await res.json()) as { rates?: Record<string, number> }
        const rate = j.rates?.[to]
        if (rate && rate > 0) { await db.rates.put({ key, rate, fetchedAt: new Date().toISOString() }); return { rate, source: 'live' } }
      }
    }
  } catch { /* offline or unsupported pair */ }
  const c = await db.rates.get(key)
  return c ? { rate: c.rate, source: 'cached' } : null
}
