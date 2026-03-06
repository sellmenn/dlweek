import { useEffect, useRef } from 'react'
import { Marker, Popup } from 'react-leaflet'
import L from 'leaflet'
import type { Post, AnalyzedPost } from '../../types/post'
import type { Cluster } from '../../types/cluster'
import { glassStyle } from '../widgets/glassCard'

const CATEGORIES = ['infrastructure', 'food', 'shelter', 'sanitation_water', 'medication']
const BAR_COLORS: Record<string, string> = {
  infrastructure: '#e74c3c',
  food: '#f39c12',
  shelter: '#3498db',
  sanitation_water: '#2ecc71',
  medication: '#9b59b6',
}
const BAR_TEXT_COLORS: Record<string, string> = {
  infrastructure: '#ff6b5b',
  food: '#ffc04d',
  shelter: '#5dade2',
  sanitation_water: '#58d68d',
  medication: '#c39bd3',
}
const SEV_COLORS: Record<string, string> = {
  little_or_none: '#22c55e',
  mild: '#f59e0b',
  severe: '#ef4444',
}
const SEV_TEXT_COLORS: Record<string, string> = {
  little_or_none: '#4ade80',
  mild: '#fbbf24',
  severe: '#f87171',
}

interface Props {
  posts: Post[]
  clusters: Record<string, Cluster>
  onPostClick?: (post: Post) => void
  analyzedPosts?: AnalyzedPost[]
  selectedPostKey?: string | null
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

const GLOW_ICONS: Record<string, L.DivIcon> = {
  severe:         makeGlowIcon('#ef4444'),
  mild:           makeGlowIcon('#f59e0b'),
  little_or_none: makeGlowIcon('#22c55e'),
}

const DEFAULT_ICON = makeGlowIcon('#8899aa')

function getIcon(cluster: Cluster | undefined) {
  if (!cluster?.combined_severity) return DEFAULT_ICON
  return GLOW_ICONS[cluster.combined_severity] ?? DEFAULT_ICON
}

function PostMarker({ post, cluster, onClick, analyzed, isSelected }: { post: Post; cluster: Cluster; onClick?: () => void; analyzed?: AnalyzedPost; isSelected?: boolean }) {
  const markerRef = useRef<L.Marker>(null)

  useEffect(() => {
    if (markerRef.current) {
      markerRef.current.setIcon(getIcon(cluster))
    }
  }, [cluster?.combined_severity])

  useEffect(() => {
    if (isSelected && markerRef.current) {
      markerRef.current.openPopup()
    }
  }, [isSelected])

  useEffect(() => {
    if (markerRef.current) {
      const el = markerRef.current.getElement()
      if (el) el.style.opacity = analyzed && !analyzed.informative ? '0.35' : '1'
    }
  }, [analyzed?.informative])

  return (
    <Marker
      ref={markerRef}
      position={[post.lat, post.lon]}
      icon={getIcon(cluster)}
    >
      <Popup offset={[0, -10]} className="dark-popup">
        <div style={{
          ...glassStyle,
          background: 'rgba(255,255,255,0.07)',
          borderRadius: 10, color: '#e0e0e0',
          fontFamily: '"Outfit", sans-serif',
          minWidth: 220, maxWidth: 280, overflow: 'hidden',
        }}>
          {post.image && (
            <img
              src={post.image}
              alt=""
              style={{ width: '100%', maxHeight: 160, objectFit: 'cover', display: 'block' }}
              onLoad={() => {
                markerRef.current?.getPopup()?.update()
              }}
            />
          )}
          <div style={{ padding: '8px 12px' }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{cluster.name}</div>
            <p style={{ margin: '4px 0', fontSize: 11, color: '#e0e0e0', lineHeight: 1.4 }}>{post.caption}</p>
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)' }}>{post.date}</span>

            {analyzed && (
              <>
                <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
                  {CATEGORIES.map(cat => {
                    const val = analyzed.scores[cat] ?? 0
                    return (
                      <span key={cat} style={{
                        fontSize: 9, padding: '2px 6px', borderRadius: 4,
                        background: `${BAR_COLORS[cat]}55`, color: BAR_TEXT_COLORS[cat],
                        fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                      }}>
                        {cat.replace(/_/g, ' ')} {val.toFixed(2)}
                      </span>
                    )
                  })}
                </div>
                <div style={{ marginTop: 6 }}>
                  <span style={{
                    fontSize: 9, padding: '2px 8px', borderRadius: 4, fontWeight: 700,
                    background: `${SEV_COLORS[analyzed.severity_label] ?? '#888'}44`,
                    color: SEV_TEXT_COLORS[analyzed.severity_label] ?? '#555',
                    textTransform: 'uppercase', letterSpacing: 0.3,
                  }}>
                    {analyzed.severity_label?.replace(/_/g, ' ')}
                  </span>
                </div>
              </>
            )}

            {onClick && (
              <button
                onClick={(e) => { e.stopPropagation(); onClick(); }}
                style={{
                  marginTop: 8, width: '100%', padding: '5px 0', borderRadius: 6,
                  border: '1px solid #3a3d4a', background: '#6c63ff', color: '#fff',
                  fontSize: 11, fontWeight: 600, cursor: 'pointer',
                }}
              >
                View Cluster
              </button>
            )}
          </div>
        </div>
      </Popup>
    </Marker>
  )
}

export default function PostMarkers({ posts, clusters, onPostClick, analyzedPosts, selectedPostKey }: Props) {
  // Build a lookup from (lat,lon,caption) to analyzed data
  const analyzedMap = new Map<string, AnalyzedPost>()
  if (analyzedPosts) {
    for (const ap of analyzedPosts) {
      analyzedMap.set(`${ap.lat},${ap.lon},${ap.caption}`, ap)
    }
  }

  return (
    <>
      {posts.map((post, idx) => {
        const cluster = clusters[String(post.cluster)]
        if (!cluster) return null
        const key = `${post.lat},${post.lon},${post.caption}`
        const analyzed = analyzedMap.get(key)
        return <PostMarker key={idx} post={post} cluster={cluster} onClick={onPostClick ? () => onPostClick(post) : undefined} analyzed={analyzed} isSelected={selectedPostKey === key} />
      })}
    </>
  )
}