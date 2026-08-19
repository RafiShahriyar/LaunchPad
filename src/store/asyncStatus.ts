import type { IpcResult } from '@shared/ipc'

export type AsyncStatus = 'idle' | 'loading' | 'succeeded' | 'failed'

/**
 * Bridges the IpcResult envelope to createAsyncThunk's success/failure model.
 *
 * Main-process handlers return `{ ok: false, error }` rather than throwing (see
 * electron/ipc/handle.ts). Thunks, however, signal failure by rejecting. This
 * converts one convention to the other, so a failed IPC call lands in the
 * thunk's `.rejected` case with a real message in `action.error.message`.
 */
export async function unwrap<T>(call: Promise<IpcResult<T>>): Promise<T> {
  const result = await call
  if (!result.ok) throw new Error(result.error)
  return result.data
}
