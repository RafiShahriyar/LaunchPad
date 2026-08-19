import { createAsyncThunk, createSlice } from '@reduxjs/toolkit'
import type { AppSettings } from '@shared/types'
import type { AppInfo, OrphanCleanupResult, OrphanScanResult } from '@shared/ipc'
import { unwrap, type AsyncStatus } from '../asyncStatus'

/**
 * First real main<->renderer round trip. Every later thunk follows this exact
 * shape: call the whitelisted preload method, unwrap the IpcResult envelope,
 * let RTK put the payload (or the error message) into the store.
 */
export const fetchAppInfo = createAsyncThunk('settings/fetchAppInfo', () =>
  unwrap(window.api.app.getInfo())
)

export const fetchSettings = createAsyncThunk('settings/fetch', () =>
  unwrap(window.api.settings.get())
)

export const updateSettings = createAsyncThunk(
  'settings/update',
  (patch: Partial<AppSettings>) => unwrap(window.api.settings.update(patch))
)

export const pickBackupsFolder = createAsyncThunk('settings/pickBackupsFolder', () =>
  unwrap(window.api.settings.pickBackupsFolder())
)

export const openBackupsFolder = createAsyncThunk('settings/openBackupsFolder', () =>
  unwrap(window.api.settings.openBackupsFolder())
)

export const scanOrphans = createAsyncThunk('settings/scanOrphans', () =>
  unwrap(window.api.settings.scanOrphans())
)

export const cleanupOrphans = createAsyncThunk('settings/cleanupOrphans', () =>
  unwrap(window.api.settings.cleanupOrphans())
)

export const seedDemoData = createAsyncThunk('settings/seedDemoData', () =>
  unwrap(window.api.settings.seedDemoData())
)

export interface SettingsState {
  settings: AppSettings | null
  appInfo: AppInfo | null
  status: AsyncStatus
  error: string | null
  /** Set while a save is in flight, and cleared on the response. */
  saveStatus: AsyncStatus
  /** Validation message from main, e.g. "Keep at least 1 backup per game." */
  saveError: string | null
  orphanScan: OrphanScanResult | null
  orphanStatus: AsyncStatus
  lastCleanup: OrphanCleanupResult | null
}

const initialState: SettingsState = {
  settings: null,
  appInfo: null,
  status: 'idle',
  error: null,
  saveStatus: 'idle',
  saveError: null,
  orphanScan: null,
  orphanStatus: 'idle',
  lastCleanup: null
}

const settingsSlice = createSlice({
  name: 'settings',
  initialState,
  reducers: {
    saveErrorCleared(state) {
      state.saveError = null
      state.saveStatus = 'idle'
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchAppInfo.pending, (state) => {
        state.status = 'loading'
        state.error = null
      })
      .addCase(fetchAppInfo.fulfilled, (state, action) => {
        state.status = 'succeeded'
        state.appInfo = action.payload
      })
      .addCase(fetchAppInfo.rejected, (state, action) => {
        state.status = 'failed'
        state.error = action.error.message ?? 'Failed to load app info'
      })

      .addCase(fetchSettings.fulfilled, (state, action) => {
        state.settings = action.payload
      })

      .addCase(updateSettings.pending, (state) => {
        state.saveStatus = 'loading'
        state.saveError = null
      })
      .addCase(updateSettings.fulfilled, (state, action) => {
        state.saveStatus = 'succeeded'
        // Replace wholesale with what main returned, never with what was sent:
        // the canonical result may differ from the request if a value was
        // clamped, and showing the request would misreport what the app uses.
        state.settings = action.payload
      })
      .addCase(updateSettings.rejected, (state, action) => {
        state.saveStatus = 'failed'
        state.saveError = action.error.message ?? 'Could not save settings'
      })

      .addCase(scanOrphans.pending, (state) => {
        state.orphanStatus = 'loading'
        state.lastCleanup = null
      })
      .addCase(scanOrphans.fulfilled, (state, action) => {
        state.orphanStatus = 'succeeded'
        state.orphanScan = action.payload
      })
      .addCase(scanOrphans.rejected, (state) => {
        state.orphanStatus = 'failed'
      })

      .addCase(cleanupOrphans.pending, (state) => {
        state.orphanStatus = 'loading'
      })
      .addCase(cleanupOrphans.fulfilled, (state, action) => {
        state.orphanStatus = 'succeeded'
        state.lastCleanup = action.payload
        // The previous scan is stale now; a fresh one is dispatched by the page.
        state.orphanScan = null
      })
  }
})

export const { saveErrorCleared } = settingsSlice.actions
export default settingsSlice.reducer
