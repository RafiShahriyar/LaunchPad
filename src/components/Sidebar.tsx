import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { libraryOpened, viewChanged } from '@/store/slices/uiSlice'
import { updateSettings } from '@/store/slices/settingsSlice'

const navItems = [
  { view: 'library' as const, label: 'Library', icon: '▦' },
  { view: 'settings' as const, label: 'Settings', icon: '⚙' }
]

/**
 * Collapsible navigation rail.
 *
 * The collapse control lives in the header, beside the logo. An earlier version
 * put it at the bottom of the rail in `slate-600`, which was reported as
 * missing — it was rendered, just dim and far from anything the eye lands on.
 * Top-of-rail placement and a normal foreground colour make it findable, which
 * for a control that changes the whole layout matters more than tidiness.
 *
 * The collapsed state is persisted in settings rather than kept in `uiSlice`
 * alone: a sidebar that silently re-expands on every launch is worse than one
 * that never collapsed, because the preference must be re-applied every time.
 *
 * Collapsed shows icons only at 56px. Labels stay in the DOM as each button's
 * accessible name, so screen readers and tests are unaffected by the visual
 * state, and collapsed buttons gain a tooltip since that becomes the only way
 * to read them.
 */
export function Sidebar() {
  const dispatch = useAppDispatch()
  const activeView = useAppSelector((state) => state.ui.activeView)
  // Falls back to expanded until settings load, which avoids a collapse-then-
  // expand flicker on a slow first paint.
  const collapsed = useAppSelector((state) => state.settings.settings?.sidebarCollapsed ?? false)

  const toggle = () => void dispatch(updateSettings({ sidebarCollapsed: !collapsed }))

  return (
    <aside
      className={`flex shrink-0 flex-col border-r border-surface-700 bg-surface-950 transition-[width] duration-200 ${
        collapsed ? 'w-14' : 'w-56'
      }`}
    >
      {/* Header: logo, name, and the collapse control. Collapsed, the two stack. */}
      <div
        className={`flex py-4 ${
          collapsed ? 'flex-col items-center gap-2 px-0' : 'items-center gap-2 px-4'
        }`}
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-600 text-sm font-bold text-white">
          LP
        </span>
        {!collapsed && (
          <span className="mr-auto truncate text-sm font-semibold tracking-wide text-slate-100">
            LaunchPad
          </span>
        )}
        <CollapseButton collapsed={collapsed} onToggle={toggle} />
      </div>

      <nav className={`flex flex-col gap-1 ${collapsed ? 'px-2' : 'px-3'}`}>
        {navItems.map((item) => {
          // The detail view is a child of the library, so keep Library lit while it is open.
          const isActive =
            activeView === item.view || (item.view === 'library' && activeView === 'gameDetail')
          return (
            <button
              key={item.view}
              onClick={() =>
                dispatch(item.view === 'library' ? libraryOpened() : viewChanged(item.view))
              }
              aria-label={item.label}
              // The tooltip is the only way to read the label when collapsed.
              title={collapsed ? item.label : undefined}
              className={`flex items-center rounded-lg py-2 text-left text-sm transition-colors ${
                collapsed ? 'justify-center px-0' : 'gap-3 px-3'
              } ${
                isActive
                  ? 'bg-surface-800 text-slate-100'
                  : 'text-slate-400 hover:bg-surface-850 hover:text-slate-200'
              }`}
            >
              <span className="text-base leading-none">{item.icon}</span>
              {!collapsed && item.label}
            </button>
          )
        })}
      </nav>
    </aside>
  )
}

function CollapseButton({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      aria-expanded={!collapsed}
      title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-surface-700 text-slate-400 transition-colors hover:border-surface-600 hover:bg-surface-800 hover:text-slate-100"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        className={`transition-transform duration-200 ${collapsed ? 'rotate-180' : ''}`}
      >
        {/* A bar plus a chevron — reads as "panel folds this way". */}
        <path d="M2.5 2.5v11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path
          d="M12.5 5.5L9.5 8l3 2.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}
