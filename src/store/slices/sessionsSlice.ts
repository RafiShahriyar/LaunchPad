import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { SessionEndedEvent, SessionStartedEvent, SessionStats } from '@shared/ipc'
import type { PlaySession } from '@shared/types'
import { unwrap, type AsyncStatus } from '../asyncStatus'

/**
 * Session history is keyed by game id rather than normalised globally, because
 * it is only ever read one game at a time (the detail view). Loading game 3's
 * history should not require holding every other game's history in memory.
 */
export interface SessionsState {
  byGameId: Record<number, PlaySession[]>
  statsByGameId: Record<number, SessionStats>
  status: AsyncStatus
  error: string | null
  /**
   * Open sessions keyed by game id. A map rather than a single value because
   * nothing stops a user launching two games at once, and modelling it as one
   * "current" session would silently drop the second.
   */
  activeByGameId: Record<number, PlaySession>
  /** Last launch failure, surfaced as a dismissible banner. */
  launchError: string | null
  /** Set while a launch request is in flight, to disable the Play button. */
  launchingGameId: number | null
}

const initialState: SessionsState = {
  byGameId: {},
  statsByGameId: {},
  status: 'idle',
  error: null,
  activeByGameId: {},
  launchError: null,
  launchingGameId: null
}

// --- Thunks ------------------------------------------------------------------

export const launchGame = createAsyncThunk('sessions/launch', (gameId: number) =>
  unwrap(window.api.sessions.launch(gameId))
)

export const fetchSessionsForGame = createAsyncThunk('sessions/fetchForGame', (gameId: number) =>
  unwrap(window.api.sessions.listForGame(gameId))
)

export const fetchSessionStats = createAsyncThunk('sessions/fetchStats', (gameId: number) =>
  unwrap(window.api.sessions.getStats(gameId))
)

/**
 * Re-reads which games are actually running.
 *
 * Needed because "what is running" lives in main-process memory, while the
 * store lives in renderer memory. A reload (or a dev hot reload) wipes the
 * latter, and without this the UI would forget that a game is still open.
 */
export const syncRunningGames = createAsyncThunk('sessions/syncRunning', () =>
  unwrap(window.api.sessions.getRunning())
)

const sessionsSlice = createSlice({
  name: 'sessions',
  initialState,
  reducers: {
    launchErrorCleared(state) {
      state.launchError = null
    },

    /** Dispatched by the event bridge when main reports a game has started. */
    sessionStarted(state, action: PayloadAction<SessionStartedEvent>) {
      const { session } = action.payload
      state.activeByGameId[session.gameId] = session
    },

    /**
     * Dispatched by the event bridge when a game process exits.
     *
     * The finished session is prepended to the cached history rather than
     * triggering a refetch: main already sent the row, so a round trip would
     * only re-read what is in hand. Discarded (too-short) sessions clear the
     * active marker without being added to history.
     */
    sessionEnded(state, action: PayloadAction<SessionEndedEvent>) {
      const { gameId, session, discarded } = action.payload
      delete state.activeByGameId[gameId]

      if (discarded || !session) return

      const history = state.byGameId[gameId]
      if (history) history.unshift(session)

      // Cached stats are now stale and cheaper to drop than to recompute here.
      delete state.statsByGameId[gameId]
    },

    /** Replaces the running set wholesale after a resync. */
    runningGamesSynced(state, action: PayloadAction<number[]>) {
      const stillRunning = new Set(action.payload)
      for (const key of Object.keys(state.activeByGameId)) {
        if (!stillRunning.has(Number(key))) delete state.activeByGameId[Number(key)]
      }
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(launchGame.pending, (state, action) => {
        state.launchingGameId = action.meta.arg
        state.launchError = null
      })
      .addCase(launchGame.fulfilled, (state, action) => {
        state.launchingGameId = null
        // The push event also sets this; doing it here too means the button
        // flips to "Playing" without waiting for the broadcast to arrive.
        state.activeByGameId[action.payload.session.gameId] = action.payload.session
      })
      .addCase(launchGame.rejected, (state, action) => {
        state.launchingGameId = null
        state.launchError = action.error.message ?? 'Could not launch the game'
      })

      .addCase(fetchSessionsForGame.pending, (state) => {
        state.status = 'loading'
        state.error = null
      })
      .addCase(fetchSessionsForGame.fulfilled, (state, action) => {
        state.status = 'succeeded'
        state.byGameId[action.meta.arg] = action.payload
      })
      .addCase(fetchSessionsForGame.rejected, (state, action) => {
        state.status = 'failed'
        state.error = action.error.message ?? 'Failed to load session history'
      })

      .addCase(fetchSessionStats.fulfilled, (state, action) => {
        state.statsByGameId[action.meta.arg] = action.payload
      })

      .addCase(syncRunningGames.fulfilled, (state, action) => {
        const stillRunning = new Set(action.payload)
        for (const key of Object.keys(state.activeByGameId)) {
          if (!stillRunning.has(Number(key))) delete state.activeByGameId[Number(key)]
        }
      })
  }
})

export const { launchErrorCleared, sessionStarted, sessionEnded, runningGamesSynced } =
  sessionsSlice.actions

export default sessionsSlice.reducer

// --- Selectors ---------------------------------------------------------------

export const selectIsGameRunning = (state: { sessions: SessionsState }, gameId: number): boolean =>
  state.sessions.activeByGameId[gameId] !== undefined

export const selectRunningCount = (state: { sessions: SessionsState }): number =>
  Object.keys(state.sessions.activeByGameId).length
