import { createAsyncThunk, createSlice } from '@reduxjs/toolkit'
import type {
  MetadataApplyOptions,
  MetadataApplyResult,
  MetadataSearchResult,
  MetadataStatus
} from '@shared/ipc'
import type { CredentialProvider, MetadataSource } from '@shared/types'
import { unwrap, type AsyncStatus } from '../asyncStatus'

export const fetchMetadataStatus = createAsyncThunk('metadata/fetchStatus', () =>
  unwrap(window.api.metadata.getStatus())
)

export const saveCredentials = createAsyncThunk(
  'metadata/saveCredentials',
  (input: { provider: CredentialProvider; values: Record<string, string> }) =>
    unwrap(window.api.metadata.setCredentials(input.provider, input.values))
)

export const clearCredentials = createAsyncThunk(
  'metadata/clearCredentials',
  (provider: CredentialProvider) => unwrap(window.api.metadata.clearCredentials(provider))
)

export const searchMetadata = createAsyncThunk('metadata/search', (query: string) =>
  unwrap(window.api.metadata.search(query))
)

export const applyMetadata = createAsyncThunk(
  'metadata/apply',
  (input: { gameId: number; result: MetadataSearchResult; options: MetadataApplyOptions }) =>
    unwrap(window.api.metadata.apply(input.gameId, input.result, input.options))
)

export interface MetadataState {
  status: MetadataStatus | null
  credentialsStatus: AsyncStatus
  credentialsError: string | null
  /** Which provider the last save/clear targeted, so only its row shows an error. */
  credentialsProvider: CredentialProvider | null
  /** Which provider answered the current results, for attribution in the picker. */
  resultSource: MetadataSource | null

  /** The term the newest search was issued for. Used to drop stale responses. */
  query: string
  results: MetadataSearchResult[]
  searchStatus: AsyncStatus
  searchError: string | null
  /**
   * True once a search has completed for the current query.
   *
   * Without it an empty `results` array is ambiguous — it looks the same before
   * the first search as it does after one that matched nothing, and the UI
   * would have to choose between showing "no matches" too early or never.
   */
  searched: boolean

  applyStatus: AsyncStatus
  applyError: string | null
  /**
   * Set when the metadata was written but its cover could not be downloaded.
   * A partial success, so it is surfaced separately from applyError rather than
   * being reported as a failure.
   */
  coverError: string | null
  lastApplied: MetadataApplyResult | null
}

const initialState: MetadataState = {
  status: null,
  credentialsStatus: 'idle',
  credentialsError: null,
  credentialsProvider: null,
  resultSource: null,
  query: '',
  results: [],
  searchStatus: 'idle',
  searchError: null,
  searched: false,
  applyStatus: 'idle',
  applyError: null,
  coverError: null,
  lastApplied: null
}

const metadataSlice = createSlice({
  name: 'metadata',
  initialState,
  reducers: {
    /** Clears the picker when the dialog that owns it opens or closes. */
    searchReset(state) {
      state.query = ''
      state.results = []
      state.searchStatus = 'idle'
      state.searchError = null
      state.searched = false
      state.applyStatus = 'idle'
      state.applyError = null
      state.coverError = null
      state.lastApplied = null
    },
    credentialsErrorCleared(state) {
      state.credentialsError = null
      state.credentialsStatus = 'idle'
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchMetadataStatus.fulfilled, (state, action) => {
        state.status = action.payload
      })

      .addCase(saveCredentials.pending, (state, action) => {
        state.credentialsStatus = 'loading'
        state.credentialsError = null
        state.credentialsProvider = action.meta.arg.provider
      })
      .addCase(saveCredentials.fulfilled, (state, action) => {
        state.credentialsStatus = 'succeeded'
        state.status = action.payload
      })
      .addCase(saveCredentials.rejected, (state, action) => {
        state.credentialsStatus = 'failed'
        state.credentialsProvider = action.meta.arg.provider
        state.credentialsError = action.error.message ?? 'Could not save credentials'
      })

      .addCase(clearCredentials.fulfilled, (state, action) => {
        state.status = action.payload
        state.credentialsStatus = 'idle'
        state.credentialsError = null
        state.credentialsProvider = null
      })

      .addCase(searchMetadata.pending, (state, action) => {
        state.query = action.meta.arg
        state.searchStatus = 'loading'
        state.searchError = null
        state.searched = false
      })
      .addCase(searchMetadata.fulfilled, (state, action) => {
        // Main echoes the query back. A response for anything other than the
        // newest one is discarded: without this an earlier, slower search
        // finishing last would replace the results for the term on screen.
        if (action.payload.query !== state.query) return
        state.searchStatus = 'succeeded'
        state.results = action.payload.results
        state.resultSource = action.payload.source
        state.searched = true
      })
      .addCase(searchMetadata.rejected, (state, action) => {
        if (action.meta.arg !== state.query) return
        state.searchStatus = 'failed'
        state.results = []
        state.searchError = action.error.message ?? 'Search failed'
      })

      .addCase(applyMetadata.pending, (state) => {
        state.applyStatus = 'loading'
        state.applyError = null
        state.coverError = null
      })
      .addCase(applyMetadata.fulfilled, (state, action) => {
        state.applyStatus = 'succeeded'
        state.lastApplied = action.payload
        state.coverError = action.payload.coverError
      })
      .addCase(applyMetadata.rejected, (state, action) => {
        state.applyStatus = 'failed'
        state.applyError = action.error.message ?? 'Could not apply the metadata'
      })
  }
})

export const { searchReset, credentialsErrorCleared } = metadataSlice.actions
export default metadataSlice.reducer
