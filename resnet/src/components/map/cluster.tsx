import { useEffect, useState, Fragment } from 'react'
import { Marker, Tooltip, useMap } from 'react-leaflet'
import L from 'leaflet'
import type { Post } from '../../types/post'

const MARKER_COLOR = '#8685AD'

const postMarkerIcon = L.divIcon({
  html: `
    <div style="
      width: 20px;
      height: 20px;
      background-color: ${MARKER_COLOR};
      border: 3px solid white;
      border-radius: 50%;
      box-shadow: 0 0 8px ${MARKER_COLOR};
    "></div>
  `,
  className: 'post-marker',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
})

function clusterMarkerIcon(count: number) {
  return L.divIcon({
    html: `
      <div style="position: relative;">
        <div style="
          width: 24px;
          height: 24px;
          background-color: ${MARKER_COLOR};
          border: 3px solid white;
          border-radius: 50%;
          box-shadow: 0 0 8px ${MARKER_COLOR};
        "></div>
        <div style="
          position: absolute;
          top: -8px;
          right: -8px;
          width: 18px;
          height: 18px;
          background-color: #333;
          border: 2px solid white;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: bold;
          color: white;
          font-size: 10px;
        ">${count}</div>
      </div>
    `,
    className: 'cluster-marker',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  })
}

function groupPosts(posts: Post[], zoom: number): Post[][] {
  const threshold = zoom < 13 ? 0.01 : zoom < 15 ? 0.005 : zoom < 17 ? 0.001 : 0.0003
  const clusters: Post[][] = []
  const processed = new Set<number>()

  posts.forEach((post, idx) => {
    if (processed.has(idx)) return
    const cluster = [post]
    processed.add(idx)

    posts.forEach((other, otherIdx) => {
      if (processed.has(otherIdx)) return
      const dist = Math.sqrt(
        Math.pow(post.location.lat - other.location.lat, 2) +
          Math.pow(post.location.lng - other.location.lng, 2)
      )
      if (dist < threshold) {
        cluster.push(other)
        processed.add(otherIdx)
      }
    })

    clusters.push(cluster)
  })

  return clusters
}

interface Props {
  posts: Post[]
  activeTooltip: string | null
  setActiveTooltip: (id: string | null) => void
  tooltipPosition: L.LatLng | null
  setTooltipPosition: (pos: L.LatLng | null) => void
}

export default function PostClusters({
  posts,
  activeTooltip,
  setActiveTooltip,
  tooltipPosition,
  setTooltipPosition,
}: Props) {
  const map = useMap()
  const [zoom, setZoom] = useState(map.getZoom())

  useEffect(() => {
    const onZoom = () => setZoom(map.getZoom())
    map.on('zoom', onZoom)
    return () => {
      map.off('zoom', onZoom)
    }
  }, [map])

  const clusters = groupPosts(posts, zoom)

  const handleClick = (key: string, latlng: L.LatLng) => {
    if (activeTooltip === key) {
      setActiveTooltip(null)
      setTooltipPosition(null)
    } else {
      setActiveTooltip(key)
      setTooltipPosition(latlng)
    }
  }

  return (
    <>
      {clusters.map((cluster, idx) => {
        const centerLat = cluster.reduce((s, p) => s + p.location.lat, 0) / cluster.length
        const centerLng = cluster.reduce((s, p) => s + p.location.lng, 0) / cluster.length
        const key = cluster.length === 1 ? cluster[0].id : `cluster-${idx}`

        return (
          <Fragment key={key}>
            <Marker
              position={[centerLat, centerLng]}
              icon={cluster.length === 1 ? postMarkerIcon : clusterMarkerIcon(cluster.length)}
              eventHandlers={{ click: (e) => handleClick(key, e.latlng) }}
            />

            {activeTooltip === key && tooltipPosition && (
              <Marker
                position={[tooltipPosition.lat, tooltipPosition.lng]}
                icon={L.divIcon({ html: '', className: 'invisible-marker', iconSize: [0, 0] })}
              >
                <Tooltip direction="top" offset={[0, 0]} permanent interactive>
                  {cluster.length === 1 ? (
                    <div className="px-2 py-1 min-w-[140px] max-w-[200px]">
                      {cluster[0].img_url && (
                        <img
                          src={cluster[0].img_url}
                          alt="post"
                          className="w-full h-24 object-cover rounded mb-1"
                        />
                      )}
                      <p className="text-xs text-gray-700">{cluster[0].desc}</p>
                    </div>
                  ) : (
                    <div className="max-h-48 overflow-y-auto min-w-[140px] max-w-[200px]">
                      {cluster.map((p) => (
                        <div key={p.id} className="px-2 py-1.5 border-b last:border-b-0">
                          <p className="text-xs text-gray-700 line-clamp-2">{p.desc}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </Tooltip>
              </Marker>
            )}
          </Fragment>
        )
      })}
    </>
  )
}
