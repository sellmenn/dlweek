import {Marker, Popup} from 'react-leaflet'
import L from 'leaflet'
import type { Post } from '../../types/post'
import type { Cluster } from '../../types/cluster'

interface Props {
  posts: Post[]
  clusters: Record<string, Cluster>
}

const makeGlowIcon = (color: string) => L.divIcon({
  html: `
    <div style="
      width: 12px;
      height: 12px;
      background-color: ${color};
      border-radius: 50%;
      box-shadow: 0 0 8px 4px ${color};
    "></div>
  `,
  className: '',
  iconSize: [12, 12],
  iconAnchor: [6, 6],
})

const GLOW_ICONS = {
  severe:         makeGlowIcon('#ef4444'),
  mild:           makeGlowIcon('#f59e0b'),
  little_or_none: makeGlowIcon('#22c55e'),
}

export default function PostMarkers({ posts, clusters }: Props) {
  return (
      <>
        {posts.map((post, idx) => {
          const cluster = clusters[String(post.cluster)]
          if (!cluster || !cluster.severity_class) return null

          const icon = GLOW_ICONS[cluster.severity_class]

          return (
              <Marker
                  key={idx}
                  position={[post.lat, post.lon]}
                  icon={icon}
              >
                <Popup offset={[0, -10]}>
                  <div>
                    <strong>{cluster.name}</strong>
                    <p style={{ margin: '2px 0', fontSize: '12px' }}>{post.caption}</p>
                    <span style={{ fontSize: '11px', color: '#888' }}>{post.date}</span>
                  </div>
                </Popup>
              </Marker>
          )
        })}
      </>
  )
}