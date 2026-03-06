import { useMemo, useState } from "react";
import type { AnalyzedPost } from "../../types/post";
import type { Cluster } from "../../types/cluster";
import type { Category, CategoryScores } from "../widgets/inferenceWidgets";

const CATEGORIES: Category[] = [
  "infrastructure",
  "food",
  "shelter",
  "sanitation_water",
  "medication",
];
const CATEGORY_LABELS: Record<Category, string> = {
  infrastructure: "Infrastructure",
  food: "Food",
  shelter: "Shelter",
  sanitation_water: "Water & Sanitation",
  medication: "Medication",
};
const CATEGORY_COLORS: Record<Category, string> = {
  infrastructure: "#60a5fa",
  food: "#fbbf24",
  shelter: "#34d399",
  sanitation_water: "#22d3ee",
  medication: "#a78bfa",
};
const SEV_ORDER = ["severe", "mild", "little_or_none"] as const;
const SEV_COLORS: Record<string, string> = {
  severe: "#ef4444",
  mild: "#f59e0b",
  little_or_none: "#22c55e",
};
const SEV_LABELS: Record<string, string> = {
  severe: "Severe",
  mild: "Mild",
  little_or_none: "Low",
};

const PEOPLE_PER_POST = 15;

const card: React.CSSProperties = {
  background: "rgba(255, 255, 255, 0.04)",
  backdropFilter: "blur(20px)",
  WebkitBackdropFilter: "blur(20px)",
  boxShadow: "0 8px 32px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 14,
  color: "white",
  padding: "14px 18px",
};

