import {
  createAsyncThunk,
  createEntityAdapter,
  createSelector,
  createSlice,
  type EntityState,
  type PayloadAction
} from '@reduxjs/toolkit'
import type { DeleteGameOptions, DeleteGameResult, DirectoryPurpose } from '@shared/ipc'
import type { Game, GameUpdate, LibrarySortKey, NewGame, SortDirection } from '@shared/types'
import type { RootState } from '../store'
import { unwrap, type AsyncStatus } from '../asyncStatus'

/**
 * Games are stored normalised (byId + ids) via createEntityAdapter.
 *
 * Why normalised: the library grid, the detail view and the session list all
 * reference the same game. Keeping one canonical copy keyed by id means a
 * playtime update after a session touches exactly one object, and every view
 * re-renders from it. A plain array would force linear scans on every lookup
 * and make "update game 7" an index-hunting exercise.
 */
export const gamesAdapter = createEntityAdapter<Game>()

// --- Thunks ------------------------------------------------------------------

export const fetchGames = createAsyncThunk('games/fetchAll', () => unwrap(window.api.games.list()))

export const createGame = createAsyncThunk('games/create', (input: NewGame) =>
  unwrap(window.api.games.create(input))
)

export const updateGame = createAsyncThunk(
  'games/update',
  (args: { id: number; patch: GameUpdate }) => unwrap(window.api.games.update(args.id, args.patch))
)

/**
 * Resolves to the id alongside the result: the reducer needs the id to remove
 * the entity, and DeleteGameResult deliberately does not carry it (the main
 * process already knows which row it deleted).
 */
export const deleteGame = createAsyncThunk(
  'games/delete',
  async (args: { id: number; options: DeleteGameOptions }) => {
    const result = await unwrap(window.api.games.remove(args.id, args.options))
    return { id: args.id, result }
  }
)

// File pickers are thunks rather than direct calls from components so that
// every main-process interaction goes through the same audited path.
export const pickExecutable = createAsyncThunk('games/pickExecutable', () =>
  unwrap(window.api.games.pickExecutable())
)

export const pickDirectory = createAsyncThunk('games/pickDirectory', (purpose: DirectoryPurpose) =>
  unwrap(window.api.games.pickDirectory(purpose))
)

export const pickCoverImage = createAsyncThunk('games/pickCoverImage', () =>
  unwrap(window.api.games.pickCoverImage())
)

// --- Slice -------------------------------------------------------------------

interface GamesExtraState {
  status: AsyncStatus
  error: string | null
  /** Set while an add/edit/delete is in flight, so the form can disable submit. */
  mutationStatus: AsyncStatus
  mutationError: string | null
  /** Outcome of the last delete, so the UI can report kept or failed backup folders. */
  lastDeleteResult: DeleteGameResult | null
}

// Note: which games are RUNNING is not stored here. sessionsSlice.activeByGameId
// owns that, because a run is a property of a session, not of a game. Mirroring
// it into this slice would be duplicated state with two writers.

export type GamesState = EntityState<Game, number> & GamesExtraState

const initialState: GamesState = gamesAdapter.getInitialState<GamesExtraState>({
  status: 'idle',
  error: null,
  mutationStatus: 'idle',
  mutationError: null,
  lastDeleteResult: null
})

const gamesSlice = createSlice({
  name: 'games',
  initialState,
  reducers: {
    /**
     * Applies a game update that originated in main rather than from a thunk --
     * currently the refreshed playtime roll-up that arrives with a session-end
     * event. Named for its origin so it is obvious in devtools that this write
     * did not come from a user action in this window.
     */
    gameUpdatedExternally(state, action: PayloadAction<Game>) {
      gamesAdapter.setOne(state, action.payload)
    },

    /** Clears a stale error when the form is reopened. */
    mutationErrorCleared(state) {
      state.mutationError = null
      state.mutationStatus = 'idle'
    },
    lastDeleteResultCleared(state) {
      state.lastDeleteResult = null
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchGames.pending, (state) => {
        state.status = 'loading'
        state.error = null
      })
      .addCase(fetchGames.fulfilled, (state, action) => {
        state.status = 'succeeded'
        // setAll, not addMany: main is authoritative, so a game deleted outside
        // this window must disappear rather than linger in the store.
        gamesAdapter.setAll(state, action.payload)
      })
      .addCase(fetchGames.rejected, (state, action) => {
        state.status = 'failed'
        state.error = action.error.message ?? 'Failed to load games'
      })

      .addCase(createGame.fulfilled, (state, action) => {
        state.mutationStatus = 'succeeded'
        gamesAdapter.addOne(state, action.payload)
      })
      .addCase(updateGame.fulfilled, (state, action) => {
        state.mutationStatus = 'succeeded'
        gamesAdapter.setOne(state, action.payload)
      })
      .addCase(deleteGame.fulfilled, (state, action) => {
        state.mutationStatus = 'succeeded'
        gamesAdapter.removeOne(state, action.payload.id)
        state.lastDeleteResult = action.payload.result
      })

      // One matcher per lifecycle phase instead of three cases per thunk: all
      // three mutations share the same pending/failed handling, and adding a
      // fourth mutation later needs no new wiring here.
      .addMatcher(
        (action) =>
          [createGame.pending.type, updateGame.pending.type, deleteGame.pending.type].includes(
            action.type
          ),
        (state) => {
          state.mutationStatus = 'loading'
          state.mutationError = null
        }
      )
      .addMatcher(
        (action) =>
          [createGame.rejected.type, updateGame.rejected.type, deleteGame.rejected.type].includes(
            action.type
          ),
        (state, action) => {
          state.mutationStatus = 'failed'
          state.mutationError =
            (action as { error?: { message?: string } }).error?.message ?? 'Operation failed'
        }
      )
  }
})

export const { gameUpdatedExternally, mutationErrorCleared, lastDeleteResultCleared } =
  gamesSlice.actions
export default gamesSlice.reducer

// --- Selectors ---------------------------------------------------------------

export const {
  selectAll: selectAllGames,
  selectById: selectGameById,
  selectTotal: selectGameCount
} = gamesAdapter.getSelectors<RootState>((state) => state.games)

/**
 * Sorting and filtering live in a memoised selector rather than in the
 * component, so the work is skipped entirely when an unrelated slice changes
 * (which happens on every session tick once step 4 lands).
 */
export const selectVisibleGames = createSelector(
  [
    selectAllGames,
    (state: RootState) => state.ui.searchQuery,
    (state: RootState) => state.ui.sortKey,
    (state: RootState) => state.ui.sortDirection
  ],
  (games, query, sortKey, direction) => {
    const normalisedQuery = query.trim().toLowerCase()
    const filtered = normalisedQuery
      ? games.filter((game) => game.name.toLowerCase().includes(normalisedQuery))
      : games

    const sorted = [...filtered].sort((a, b) => compareGames(a, b, sortKey))
    return direction === 'asc' ? sorted : sorted.reverse()
  }
)

function compareGames(a: Game, b: Game, key: LibrarySortKey): number {
  switch (key) {
    case 'name':
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    case 'playtime':
      return a.totalPlaytimeSeconds - b.totalPlaytimeSeconds
    case 'lastPlayed':
      // Never-played games sort as oldest rather than being dropped or floated
      // to the top, so "recently played" reads correctly on a fresh library.
      return (a.lastPlayedAt ?? '').localeCompare(b.lastPlayedAt ?? '')
    case 'dateAdded':
      return a.createdAt.localeCompare(b.createdAt)
    default:
      return 0
  }
}

export type { SortDirection }
