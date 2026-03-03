import { create } from 'zustand'
import type { CategoryScores } from '../components/widgets/inferenceWidgets'

interface PredictStore {
  running: boolean
  done: boolean
  current: number
  total: number
  postScores: CategoryScores[]
  clusterScores: Record<string, CategoryScores>
  setRunning: (running: boolean) => void
  setProgress: (current: number, total: number) => void
  setResults: (postScores: CategoryScores[], clusterScores: Record<string, CategoryScores>) => void
  reset: () => void
}

export const usePredictStore = create<PredictStore>((set) => ({
  running: false,
  done: false,
  current: 0,
  total: 0,
  postScores: [],
  clusterScores: {},
  setRunning: (running) => set({ running }),
  setProgress: (current, total) => set({ current, total }),
  setResults: (postScores, clusterScores) => set({ postScores, clusterScores, done: true, running: false }),
  reset: () => set({ running: false, done: false, current: 0, total: 0, postScores: [], clusterScores: {} }),
}))
