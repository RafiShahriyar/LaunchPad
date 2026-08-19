import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type {
  BackupFinishedEvent,
  BackupSkipReason,
  BackupUsage,
  RestoreResult
} from '@shared/ipc'
import type { SaveBackup } from '@shared/types'
import { unwrap, type AsyncStatus } from '../asyncStatus'

/** Backup snapshots, keyed by game id for the same reason as sessions. */
export interface SavesState {
  byGameId: Record<number, SaveBackup[]>
  usageByGameId: Record<number, BackupUsage>
  totalUsage: BackupUsage | null
  status: AsyncStatus
  error: string | null
  /** Game ids with a backup in flight; disables the button and shows a spinner. */
  busyGameIds: number[]
  /**
   * Last backup outcome, for the transient status line. Holds skips as well as
   * successes, because "nothing changed, so nothing was copied" is information
   * the user needs -- otherwise pressing Back up now looks like it did nothing.
   */
  lastOutcome: {
    gameId: number
    message: string
    tone: 'success' | 'info' | 'error'
  } | null
  /** Set while a restore is running, to lock the dialog and disable actions. */
  restoringBackupId: number | null
  restoreError: string | null
  /** Kept after a successful restore so the UI can point at the undo snapshot. */
  lastRestore: RestoreResult | null
}

const initialState: SavesState = {
  byGameId: {},
  usageByGameId: {},
  totalUsage: null,
  status: 'idle',
  error: null,
  busyGameIds: [],
  lastOutcome: null,
  restoringBackupId: null,
  restoreError: null,
  lastRestore: null
}

// --- Thunks ------------------------------------------------------------------

export const fetchBackups = createAsyncThunk('saves/fetchForGame', (gameId: number) =>
  unwrap(window.api.saves.listForGame(gameId))
)

export const backupNow = createAsyncThunk('saves/backupNow', (gameId: number) =>
  unwrap(window.api.saves.backupNow(gameId))
)

export const setBackupPinned = createAsyncThunk(
  'saves/setPinned',
  (args: { backupId: number; isPinned: boolean }) =>
    unwrap(window.api.saves.setPinned(args.backupId, args.isPinned))
)

export const deleteBackup = createAsyncThunk(
  'saves/delete',
  async (args: { backupId: number; gameId: number }) => {
    await unwrap(window.api.saves.remove(args.backupId))
    return args
  }
)

export const restoreBackup = createAsyncThunk('saves/restore', (backupId: number) =>
  unwrap(window.api.saves.restore(backupId))
)

export const fetchBackupUsage = createAsyncThunk('saves/fetchUsage', (gameId?: number) =>
  unwrap(window.api.saves.getUsage(gameId)).then((usage) => ({ gameId, usage }))
)

/** Human-readable explanation for each skip reason. */
const SKIP_MESSAGES: Record<BackupSkipReason, string> = {
  no_save_folder_configured:
    'No save folder is set for this game, so there is nothing to back up. Add one in Edit.',
  save_folder_missing:
    'The save folder does not exist yet — most games create it the first time you play.',
  save_folder_empty: 'The save folder is empty, so no snapshot was taken.',
  unchanged_since_last_backup: 'Saves have not changed since the last backup.'
}

