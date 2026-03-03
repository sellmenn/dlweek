import { useMemo } from 'react'
import type { AnalyzedPost } from '../../types/post'
import type { Cluster } from '../../types/cluster'
import { GlassCard } from '../widgets/glassCard'
import { CategoryScoreBar, type Category, type CategoryScores } from '../widgets/inferenceWidgets'
import { PostScoreRow } from '../widgets/inferenceWidgets'

const CATEGORIES: Category[] = ['infrastructure', 'food', 'shelter', 'sanitation_water', 'medication']
const CATEGORY_LABELS: Record<Category, string> = {
  infrastructure: 'Infrastructure',
  food: 'Food',
  shelter: 'Shelter',
  sanitation_water: 'Water / Sanitation',
  medication: 'Medication',
}
const SEV_ORDER = ['severe', 'mild', 'little_or_none'] as const
const SEV_COLORS: Record<string, string> = {
  severe: '#ef4444',
  mild: '#f59e0b',
  little_or_none: '#22c55e',
}
const SEV_LABELS: Record<string, string> = {
  severe: 'Severe',
  mild: 'Mild',
  little_or_none: 'Low',
}

interface Props {
  clusters: Record<string, Cluster>
  analyzedPosts: AnalyzedPost[]
  phase: string
  sliderValue: number
  focusedCluster: string | null
  onFocusCluster: (cid: string | null) => void
}

function SeverityBar({ counts, total }: { counts: Record<string, number>; total: number }) {
  if (total === 0) return null
  return (
    <div className="flex h-2.5 w-full rounded-full overflow-hidden bg-white/5">
      {SEV_ORDER.map(sev => {
        const pct = ((counts[sev] ?? 0) / total) * 100
        if (pct === 0) return null
        return (
          <div
            key={sev}
            className="h-full transition-all duration-500"
            style={{ width: `${pct}%`, background: SEV_COLORS[sev] }}
          />
        )
      })}
    </div>
  )
}

