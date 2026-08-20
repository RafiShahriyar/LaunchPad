import { ALL_THEME_IDS, type ThemeId } from '@shared/types'

/**
 * Display metadata for the theme picker.
 *
 * Renderer-local on purpose. Main and the database need to know which theme ids
 * are VALID -- that is the shared contract in `@shared/types` -- but they have
 * no use for a human label, and putting presentation strings in the IPC surface
 * would mean a copy change is a change to the process boundary.
 *
 * Note what is absent: colours. A swatch renders its palette by wrapping itself
 * in `data-theme`, so the real CSS values paint it. Listing hexes here would be
 * a second copy of every palette, guaranteed to drift from index.css.
 */
export interface ThemeDescriptor {
  id: ThemeId
  label: string
  description: string
}

/**
 * A Record over ThemeId, so adding a theme without labelling it is a compile
 * error rather than a blank row in the picker.
 */
const THEME_METADATA: Record<ThemeId, Omit<ThemeDescriptor, 'id'>> = {
  dark: {
    label: 'Midnight',
    description: 'The original — cool blue-black, blue accent.'
  },
  nebula: {
    label: 'Nebula',
    description: 'Neutral near-black, violet accent.'
  },
  ember: {
    label: 'Ember',
    description: 'Warm charcoal, orange accent.'
  },
  verdant: {
    label: 'Verdant',
    description: 'Deep green-black, teal accent.'
  }
}

/**
 * Ordered from the shared enumeration rather than from this file's key order,
 * so the picker and the validator can never disagree about which themes exist.
 */
export const THEMES: readonly ThemeDescriptor[] = ALL_THEME_IDS.map((id) => ({
  id,
  ...THEME_METADATA[id]
}))
