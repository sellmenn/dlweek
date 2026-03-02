import { create } from 'zustand'

interface MapStore {
  showHeatmap: boolean
  toggleHeatmap: () => void
}

export const useMapStore = create<MapStore>((set) => ({
  showHeatmap: false,
  toggleHeatmap: () => set((state) => ({ showHeatmap: !state.showHeatmap })),
}))
