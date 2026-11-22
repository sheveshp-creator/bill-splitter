import QRCode from 'qrcode'
import { useEffect, useState } from 'react'

export default function QR({ text, size = 240, label }: { text: string; size?: number; label: string }) {
  const [url, setUrl] = useState('')
  useEffect(() => { void QRCode.toDataURL(text, { width: size * 2, margin: 1, errorCorrectionLevel: 'M' }).then(setUrl) }, [text, size])
  return url ? <img src={url} width={size} height={size} alt={label} className="mx-auto rounded-xl bg-white p-2" /> : <div style={{ width: size, height: size }} className="mx-auto" aria-busy />
}
