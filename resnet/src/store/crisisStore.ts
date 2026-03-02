import { create } from 'zustand'
import type { Crisis } from '../types/crisis'

interface CrisisStore {
  crises: Crisis[]
  loading: boolean
  setCrises: (crises: Crisis[]) => void
  setLoading: (loading: boolean) => void
}

export const useCrisisStore = create<CrisisStore>((set) => ({
  crises: [],
  loading: false,
  setCrises: (crises) => set({ crises }),
  setLoading: (loading) => set({ loading }),
}))
