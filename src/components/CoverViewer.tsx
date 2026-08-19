import { useEffect } from 'react'

interface CoverViewerProps {
  /** Managed `lpasset://` URL or a `data:` URI. Never a remote URL. */
  src: string
  title: string
  onClose: () => void
}

/**
 * Full-size cover viewer.
 *
 * Deliberately NOT part of `uiSlice`'s modal union. That union exists to make
 * two simultaneously-open dialogs unrepresentable, and this is opened from
 * inside the game form — it is a detail *of* that dialog, not a competing one.
 * Registering it as a modal would either close the form underneath or break the
 * invariant it protects.
 *
 * It therefore renders at `z-60`, one layer above `Modal`'s `z-50`, and manages
 * its own Escape handling.
 */
export function CoverViewer({ src, title, onClose }: CoverViewerProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      /*
       * Stops the Modal underneath from also seeing this Escape and closing the
       * whole form. Both listen on `document`, so without this one keypress
       * would dismiss the viewer AND discard everything the user had typed.
       */
      event.stopPropagation()
      onClose()
    }
    // Capture phase: Modal's own document listener is registered first, and a
    // bubble-phase listener here would run after it has already closed the form.
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-black/85 p-8"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label={`Cover image for ${title}`}
    >
      <img
        src={src}
        alt={`Cover image for ${title}`}
        className="max-h-[80vh] max-w-full rounded-lg border border-surface-600 object-contain shadow-2xl"
      />
      <div className="mt-4 flex items-center gap-4">
        <p className="text-sm text-slate-400">{title}</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close cover viewer"
          className="rounded-lg bg-surface-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-surface-600"
        >
          Close
        </button>
      </div>
    </div>
  )
}

/**
 * The empty state for artwork.
 *
 * Says "No cover image" in words rather than showing only a glyph. A bare
 * placeholder is ambiguous — it reads equally as "this game has no art" and as
 * "the art failed to load", and the app should not leave the user guessing which.
 */
export function NoCover({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className="grid h-full w-full place-items-center bg-surface-900 text-center"
      data-testid="no-cover"
    >
      <div className="px-2">
        <div className={compact ? 'text-xl text-slate-700' : 'text-3xl text-slate-700'}>▦</div>
        {!compact && <p className="mt-1 text-[11px] leading-tight text-slate-600">No cover image</p>}
      </div>
    </div>
  )
}