export default function AnalysisWidgets({
  clusters, analyzedPosts, phase, sliderValue,
  focusedCluster, onFocusCluster,
}: Props) {
  const visible = phase === 'done'
  const isFocused = focusedCluster !== null

  const activePosts = useMemo(
    () => analyzedPosts.slice(0, sliderValue),
    [analyzedPosts, sliderValue],
  )

  const postsByCluster = useMemo(() => {
    const map: Record<string, AnalyzedPost[]> = {}
    for (const p of activePosts) {
      const cid = String(p.cluster)
      if (cid === '-1') continue
      if (!map[cid]) map[cid] = []
      map[cid].push(p)
    }
    return map
  }, [activePosts])

  const clusterAvgScores = useMemo(() => {
    const result: Record<string, CategoryScores> = {}
    for (const [cid, posts] of Object.entries(postsByCluster)) {
      const avg = {} as CategoryScores
      for (const cat of CATEGORIES) {
        const vals = posts.map(p => p.scores[cat] ?? 0)
        avg[cat] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
      }
      result[cid] = avg
    }
    return result
  }, [postsByCluster])

  // ── Global metrics ──
  const totalPosts = activePosts.length
  const clusterCount = Object.keys(postsByCluster).length

  const globalSevCounts: Record<string, number> = { severe: 0, mild: 0, little_or_none: 0 }
  for (const p of activePosts) {
    globalSevCounts[p.severity_label] = (globalSevCounts[p.severity_label] ?? 0) + 1
  }

  const globalAvg = {} as CategoryScores
  for (const cat of CATEGORIES) {
    const vals = activePosts.map(p => p.scores[cat] ?? 0)
    globalAvg[cat] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
  }
  const globalTopNeed = [...CATEGORIES].sort((a, b) => globalAvg[b] - globalAvg[a])[0]

  const sortedClusterIds = Object.keys(postsByCluster).sort((a, b) => {
    const sevOrder: Record<string, number> = { severe: 0, mild: 1, little_or_none: 2 }
    const sa = clusters[a]?.combined_severity ?? 'little_or_none'
    const sb = clusters[b]?.combined_severity ?? 'little_or_none'
    return (sevOrder[sa] ?? 3) - (sevOrder[sb] ?? 3)
  })

  // ── Focused cluster metrics ──
  const focusedClusterData = focusedCluster ? clusters[focusedCluster] : null
  const focusedPosts = focusedCluster ? (postsByCluster[focusedCluster] ?? []) : []
  const focusedAvg = focusedCluster ? clusterAvgScores[focusedCluster] : null
  const focusedSev = focusedClusterData?.combined_severity ?? ''
  const focusedTopNeed = focusedAvg
    ? [...CATEGORIES].sort((a, b) => (focusedAvg[b] ?? 0) - (focusedAvg[a] ?? 0))[0]
    : null

  const focusedSevCounts: Record<string, number> = { severe: 0, mild: 0, little_or_none: 0 }
  for (const p of focusedPosts) {
    focusedSevCounts[p.severity_label] = (focusedSevCounts[p.severity_label] ?? 0) + 1
  }

  const sortedFocusedPosts = [...focusedPosts].sort((a, b) => {
    const W: Record<string, number> = { little_or_none: 0, mild: 0.5, severe: 1 }
    return (W[b.severity_label] ?? 0) - (W[a.severity_label] ?? 0)
  })

  const showWhen = (show: boolean): React.CSSProperties => ({
    opacity: visible && show ? 1 : 0,
    transform: visible && show ? 'translateX(0)' : 'translateX(-16px)',
    pointerEvents: visible && show ? 'auto' : 'none',
    transition: 'opacity 0.35s ease, transform 0.35s ease',
    position: 'absolute' as const,
    left: 16,
    width: 320,
    zIndex: 1000,
  })

  // ── Cluster top need helper ──
  const clusterTopNeed = (cid: string) => {
    const avg = clusterAvgScores[cid]
    if (!avg) return null
    return [...CATEGORIES].sort((a, b) => (avg[b] ?? 0) - (avg[a] ?? 0))[0]
  }

  return (
    <>
      {/* ════════════ OVERVIEW ════════════ */}

      {/* Widget 1: Summary Stats */}
      <div
        style={{ ...showWhen(!isFocused), top: 16 }}
      >
        <GlassCard className="p-4">
          <p className="text-[10px] text-white/35 uppercase tracking-[2px] mb-3">Overview</p>
          <div className="grid grid-cols-3 gap-3 mb-3">
            <div>
              <p className="text-2xl font-bold text-white leading-none">{totalPosts}</p>
              <p className="text-[10px] text-white/35 mt-1">Posts</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-white leading-none">{clusterCount}</p>
              <p className="text-[10px] text-white/35 mt-1">Clusters</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-white leading-none">
                {globalTopNeed ? CATEGORY_LABELS[globalTopNeed].split('/')[0].trim().slice(0, 6) : '—'}
              </p>
              <p className="text-[10px] text-white/35 mt-1">Top Need</p>
            </div>
          </div>
          <SeverityBar counts={globalSevCounts} total={totalPosts} />
          <div className="flex gap-3 mt-2">
            {SEV_ORDER.map(sev => (
              <span key={sev} className="text-[10px] text-white/40 flex items-center gap-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: SEV_COLORS[sev] }} />
                {globalSevCounts[sev]} {SEV_LABELS[sev]}
              </span>
            ))}
          </div>
        </GlassCard>
      </div>

      {/* Widget 2: Cluster List (scrollable) */}
      <div
        className="flex flex-col"
        style={{ ...showWhen(!isFocused), top: 180, bottom: 110 }}
      >
        <GlassCard className="p-0 flex-1 overflow-hidden flex flex-col">
          <div className="px-4 pt-3 pb-2 flex-shrink-0">
            <p className="text-[10px] text-white/35 uppercase tracking-[2px]">Clusters</p>
          </div>
          <div className="overflow-y-auto flex-1 px-2 pb-2">
            {sortedClusterIds.map(cid => {
              const cluster = clusters[cid]
              if (!cluster) return null
              const posts = postsByCluster[cid] ?? []
              const sev = cluster.combined_severity ?? ''
              const topNeed = clusterTopNeed(cid)

              return (
                <div
                  key={cid}
                  onClick={() => onFocusCluster(cid)}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer hover:bg-white/5 transition-colors duration-150"
                >
                  <div
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{
                      background: SEV_COLORS[sev] ?? '#8899aa',
                      boxShadow: `0 0 6px ${SEV_COLORS[sev] ?? '#8899aa'}`,
                    }}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-semibold text-white truncate">{cluster.name}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-white/30">{posts.length} posts</span>
                      {topNeed && (
                        <span className="text-[10px] text-white/30">
                          Top: {CATEGORY_LABELS[topNeed].split('/')[0].trim()}
                        </span>
                      )}
                    </div>
                  </div>
                  {sev && (
                    <span
                      className="text-[9px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full flex-shrink-0"
                      style={{
                        background: `${SEV_COLORS[sev]}22`,
                        color: SEV_COLORS[sev],
                      }}
                    >
                      {SEV_LABELS[sev]}
                    </span>
                  )}
                  <span className="text-white/20 text-xs flex-shrink-0">›</span>
                </div>
              )
            })}
          </div>
        </GlassCard>
      </div>

      {/* ════════════ FOCUSED ════════════ */}

      {/* Widget 1: Cluster Header */}
      <div
        style={{ ...showWhen(isFocused), top: 16 }}
      >
        <GlassCard className="p-4">
          <button
            onClick={() => onFocusCluster(null)}
            className="text-[11px] font-medium text-white/40 hover:text-white/70 transition-colors mb-2 flex items-center gap-1.5"
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            <span>←</span> All Clusters
          </button>
          {focusedClusterData && (
            <>
              <div className="flex items-center gap-2.5 mb-2">
                <div
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{
                    background: SEV_COLORS[focusedSev] ?? '#8899aa',
                    boxShadow: `0 0 8px ${SEV_COLORS[focusedSev] ?? '#8899aa'}`,
                  }}
                />
                <span className="text-base font-bold text-white">{focusedClusterData.name}</span>
                {focusedSev && (
                  <span
                    className="text-[9px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ml-auto"
                    style={{
                      background: `${SEV_COLORS[focusedSev]}22`,
                      color: SEV_COLORS[focusedSev],
                    }}
                  >
                    {SEV_LABELS[focusedSev]}
                  </span>
                )}
              </div>
              <div className="flex gap-4 text-[10px] text-white/35">
                <span>{focusedPosts.length} posts</span>
                {focusedTopNeed && <span>Top need: {CATEGORY_LABELS[focusedTopNeed]}</span>}
              </div>
              <SeverityBar counts={focusedSevCounts} total={focusedPosts.length} />
              <div className="flex gap-3 mt-1.5">
                {SEV_ORDER.map(sev => (
                  <span key={sev} className="text-[9px] text-white/30 flex items-center gap-1">
                    <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: SEV_COLORS[sev] }} />
                    {focusedSevCounts[sev]}
                  </span>
                ))}
              </div>
            </>
          )}
        </GlassCard>
      </div>

      {/* Widget 2: Resource Demand */}
      <div
        style={{ ...showWhen(isFocused), top: 190 }}
      >
        {focusedAvg && (
          <GlassCard className="p-4">
            <p className="text-[10px] text-white/35 uppercase tracking-[2px] mb-3">Resource Demand</p>
            <div className="flex flex-col gap-2.5">
              {CATEGORIES.map(cat => (
                <CategoryScoreBar key={cat} category={cat} score={focusedAvg[cat] ?? 0} />
              ))}
            </div>
          </GlassCard>
        )}
      </div>

      {/* Widget 3: Post List (scrollable) */}
      <div
        className="flex flex-col"
        style={{ ...showWhen(isFocused), top: 400, bottom: 110 }}
      >
        <GlassCard className="p-0 flex-1 overflow-hidden flex flex-col">
          <div className="px-4 pt-3 pb-2 flex-shrink-0 flex items-center justify-between">
            <p className="text-[10px] text-white/35 uppercase tracking-[2px]">Posts</p>
            <p className="text-[10px] text-white/25">{focusedPosts.length}</p>
          </div>
          <div className="overflow-y-auto flex-1 px-4 pb-3">
            {sortedFocusedPosts.map((post, i) => (
              <PostScoreRow
                key={i}
                date={post.date}
                caption={post.caption}
                scores={post.scores as CategoryScores}
                imageUrl={post.image}
              />
            ))}
          </div>
        </GlassCard>
      </div>
    </>
  )
}
