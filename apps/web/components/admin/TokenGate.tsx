'use client'

import { useState } from 'react'
import { API_ORIGIN } from '@/lib/config'
import { adminGet, errorText, setAdminToken } from './client'
import { ErrorText, inputCls } from './ui'

/** Paste the ADMIN_TOKEN; it is checked against GET /api/admin/status before being kept (sessionStorage only). */
export function TokenGate() {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const token = value.trim()
    if (!token || busy) return
    setBusy(true)
    setError(null)
    try {
      await adminGet('/status', token)
      setValue('')
      setAdminToken(token)
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-md pt-10">
      <form
        className="panel space-y-4 p-6"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-muted">$SCRATCHY</p>
          <h1 className="font-display text-3xl text-ink">Operator console</h1>
        </div>
        <label className="block text-sm">
          <span className="mb-1 block text-muted">Admin token</span>
          <input
            type="password"
            name="admin-token"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="paste ADMIN_TOKEN"
            className={`${inputCls} font-mono`}
            disabled={busy}
          />
        </label>
        {error ? <ErrorText>{error}</ErrorText> : null}
        <button type="submit" className="btn-gold w-full" disabled={busy || !value.trim()}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
        <p className="text-xs leading-relaxed text-muted">
          Kept in this tab&apos;s sessionStorage only — gone when the tab closes, or use &ldquo;forget
          token&rdquo;. Sent only as the <code className="text-ink">Authorization</code> header to{' '}
          <code className="break-all text-ink">{API_ORIGIN}</code>.
        </p>
      </form>
    </div>
  )
}
