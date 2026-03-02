import { create } from 'zustand'

interface Location {
  lat: number
  lng: number
}

interface LocationStore {
  currentLocation: Location | null
  getCurrentLocation: () => void
}

export const useLocationStore = create<LocationStore>((set) => ({
  currentLocation: null,
  getCurrentLocation: () => {
    navigator.geolocation.getCurrentPosition(
      ({ coords }) =>
        set({ currentLocation: { lat: coords.latitude, lng: coords.longitude } }),
      (err) => console.error('Geolocation error:', err)
    )
  },
}))
