import { configureStore } from '@reduxjs/toolkit'
import gamesReducer from './slices/gamesSlice'
import sessionsReducer from './slices/sessionsSlice'
import savesReducer from './slices/savesSlice'
import settingsReducer from './slices/settingsSlice'
import metadataReducer from './slices/metadataSlice'
import uiReducer from './slices/uiSlice'

export const store = configureStore({
  reducer: {
    games: gamesReducer,
    sessions: sessionsReducer,
    saves: savesReducer,
    settings: settingsReducer,
    metadata: metadataReducer,
    ui: uiReducer
  }
  // RTK's default middleware (serializability + immutability checks in dev) is
  // deliberately left on: it is what catches a Date or a Node Buffer sneaking
  // across IPC into the store, which would otherwise fail only at packaging time.
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