function formatElapsed(startMs: number): string {
  if (!startMs) return "—";
  const diffSec = Math.max(0, (Date.now() - startMs) / 1000);
  const mins = Math.floor(diffSec / 60);
  const secs = Math.floor(diffSec % 60);
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function timeSpan(posts: AnalyzedPost[]): string {
  if (posts.length < 2) return "—";
  const timestamps = posts.map((p) => p.timestamp);
  const diffSec = Math.max(...timestamps) - Math.min(...timestamps);
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;
  return "<1h";
}

function avgSeverityScore(posts: AnalyzedPost[]): number {
  if (posts.length === 0) return 0;
  const W: Record<string, number> = {
    little_or_none: 0.1,
    mild: 0.3,
    severe: 1,
  };
  return (
    posts.reduce((acc, p) => acc + (W[p.severity_label] ?? 0), 0) / posts.length
  );
}

const STAT_H = 76; // fixed height for stat widgets

/** A single stat widget: big number + label */
function StatWidget({
  value,
  label,
  color,
  style,
}: {
  value: string | number;
  label: string;
  color?: string;
  style: React.CSSProperties;
}) {
  return (
    <div style={style}>
      <div
        style={{
          ...card,
          height: STAT_H,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            fontSize: 24,
            fontWeight: 700,
            lineHeight: 1,
            letterSpacing: "-0.02em",
            color: color ?? "white",
          }}
        >
          {value}
        </div>
        <div
          style={{
            fontSize: 10,
            color: "rgba(255,255,255,0.35)",
            marginTop: 6,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
          }}
        >
          {label}
        </div>
      </div>
    </div>
  );
}

/** Collapsible AI Situation Report widget on the right side */
function SummaryWidget({
  visible,
  llmSummary,
  summaryLoading,
}: {
  visible: boolean;
  llmSummary: string;
  summaryLoading: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const show = visible && (summaryLoading || !!llmSummary);

  return (
    <div
      style={{
        position: "absolute",
        right: 16,
        top: 16,
        width: 360,
        zIndex: 1000,
        opacity: show ? 1 : 0,
        transform: show ? "translateY(0)" : "translateY(-12px)",
        pointerEvents: show ? "auto" : "none",
        transition: "opacity 0.4s ease, transform 0.4s ease",
      }}
    >
      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        {/* Header — always visible, click to toggle */}
        <button
          onClick={() => setCollapsed((c) => !c)}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 16px",
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "white",
          }}
        >
          <span
            style={{
              fontSize: 10,
              color: "rgba(255,255,255,0.3)",
              textTransform: "uppercase",
              letterSpacing: "0.15em",
            }}
          >
            AI Situation Report
          </span>
          <span
            style={{
              fontSize: 14,
              color: "rgba(255,255,255,0.3)",
              transform: collapsed ? "rotate(-90deg)" : "rotate(0)",
              transition: "transform 0.2s",
            }}
          >
            ▼
          </span>
        </button>

        {/* Body — collapsible */}
        <div
          style={{
            maxHeight: collapsed ? 0 : 500,
            overflow: "hidden",
            transition: "max-height 0.3s ease",
          }}
        >
          <div style={{ padding: "0 16px 14px" }}>
            {summaryLoading ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "12px 0",
                }}
              >
                <div
                  style={{
                    width: 14,
                    height: 14,
                    border: "2px solid rgba(255,255,255,0.15)",
                    borderTopColor: "#6c63ff",
                    borderRadius: "50%",
                    animation: "spin 0.8s linear infinite",
                  }}
                />
                <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>
                  Generating report...
                </span>
                <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
              </div>
            ) : (
              <div
                style={{
                  fontSize: 12,
                  lineHeight: 1.6,
                  color: "rgba(255,255,255,0.7)",
                  whiteSpace: "pre-wrap",
                  maxHeight: 400,
                  overflowY: "auto",
                }}
              >
                {llmSummary}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface Props {
  clusters: Record<string, Cluster>;
  analyzedPosts: AnalyzedPost[];
  phase: string;
  sliderValue: number;
  focusedCluster: string | null;
  onFocusCluster: (cid: string | null) => void;
  onPostSelect?: (post: AnalyzedPost) => void;
  analysisStartTime: number;
  llmSummary: string;
  summaryLoading: boolean;
}

export default function AnalysisWidgets({
  clusters,
  analyzedPosts,
  phase,
  sliderValue,
  focusedCluster,
  onFocusCluster,
  onPostSelect,
  analysisStartTime,
  llmSummary,
  summaryLoading,
}: Props) {
  const visible =
    phase === "predicting" || phase === "animating" || phase === "done";
  const isFocused = focusedCluster !== null;

  const activePosts = useMemo(
    () =>
      phase === "done" ? analyzedPosts.slice(0, sliderValue) : analyzedPosts,
    [analyzedPosts, sliderValue, phase],
  );

  const postsByCluster = useMemo(() => {
    const map: Record<string, AnalyzedPost[]> = {};
    for (const p of activePosts) {
      const cid = String(p.cluster);
      if (cid === "-1") continue;
      if (!map[cid]) map[cid] = [];
      map[cid].push(p);
    }
    return map;
  }, [activePosts]);

  const clusterAvgScores = useMemo(() => {
    const result: Record<string, CategoryScores> = {};
    for (const [cid, posts] of Object.entries(postsByCluster)) {
      const avg = {} as CategoryScores;
      for (const cat of CATEGORIES) {
        const vals = posts.map((p) => p.scores[cat] ?? 0);
        avg[cat] = vals.length
          ? vals.reduce((a, b) => a + b, 0) / vals.length
          : 0;
      }
      result[cid] = avg;
    }
    return result;
  }, [postsByCluster]);

  // ── Global metrics ──
  const totalPosts = activePosts.length;
  const clusterCount = Object.keys(postsByCluster).length;
  const globalElapsed = formatElapsed(analysisStartTime);
  const globalPeople = totalPosts * PEOPLE_PER_POST;

  const globalSevCounts: Record<string, number> = {
    severe: 0,
    mild: 0,
    little_or_none: 0,
  };
  for (const p of activePosts) {
    globalSevCounts[p.severity_label] =
      (globalSevCounts[p.severity_label] ?? 0) + 1;
  }

  const sortedClusterIds = Object.keys(postsByCluster).sort((a, b) => {
    const sevOrder: Record<string, number> = {
      severe: 0,
      mild: 1,
      little_or_none: 2,
    };
    const sa = clusters[a]?.combined_severity ?? "little_or_none";
    const sb = clusters[b]?.combined_severity ?? "little_or_none";
    return (sevOrder[sa] ?? 3) - (sevOrder[sb] ?? 3);
  });

  // ── Focused metrics ──
  const focusedClusterData = focusedCluster ? clusters[focusedCluster] : null;
  const focusedPosts = focusedCluster
    ? (postsByCluster[focusedCluster] ?? [])
    : [];
  const focusedAvg = focusedCluster ? clusterAvgScores[focusedCluster] : null;
  const focusedSev = focusedClusterData?.combined_severity ?? "";
  const focusedSevScore = avgSeverityScore(focusedPosts);
  const focusedElapsed = formatElapsed(analysisStartTime);
  const focusedSpan = timeSpan(focusedPosts);
  const focusedPeople = focusedPosts.length * PEOPLE_PER_POST;

  const focusedSevCounts: Record<string, number> = {
    severe: 0,
    mild: 0,
    little_or_none: 0,
  };
  for (const p of focusedPosts) {
    focusedSevCounts[p.severity_label] =
      (focusedSevCounts[p.severity_label] ?? 0) + 1;
  }

  const focusedRankedNeeds = focusedAvg
    ? [...CATEGORIES].sort(
        (a, b) => (focusedAvg[b] ?? 0) - (focusedAvg[a] ?? 0),
      )
    : [];

  const sortedFocusedPosts = [...focusedPosts].sort((a, b) => {
    const W: Record<string, number> = {
      little_or_none: 0.1,
      mild: 0.3,
      severe: 1,
    };
    return (W[b.severity_label] ?? 0) - (W[a.severity_label] ?? 0);
  });

  const clusterTopNeed = (cid: string) => {
    const avg = clusterAvgScores[cid];
    if (!avg) return null;
    return [...CATEGORIES].sort((a, b) => (avg[b] ?? 0) - (avg[a] ?? 0))[0];
  };

  // ── Positioning helpers ──
  const W_HALF = 154; // half-width widget
  const W_FULL = 320; // full-width widget
  const LEFT = 16;
  const GAP = 10;

  const base = (show: boolean): React.CSSProperties => ({
    position: "absolute",
    zIndex: 1000,
    opacity: visible && show ? 1 : 0,
    transform: visible && show ? "translateY(0)" : "translateY(-12px)",
    pointerEvents: visible && show ? "auto" : "none",
    transition: "opacity 0.4s ease, transform 0.4s ease",
  });

  // ── Overview: consistent spacing ──
  const O1 = 16; // row 1: Time Elapsed | Est. Affected
  const O2 = O1 + STAT_H + GAP; // row 2: Clusters
  const O3 = O2 + STAT_H + GAP; // row 3: Cluster list (fills to bottom)

  // ── Focused: consistent spacing ──
  const F_HEADER_H = 78;
  const F_AID_H = 195;
  const F1 = 16; // header
  const F2 = F1 + F_HEADER_H + GAP; // stats row: Time | Affected | Severity
  const F3 = F2 + STAT_H + GAP; // aid needed
  const F4 = F3 + F_AID_H + GAP; // post list (fills to bottom)

  return (
    <>
      {/* ════════════ OVERVIEW ════════════ */}

      {/* Time elapsed */}
      <StatWidget
        value={globalElapsed}
        label="Time Elapsed"
        style={{ ...base(!isFocused), left: LEFT, top: O1, width: W_HALF }}
      />

      {/* Est. affected */}
      <StatWidget
        value={`~${globalPeople.toLocaleString()}`}
        label="Est. Affected"
        style={{
          ...base(!isFocused),
          left: LEFT + W_HALF + GAP,
          top: O1,
          width: W_HALF,
        }}
      />

      {/* Clusters count */}
      <StatWidget
        value={clusterCount}
        label="Clusters"
        style={{ ...base(!isFocused), left: LEFT, top: O2, width: W_FULL }}
      />

      {/* Cluster list (scrollable) */}
      <div
        style={{
          ...base(!isFocused),
          left: LEFT,
          top: O3,
          width: W_FULL,
          bottom: 110,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            ...card,
            padding: 0,
            flex: 1,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              padding: "12px 16px 8px",
              fontSize: 10,
              color: "rgba(255,255,255,0.3)",
              textTransform: "uppercase",
              letterSpacing: "0.15em",
              flexShrink: 0,
            }}
          >
            Clusters
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 8px" }}>
            {sortedClusterIds.map((cid) => {
              const cluster = clusters[cid];
              if (!cluster) return null;
              const posts = postsByCluster[cid] ?? [];
              const sev = cluster.combined_severity ?? "";
              const topNeed = clusterTopNeed(cid);

              return (
                <div
                  key={cid}
                  onClick={() => onFocusCluster(cid)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 12px",
                    borderRadius: 10,
                    cursor: "pointer",
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background =
                      "rgba(255,255,255,0.05)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = "transparent")
                  }
                >
                  <div
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      flexShrink: 0,
                      background: SEV_COLORS[sev] ?? "#556",
                      boxShadow: `0 0 6px ${SEV_COLORS[sev] ?? "#556"}`,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {cluster.name}
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: "rgba(255,255,255,0.3)",
                        marginTop: 2,
                        display: "flex",
                        gap: 8,
                      }}
                    >
                      <span>{posts.length} posts</span>
                      {topNeed && (
                        <span style={{ color: CATEGORY_COLORS[topNeed] }}>
                          {CATEGORY_LABELS[topNeed]}
                        </span>
                      )}
                    </div>
                  </div>
                  {sev && (
                    <span
                      style={{
                        fontSize: 9,
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        padding: "3px 8px",
                        borderRadius: 20,
                        flexShrink: 0,
                        background: `${SEV_COLORS[sev]}18`,
                        color: SEV_COLORS[sev],
                      }}
                    >
                      {SEV_LABELS[sev]}
                    </span>
                  )}
                  <span
                    style={{
                      color: "rgba(255,255,255,0.15)",
                      fontSize: 14,
                      flexShrink: 0,
                    }}
                  >
                    ›
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ════════════ FOCUSED ════════════ */}

      {/* Back + cluster name header */}
      <div style={{ ...base(isFocused), left: LEFT, top: F1, width: W_FULL }}>
        <div
          style={{
            ...card,
            height: F_HEADER_H,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
          }}
        >
          <button
            onClick={() => onFocusCluster(null)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 0,
              fontSize: 11,
              color: "rgba(255,255,255,0.4)",
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 8,
              transition: "color 0.15s",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.color = "rgba(255,255,255,0.7)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.color = "rgba(255,255,255,0.4)")
            }
          >
            ← All Clusters
          </button>
          {focusedClusterData && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  flexShrink: 0,
                  background: SEV_COLORS[focusedSev] ?? "#556",
                  boxShadow: `0 0 8px ${SEV_COLORS[focusedSev] ?? "#556"}`,
                }}
              />
              <span style={{ fontSize: 15, fontWeight: 700 }}>
                {focusedClusterData.name}
              </span>
              {focusedSev && (
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: 9,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    padding: "3px 8px",
                    borderRadius: 20,
                    background: `${SEV_COLORS[focusedSev]}18`,
                    color: SEV_COLORS[focusedSev],
                  }}
                >
                  {SEV_LABELS[focusedSev]}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Time elapsed */}
      <StatWidget
        value={focusedElapsed}
        label="Time Elapsed"
        style={{ ...base(isFocused), left: LEFT, top: F2, width: 100 }}
      />

      {/* Est. affected */}
      <StatWidget
        value={`~${focusedPeople}`}
        label="Est. Affected"
        style={{
          ...base(isFocused),
          left: LEFT + 100 + GAP,
          top: F2,
          width: 100,
        }}
      />

      {/* Avg severity */}
      <StatWidget
        value={`${Math.round(focusedSevScore * 100)}%`}
        label="Avg Severity"
        color={
          focusedSevScore >= 0.3
            ? SEV_COLORS.severe
            : focusedSevScore >= 0.2
              ? SEV_COLORS.mild
              : SEV_COLORS.little_or_none
        }
        style={{
          ...base(isFocused),
          left: LEFT + 100 + GAP + 100 + GAP,
          top: F2,
          width: 100,
        }}
      />

      {/* Aid needed (ranked) — its own widget */}
      <div style={{ ...base(isFocused), left: LEFT, top: F3, width: W_FULL }}>
        {focusedAvg && (
          <div style={card}>
            <div
              style={{
                fontSize: 10,
                color: "rgba(255,255,255,0.3)",
                textTransform: "uppercase",
                letterSpacing: "0.15em",
                marginBottom: 12,
              }}
            >
              Aid Needed
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {focusedRankedNeeds.map((cat, rank) => {
                const pct = Math.round(
                  Math.min(Math.max(focusedAvg[cat] ?? 0, 0), 1) * 100,
                );
                return (
                  <div
                    key={cat}
                    style={{ display: "flex", alignItems: "center", gap: 10 }}
                  >
                    <span
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: "50%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 10,
                        fontWeight: 700,
                        flexShrink: 0,
                        background:
                          rank === 0
                            ? "rgba(255,255,255,0.12)"
                            : "rgba(255,255,255,0.04)",
                        color: rank === 0 ? "#fff" : "rgba(255,255,255,0.4)",
                      }}
                    >
                      {rank + 1}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          marginBottom: 3,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 11,
                            color:
                              rank === 0 ? "#fff" : "rgba(255,255,255,0.5)",
                          }}
                        >
                          {CATEGORY_LABELS[cat]}
                        </span>
                        <span style={{ fontSize: 11, fontWeight: 600 }}>
                          {pct}%
                        </span>
                      </div>
                      <div
                        style={{
                          height: 3,
                          borderRadius: 2,
                          background: "rgba(255,255,255,0.06)",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            height: "100%",
                            borderRadius: 2,
                            width: `${pct}%`,
                            background: CATEGORY_COLORS[cat],
                            transition: "width 0.5s",
                          }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Post list (scrollable) */}
      <div
        style={{
          ...base(isFocused),
          left: LEFT,
          top: F4,
          width: W_FULL,
          bottom: 110,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            ...card,
            padding: 0,
            flex: 1,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              padding: "12px 16px 8px",
              flexShrink: 0,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span
              style={{
                fontSize: 10,
                color: "rgba(255,255,255,0.3)",
                textTransform: "uppercase",
                letterSpacing: "0.15em",
              }}
            >
              Posts
            </span>
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.2)" }}>
              {focusedPosts.length}
            </span>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "0 14px 10px" }}>
            {sortedFocusedPosts.map((post, i) => {
              const topCat = [...CATEGORIES].sort(
                (a, b) => (post.scores[b] ?? 0) - (post.scores[a] ?? 0),
              )[0];
              const topScore = post.scores[topCat] ?? 0;
              return (
                <div
                  key={i}
                  onClick={() => onPostSelect?.(post)}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 10,
                    padding: "8px 6px",
                    borderBottom:
                      i < sortedFocusedPosts.length - 1
                        ? "1px solid rgba(255,255,255,0.04)"
                        : "none",
                    cursor: "pointer",
                    borderRadius: 8,
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = "rgba(255,255,255,0.05)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = "transparent")
                  }
                >
                  {post.image && (
                    <img
                      src={post.image}
                      alt=""
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 8,
                        objectFit: "cover",
                        flexShrink: 0,
                        opacity: 0.85,
                      }}
                    />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 10,
                        color: "rgba(255,255,255,0.25)",
                        marginBottom: 2,
                      }}
                    >
                      {post.date}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: "rgba(255,255,255,0.65)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {post.caption}
                    </div>
                  </div>
                  <div style={{ flexShrink: 0, textAlign: "right" }}>
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 500,
                        color: CATEGORY_COLORS[topCat],
                      }}
                    >
                      {CATEGORY_LABELS[topCat]}
                    </div>
                    <div
                      style={{ fontSize: 11, fontWeight: 600, marginTop: 1 }}
                    >
                      {Math.round(topScore * 100)}%
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ════════════ AI SUMMARY (right side) ════════════ */}
      <SummaryWidget
        visible={phase === "done"}
        llmSummary={llmSummary}
        summaryLoading={summaryLoading}
      />
    </>
  );
}
