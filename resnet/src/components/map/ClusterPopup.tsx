import { useState } from 'react'
import type { AnalyzedPost } from '../../types/post'
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
const SEV_COLORS: Record<string, string> = {
  little_or_none: '#22c55e',
  mild: '#f59e0b',
  severe: '#ef4444',
}

interface Props {
  cluster: Cluster
  clusterId: string
  posts: AnalyzedPost[]
  onClose: () => void
}

export default function ClusterPopup({ cluster, clusterId, posts, onClose }: Props) {
  const [sortBy, setSortBy] = useState<string>('severity')
  const [expandedPost, setExpandedPost] = useState<number | null>(null)

  const sorted = [...posts].sort((a, b) => {
    if (sortBy === 'severity') {
      const W: Record<string, number> = { little_or_none: 0, mild: 0.5, severe: 1 }
      return (W[b.severity_label] ?? 0) - (W[a.severity_label] ?? 0)
    }
    return (b.scores[sortBy] ?? 0) - (a.scores[sortBy] ?? 0)
  })

  // Cluster-level averages
  const avgScores: Record<string, number> = {}
  CATEGORIES.forEach(cat => {
    const vals = posts.map(p => p.scores[cat] ?? 0)
    avgScores[cat] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
  })

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'absolute', inset: 0, zIndex: 1999,
          background: 'rgba(0,0,0,0.3)',
        }}
      />

      {/* Floating card */}
      <div style={{
        position: 'absolute', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 2000, width: 460, maxHeight: '80vh',
        ...glassStyle,
        borderRadius: 16,
        display: 'flex', flexDirection: 'column',
        color: '#e0e0e0', fontFamily: '"Outfit", sans-serif',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #2a2d3a' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 12, height: 12, borderRadius: '50%',
                background: SEV_COLORS[cluster.combined_severity ?? ''] ?? '#8899aa',
                boxShadow: `0 0 8px ${SEV_COLORS[cluster.combined_severity ?? ''] ?? '#8899aa'}`,
              }} />
              <span style={{ fontSize: 18, fontWeight: 700 }}>{cluster.name}</span>
            </div>
            <button onClick={onClose} style={{
              background: '#1e2130', border: '1px solid #2a2d3a', color: '#888', cursor: 'pointer',
              fontSize: 14, lineHeight: 1, padding: '4px 10px', borderRadius: 6,
            }}>x</button>
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 11, color: '#888' }}>
            <span>Cluster #{clusterId}</span>
            <span>{posts.length} posts</span>
            {cluster.combined_severity && (
              <span style={{
                padding: '1px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600,
                textTransform: 'uppercase', letterSpacing: 0.3,
                background: `${SEV_COLORS[cluster.combined_severity]}22`,
                color: SEV_COLORS[cluster.combined_severity],
              }}>{cluster.combined_severity.replace(/_/g, ' ')}</span>
            )}
          </div>
        </div>

        {/* Cluster-level resource bars */}
        <div style={{ padding: '12px 20px', borderBottom: '1px solid #2a2d3a' }}>
          <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', color: '#888', marginBottom: 8, letterSpacing: 0.5 }}>
            Average Resource Demand
          </div>
          {CATEGORIES.map(cat => (
            <div key={cat} style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ width: 100, fontSize: 11, color: '#aaa', textTransform: 'capitalize' }}>
                {cat.replace(/_/g, ' ')}
              </span>
              <div style={{ flex: 1, height: 6, background: '#262938', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: 3, transition: 'width 0.3s',
                  width: `${(avgScores[cat] * 100).toFixed(1)}%`,
                  background: BAR_COLORS[cat],
                }} />
              </div>
              <span style={{ width: 40, textAlign: 'right', fontSize: 11, color: '#aaa', fontVariantNumeric: 'tabular-nums' }}>
                {avgScores[cat].toFixed(2)}
              </span>
            </div>
          ))}
        </div>

        {/* Sort controls */}
        <div style={{ padding: '8px 20px', borderBottom: '1px solid #2a2d3a', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, color: '#888', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Sort by</span>
          {['severity', ...CATEGORIES].map(cat => (
            <button key={cat} onClick={() => setSortBy(cat)} style={{
              padding: '3px 10px', borderRadius: 4, border: '1px solid',
              borderColor: sortBy === cat ? '#6c63ff' : '#3a3d4a',
              background: sortBy === cat ? '#6c63ff' : '#1e2130',
              color: sortBy === cat ? '#fff' : '#aaa',
              fontSize: 10, cursor: 'pointer', textTransform: 'capitalize',
            }}>
              {cat.replace(/_/g, ' ')}
            </button>
          ))}
        </div>

        {/* Scrollable post list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 20px' }}>
          {sorted.map((post, i) => {
            const isExpanded = expandedPost === i
            return (
              <div
                key={i}
                onClick={() => setExpandedPost(isExpanded ? null : i)}
                style={{
                  background: '#1e2130', border: '1px solid #2a2d3a', borderRadius: 10,
                  marginBottom: 8, overflow: 'hidden', cursor: 'pointer',
                  transition: 'border-color 0.15s',
                  borderColor: isExpanded ? '#3a3d5a' : '#2a2d3a',
                }}
              >
                {/* Post image — shown when expanded */}
                {isExpanded && post.image && (
                  <img
                    src={post.image}
                    alt=""
                    style={{
                      width: '100%', maxHeight: 220, objectFit: 'cover',
                      borderBottom: '1px solid #2a2d3a',
                    }}
                    loading="lazy"
                  />
                )}
                <div style={{ padding: 10, display: 'flex', gap: 10 }}>
                  {/* Thumbnail — shown when collapsed */}
                  {!isExpanded && post.image && (
                    <img
                      src={post.image}
                      alt=""
                      style={{ width: 52, height: 52, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }}
                      loading="lazy"
                    />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{
                      fontSize: 11, color: '#ccc', margin: 0, lineHeight: 1.4,
                      ...(isExpanded ? {} : {
                        overflow: 'hidden', textOverflow: 'ellipsis',
                        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
                      }),
                    }}>
                      {post.caption}
                    </p>
                    <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                      {CATEGORIES.map(cat => {
                        const val = post.scores[cat] ?? 0
                        const isHighlighted = cat === sortBy
                        return (
                          <span key={cat} style={{
                            fontSize: 9, padding: '2px 6px', borderRadius: 4,
                            background: isHighlighted ? `${BAR_COLORS[cat]}33` : '#262938',
                            color: isHighlighted ? BAR_COLORS[cat] : '#888',
                            fontWeight: isHighlighted ? 600 : 400,
                            fontVariantNumeric: 'tabular-nums',
                          }}>
                            {cat.replace(/_/g, ' ').slice(0, 5)} {val.toFixed(2)}
                          </span>
                        )
                      })}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                      <span style={{ fontSize: 10, color: '#666' }}>{post.date}</span>
                      <span style={{
                        fontSize: 9, padding: '1px 6px', borderRadius: 4,
                        background: `${SEV_COLORS[post.severity_label] ?? '#888'}22`,
                        color: SEV_COLORS[post.severity_label] ?? '#888',
                        fontWeight: 600,
                      }}>{post.severity_label?.replace(/_/g, ' ')}</span>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}