import { useEffect, useState } from 'react'
import 'leaflet/dist/leaflet.css'
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import { useCrisisData } from '../../hooks/useCrisisData'
import { useCrisisStore } from '../../store/crisisStore'
import { usePostStore } from '../../store/postStore'
import { useLocationStore } from '../../store/locationStore'
import { useMapStore } from '../../store/mapStore'
import PostClusters from './cluster'
import HeatMapLayer from './heatMapLayer'

const currentLocationIcon = L.divIcon({
  html: `
    <div style="
      width: 16px;
      height: 16px;
      background-color: #3B82F6;
      border: 3px solid white;
      border-radius: 50%;
      box-shadow: 0 0 0 4px rgba(59,130,246,0.3);
    "></div>
  `,
  className: 'current-location-marker',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
})

function RecenterMap({ position }: { position: [number, number] }) {
  const map = useMap()
  useEffect(() => {
    map.setView(position, map.getZoom())
  }, [])
  return null
}

function RecenterButton({ position }: { position: [number, number] }) {
  const map = useMap()
  return (
    <button
      onClick={() => map.setView(position, map.getZoom())}
      className="absolute bottom-28 right-4 bg-white p-3 rounded-full shadow-lg z-[999]"
      title="Recenter"
    >
      ⊕
    </button>
  )
}

function MapClickDismiss({ onDismiss }: { onDismiss: () => void }) {
  useMapEvents({ click: onDismiss })
  return null
}

const CrisisMap = () => {
  useCrisisData()

  const { crises } = useCrisisStore()
  const { posts } = usePostStore()
  const { currentLocation, getCurrentLocation } = useLocationStore()
  const { showHeatmap, toggleHeatmap } = useMapStore()

  const [activeTooltip, setActiveTooltip] = useState<string | null>(null)
  const [tooltipPosition, setTooltipPosition] = useState<L.LatLng | null>(null)

  useEffect(() => {
    getCurrentLocation()
  }, [])

  const position: [number, number] = currentLocation
    ? [currentLocation.lat, currentLocation.lng]
    : [1.3521, 103.8198]

  return (
    <div className="h-screen w-full relative z-0">
      <MapContainer
        center={position}
        zoom={13}
        scrollWheelZoom
        style={{ height: '100%', width: '100%' }}
        zoomControl={false}
      >
        <TileLayer
          url="https://www.onemap.gov.sg/maps/tiles/Grey/{z}/{x}/{y}.png"
          maxZoom={19}
          minZoom={11}
        />

        <MapClickDismiss
          onDismiss={() => {
            setActiveTooltip(null)
            setTooltipPosition(null)
          }}
        />

        {currentLocation && (
          <>
            <RecenterMap position={position} />
            <Marker position={position} icon={currentLocationIcon} />
          </>
        )}

        {showHeatmap && <HeatMapLayer crises={crises} />}

        <PostClusters
          posts={posts}
          activeTooltip={activeTooltip}
          setActiveTooltip={setActiveTooltip}
          tooltipPosition={tooltipPosition}
          setTooltipPosition={setTooltipPosition}
        />

        <RecenterButton position={position} />
      </MapContainer>

      <button
        onClick={toggleHeatmap}
        className="absolute bottom-10 left-4 px-4 py-2 rounded-full shadow-lg z-[999] text-sm font-medium transition-all duration-200"
        style={
          showHeatmap
            ? { backgroundColor: '#FF5722', color: 'white' }
            : { backgroundColor: 'white', color: '#374151' }
        }
      >
        Heatmap
      </button>
    </div>
  )
}

export default CrisisMap
