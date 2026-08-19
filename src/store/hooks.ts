import { useDispatch, useSelector } from 'react-redux'
import type { AppDispatch, RootState } from './store'

/**
 * Pre-typed hooks. Components must use these instead of the raw react-redux
 * ones so that `dispatch(someThunk())` type-checks and selectors know RootState.
 */
export const useAppDispatch = useDispatch.withTypes<AppDispatch>()
export const useAppSelector = useSelector.withTypes<RootState>()
