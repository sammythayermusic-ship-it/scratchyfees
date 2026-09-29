'use client'

import { useEffect, useId, useState, type ReactNode } from 'react'
import { errorText } from './client'
import { btnDanger, btnOk, btnSmall, ErrorText, inputCls } from './ui'

/** Every mutating admin action goes through one of these. */
export interface ConfirmSpec {
  title: string
  body?: ReactNode
  confirmLabel: string
  tone?: 'danger' | 'ok'
  /** ask for an operator note (sent with the request, recorded in the pause/resume event) */
  note?: { label: string; required: boolean; placeholder?: string; initial?: string }
  /** an "I understand …" checkbox that must be ticked before confirming */
  acknowledge?: string
  /** performs the request; a thrown error keeps the dialog open and is shown verbatim */
  run: (note: string) => Promise<unknown>
  /** success message for the console's flash line */
  success: string
}

const NOTE_MAX = 300

export function ConfirmDialog({
  spec,
  onClose,
  onDone,
}: {
  spec: ConfirmSpec
  onClose: () => void
  onDone: (message: string) => void
}) {
  const titleId = useId()
  const [note, setNote] = useState(spec.note?.initial ?? '')
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const noteOk = !spec.note?.required || note.trim().length > 0
  const ackOk = !spec.acknowledge || ack
  const canConfirm = noteOk && ackOk && !busy

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const confirm = async () => {
    if (!canConfirm) return
    setBusy(true)
    setError(null)
    try {
      await spec.run(note.trim())
      onDone(spec.success)
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-stage/80 p-3 backdrop-blur-sm sm:items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`panel max-h-[90dvh] w-full max-w-lg overflow-y-auto p-5 ${spec.tone === 'danger' ? 'border-red-400/60' : ''}`}
      >
        <h2 id={titleId} className="font-display text-xl text-ink">
          {spec.title}
        </h2>
        {spec.body ? <div className="mt-3 space-y-2 text-sm text-muted">{spec.body}</div> : null}

        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            void confirm()
          }}
        >
          {spec.note ? (
            <label className="block text-sm">
              <span className="mb-1 block text-muted">
                {spec.note.label}
                {spec.note.required ? <span className="text-gold"> (required)</span> : null}
              </span>
              <textarea
                autoFocus
                rows={3}
                maxLength={NOTE_MAX}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={spec.note.placeholder}
                className={inputCls}
                disabled={busy}
              />
              <span className="mt-0.5 block text-right text-[11px] text-muted">
                {note.length}/{NOTE_MAX}
              </span>
            </label>
          ) : null}

          {spec.acknowledge ? (
            <label className="flex items-start gap-2 rounded-xl border border-gold/40 bg-gold/10 p-3 text-sm text-ink">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 accent-[#fbd53f]"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
                disabled={busy}
              />
              <span>{spec.acknowledge}</span>
            </label>
          ) : null}

          {error ? <ErrorText>{error}</ErrorText> : null}

          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            <button type="button" className={btnSmall} onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              autoFocus={!spec.note}
              className={spec.tone === 'danger' ? btnDanger : btnOk}
              disabled={!canConfirm}
            >
              {busy ? 'Working…' : spec.confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