const savesSlice = createSlice({
  name: 'saves',
  initialState,
  reducers: {
    lastOutcomeCleared(state) {
      state.lastOutcome = null
    },
    restoreErrorCleared(state) {
      state.restoreError = null
    },
    lastRestoreCleared(state) {
      state.lastRestore = null
    },

    /**
     * Dispatched by the event bridge for every backup, including the automatic
     * pre-launch and post-session ones the renderer never requested.
     */
    backupFinished(state, action: PayloadAction<BackupFinishedEvent>) {
      const { gameId, outcome, error } = action.payload
      state.busyGameIds = state.busyGameIds.filter((id) => id !== gameId)

      if (error) {
        state.lastOutcome = { gameId, message: `Backup failed: ${error}`, tone: 'error' }
        return
      }

      if (outcome.status === 'skipped') {
        state.lastOutcome = { gameId, message: SKIP_MESSAGES[outcome.reason], tone: 'info' }
        return
      }

      // Prepend the new snapshot and drop the ones rotation deleted, so the
      // cached history matches disk without a refetch.
      const history = state.byGameId[gameId]
      if (history) {
        const rotatedOut = new Set(outcome.rotatedIds)
        state.byGameId[gameId] = [
          outcome.backup,
          ...history.filter((backup) => !rotatedOut.has(backup.id))
        ]
      }

      const rotated = outcome.rotatedIds.length
      state.lastOutcome = {
        gameId,
        message:
          rotated > 0
            ? `Backup saved. ${rotated} old snapshot${rotated === 1 ? '' : 's'} rotated out.`
            : 'Backup saved.',
        tone: 'success'
      }
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchBackups.pending, (state) => {
        state.status = 'loading'
        state.error = null
      })
      .addCase(fetchBackups.fulfilled, (state, action) => {
        state.status = 'succeeded'
        state.byGameId[action.meta.arg] = action.payload
      })
      .addCase(fetchBackups.rejected, (state, action) => {
        state.status = 'failed'
        state.error = action.error.message ?? 'Failed to load backups'
      })

      .addCase(backupNow.pending, (state, action) => {
        if (!state.busyGameIds.includes(action.meta.arg)) state.busyGameIds.push(action.meta.arg)
        state.lastOutcome = null
      })
      .addCase(backupNow.fulfilled, (state, action) => {
        // The push event carries the detail and does the state update; this
        // only needs to clear the busy flag, and does so defensively in case
        // the event is somehow missed.
        state.busyGameIds = state.busyGameIds.filter((id) => id !== action.meta.arg)
      })
      .addCase(backupNow.rejected, (state, action) => {
        state.busyGameIds = state.busyGameIds.filter((id) => id !== action.meta.arg)
        state.lastOutcome = {
          gameId: action.meta.arg,
          message: `Backup failed: ${action.error.message ?? 'unknown error'}`,
          tone: 'error'
        }
      })

      .addCase(setBackupPinned.fulfilled, (state, action) => {
        const updated = action.payload
        const history = state.byGameId[updated.gameId]
        if (!history) return
        const index = history.findIndex((backup) => backup.id === updated.id)
        if (index >= 0) history[index] = updated
      })

      .addCase(deleteBackup.fulfilled, (state, action) => {
        const history = state.byGameId[action.payload.gameId]
        if (history) {
          state.byGameId[action.payload.gameId] = history.filter(
            (backup) => backup.id !== action.payload.backupId
          )
        }
      })

      .addCase(restoreBackup.pending, (state, action) => {
        state.restoringBackupId = action.meta.arg
        state.restoreError = null
      })
      .addCase(restoreBackup.fulfilled, (state, action) => {
        state.restoringBackupId = null
        state.lastRestore = action.payload
        // The pre_restore snapshot arrives via the backupFinished push, so the
        // history list updates itself; nothing to merge here.
      })
      .addCase(restoreBackup.rejected, (state, action) => {
        state.restoringBackupId = null
        state.restoreError = action.error.message ?? 'Restore failed'
      })

      .addCase(fetchBackupUsage.fulfilled, (state, action) => {
        const { gameId, usage } = action.payload
        if (gameId === undefined) state.totalUsage = usage
        else state.usageByGameId[gameId] = usage
      })
  }
})

export const { lastOutcomeCleared, restoreErrorCleared, lastRestoreCleared, backupFinished } =
  savesSlice.actions
export default savesSlice.reducer

// --- Selectors ---------------------------------------------------------------

export const selectBackupsForGame = (
  state: { saves: SavesState },
  gameId: number
): SaveBackup[] => state.saves.byGameId[gameId] ?? []

export const selectIsBackupBusy = (state: { saves: SavesState }, gameId: number): boolean =>
  state.saves.busyGameIds.includes(gameId)
