import { useEffect, useRef, type ReactNode } from 'react'

interface ModalProps {
  title: string
  description?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** Widens the panel for the game form, which has many fields. */
  size?: 'md' | 'lg'
}

/**
 * Base modal shell: backdrop, Escape to dismiss, and initial focus.
 *
 * Rendered inline rather than through a portal because the app shell has no
 * overflow or stacking contexts that would clip it, and a portal would add a
 * second React root to reason about for no benefit here.
 */
export function Modal({ title, description, onClose, children, footer, size = 'md' }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  useEffect(() => {
    // Move focus into the dialog so keyboard users are not left behind on the
    // page underneath.
    const firstField = panelRef.current?.querySelector<HTMLElement>(
      'input, select, textarea, button'
    )
    firstField?.focus()
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      // Only a click that both starts and ends on the backdrop closes the
      // dialog; without this, releasing a text selection outside the panel
      // would discard the user's input.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`flex max-h-full w-full flex-col overflow-hidden rounded-2xl border border-surface-700 bg-surface-850 shadow-2xl ${
          size === 'lg' ? 'max-w-2xl' : 'max-w-md'
        }`}
      >
        <header className="border-b border-surface-700 px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
          {description && <p className="mt-1 text-sm text-slate-400">{description}</p>}
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>

        {footer && (
          <footer className="flex justify-end gap-3 border-t border-surface-700 px-6 py-4">
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
}) {
  const variants = {
    primary: 'bg-accent-600 text-white hover:bg-accent-500 disabled:bg-accent-600/40',
    secondary:
      'bg-surface-700 text-slate-200 hover:bg-surface-600 disabled:text-slate-500',
    danger: 'bg-red-600 text-white hover:bg-red-500 disabled:bg-red-600/40',
    ghost: 'text-slate-400 hover:bg-surface-800 hover:text-slate-200'
  }

  return (
    <button
      {...props}
      className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${variants[variant]} ${className}`}
    />
  )
}
