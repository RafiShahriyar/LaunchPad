import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { WindowState } from '@shared/ipc'
import type { LibrarySortKey, LibraryViewMode, SortDirection } from '@shared/types'
import { unwrap } from '../asyncStatus'

/** Which top-level screen is showing. Kept in Redux rather than a router so that
 *  navigation is inspectable in devtools and survives hot reload. */
export type ActiveView = 'library' | 'gameDetail' | 'settings'

/** Modals are enumerated rather than booleans so two can never be open at once. */
export type ActiveModal =
  | { kind: 'none' }
  | { kind: 'addGame' }
  | { kind: 'editGame'; gameId: number }
  | { kind: 'deleteGame'; gameId: number }
  | { kind: 'backupHistory'; gameId: number }
  | { kind: 'restoreBackup'; backupId: number }

export interface UiState {
  activeView: ActiveView
  selectedGameId: number | null
  viewMode: LibraryViewMode
  sortKey: LibrarySortKey
  sortDirection: SortDirection
  searchQuery: string
  modal: ActiveModal
  /**
   * Mirror of the real window's chrome state, pushed from main. The title bar
   * needs it to know whether to leave room for native controls (windowed) or
   * take the full width (fullscreen).
   */
  window: WindowState
}

const initialState: UiState = {
  activeView: 'library',
  selectedGameId: null,
  viewMode: 'grid',
  sortKey: 'lastPlayed',
  sortDirection: 'desc',
  searchQuery: '',
  modal: { kind: 'none' },
  // Assumes overlay controls until main says otherwise; corrected on first sync.
  window: {
    isFullScreen: false,
    isMaximized: false,
    needsCustomControls: true,
    platform: 'win32'
  }
}

export const fetchWindowState = createAsyncThunk('ui/fetchWindowState', () =>
  unwrap(window.api.window.getState())
)

export const toggleFullScreen = createAsyncThunk('ui/toggleFullScreen', () =>
  unwrap(window.api.window.toggleFullScreen())
)

export const minimizeWindow = createAsyncThunk('ui/minimizeWindow', () =>
  unwrap(window.api.window.minimize())
)

export const toggleMaximizeWindow = createAsyncThunk('ui/toggleMaximizeWindow', () =>
  unwrap(window.api.window.toggleMaximize())
)

export const closeWindow = createAsyncThunk('ui/closeWindow', () =>
  unwrap(window.api.window.close())
)

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    viewChanged(state, action: PayloadAction<ActiveView>) {
      state.activeView = action.payload
    },
    gameOpened(state, action: PayloadAction<number>) {
      state.selectedGameId = action.payload
      state.activeView = 'gameDetail'
    },
    libraryOpened(state) {
      state.selectedGameId = null
      state.activeView = 'library'
    },
    viewModeChanged(state, action: PayloadAction<LibraryViewMode>) {
      state.viewMode = action.payload
    },
    sortChanged(state, action: PayloadAction<{ key: LibrarySortKey; direction: SortDirection }>) {
      state.sortKey = action.payload.key
      state.sortDirection = action.payload.direction
    },
    searchQueryChanged(state, action: PayloadAction<string>) {
      state.searchQuery = action.payload
    },
    modalOpened(state, action: PayloadAction<ActiveModal>) {
      state.modal = action.payload
    },
    modalClosed(state) {
      state.modal = { kind: 'none' }
    },
    /** Dispatched by the event bridge when main reports a chrome change. */
    windowStateChanged(state, action: PayloadAction<WindowState>) {
      state.window = action.payload
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchWindowState.fulfilled, (state, action) => {
        state.window = action.payload
      })
      .addCase(toggleFullScreen.fulfilled, (state, action) => {
        state.window = action.payload
      })
      .addCase(toggleMaximizeWindow.fulfilled, (state, action) => {
        state.window = action.payload
      })
  }
})

export const {
  viewChanged,
  gameOpened,
  libraryOpened,
  viewModeChanged,
  sortChanged,
  searchQueryChanged,
  modalOpened,
  modalClosed,
  windowStateChanged
} = uiSlice.actions

export default uiSlice.reducer
