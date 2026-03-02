import { create } from "zustand";
import type { Severity } from "../types/crisis";

const ALL_SEVERITIES: Severity[] = ["low", "medium", "high", "critical"];

interface FilterStore {
  activeSeverities: Severity[];
  toggleSeverity: (s: Severity) => void;
  clearFilters: () => void;
}

export const useFilterStore = create<FilterStore>((set) => ({
  activeSeverities: [...ALL_SEVERITIES],
  toggleSeverity: (s) =>
    set((state) => ({
      activeSeverities: state.activeSeverities.includes(s)
        ? state.activeSeverities.filter((x) => x !== s)
        : [...state.activeSeverities, s],
    })),
  clearFilters: () => set({ activeSeverities: [...ALL_SEVERITIES] }),
}));
