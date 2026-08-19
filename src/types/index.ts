/**
 * Renderer-facing re-export of the shared domain models.
 *
 * Components import from '@/types' and stay unaware that the definitions are
 * physically shared with the main process.
 */
export type * from '@shared/types'
