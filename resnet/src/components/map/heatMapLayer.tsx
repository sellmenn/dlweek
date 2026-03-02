// Requires: npm install leaflet.heat
// (package adds L.heatLayer to leaflet at runtime)
import { useEffect } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import type { Crisis, Severity } from '../../types/crisis'

const INTENSITY: Record<Severity, number> = {
  low: 0.25,
  medium: 0.5,
  high: 0.75,
  critical: 1.0,
}

interface Props {
  crises: Crisis[]
}

export default function HeatMapLayer({ crises }: Props) {
  const map = useMap()

  useEffect(() => {
    if (typeof (L as any).heatLayer === 'undefined') {
      console.warn('leaflet.heat not installed. Run: npm install leaflet.heat')
      return
    }

    const points = crises.map(
      (c) => [c.location.lat, c.location.lng, INTENSITY[c.severity]] as [number, number, number]
    )

    const layer = (L as any).heatLayer(points, {
      radius: 35,
      blur: 20,
      maxZoom: 17,
      gradient: { 0.25: '#4CAF50', 0.5: '#FFC107', 0.75: '#FF5722', 1.0: '#F44336' },
    })

    layer.addTo(map)
    return () => {
      map.removeLayer(layer)
    }
  }, [map, crises])

  return null
}
