import { useMemo, useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import type { AnalyzedPost } from "../../types/post";
import type { Cluster } from "../../types/cluster";
import type { Category, CategoryScores } from "../widgets/inferenceWidgets";
import { glassStyle } from "../widgets/glassCard";
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer, Tooltip } from "recharts";
import type { DispatchPlan } from "./Map";

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
  infrastructure: "#A893C4",
  food: "#6DB8A0",
  shelter: "#7BA7CC",
  sanitation_water: "#5BBCD6",
  medication: "#C97B9A",
};
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

// Scaling factor: fraction of city population estimated affected per unit of social media signal density
const AFFECTED_ALPHA = 0.1;

// Real FEMA warehouse inventory for Hurricane Irma
// perCapitaPerDay: Sphere Standards minimum per person per day (where applicable)
//   Water: 2.5–3 L/person/day → 2.5  |  Meals: 3/person/day
//   Cots: 1/person (one-time)  |  Medical Kits: 1 per 1000 people (one-time)
//   Tarps: 1 per 5 people (one-time)  |  Blue Roof Sheeting: 1 per 5 people (one-time)
const FEMA_SUPPLY: { item: string; qty: number; category: Category; perCapita: number; perDay: boolean }[] = [
  { item: "Water (liters)", qty: 718370, category: "sanitation_water", perCapita: 2.5, perDay: true },
  { item: "Meals", qty: 250572, category: "food", perCapita: 3, perDay: true },
  { item: "Cots", qty: 4422, category: "shelter", perCapita: 1, perDay: false },
  { item: "Medical Kits", qty: 800, category: "medication", perCapita: 0.001, perDay: false },
  { item: "Tarps", qty: 13272, category: "shelter", perCapita: 0.2, perDay: false },
  { item: "Blue Roof Sheeting", qty: 15344, category: "infrastructure", perCapita: 0.2, perDay: false },
];
const RELIEF_DAYS = 3; // planning horizon for per-day items

const card: React.CSSProperties = {
  ...glassStyle,
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


function avgSeverityScore(posts: AnalyzedPost[]): number {
  const informative = posts.filter((p) => p.informative);
  if (informative.length === 0) return 0;
  const W: Record<string, number> = {
    little_or_none: 0.1,
    mild: 0.3,
    severe: 1,
  };
  return (
    informative.reduce((acc, p) => acc + (W[p.severity_label] ?? 0), 0) /
    informative.length
  );
}

const STAT_H = 76; // fixed height for stat widgets

function SeverityLegendButton() {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);

  const handleMouseEnter = () => {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 6, left: rect.left });
    }
    setShow(true);
  };

  const popup = show ? (
    <div
      onMouseLeave={() => setShow(false)}
      style={{
        ...glassStyle,
        background: "rgba(255,255,255,0.11)",
        position: "fixed",
        top: pos.top,
        left: pos.left,
        borderRadius: 8,
        padding: "10px 12px",
        zIndex: 99999,
        minWidth: 130,
      }}
    >
      <div style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", marginBottom: 8, letterSpacing: "0.12em" }}>
        SEVERITY
      </div>
      {(["severe", "mild", "little_or_none"] as const).map((s) => (
        <div key={s} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: SEV_COLORS[s], boxShadow: `0 0 6px ${SEV_COLORS[s]}`, flexShrink: 0 }} />
          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.6)", textTransform: "none", letterSpacing: 0 }}>
            {SEV_LABELS[s]}
          </span>
        </div>
      ))}
    </div>
  ) : null;

  return (
    <div style={{ display: "flex" }}>
      <button
        ref={btnRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => setShow(false)}
        style={{
          width: 14, height: 14, borderRadius: "50%",
          border: "1px solid rgba(255,255,255,0.2)",
          background: "rgba(255,255,255,0.06)",
          color: "rgba(255,255,255,0.4)",
          fontSize: 9, fontWeight: 700, cursor: "default",
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: 0, lineHeight: 1, textTransform: "none", letterSpacing: 0,
        }}
      >
        ?
      </button>
      {createPortal(popup, document.body)}
    </div>
  );
}

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
          containerType: "inline-size",
        }}
      >
        <div
          style={{
            fontSize: "clamp(11px, 18cqw, 24px)",
            fontWeight: 700,
            lineHeight: 1,
            letterSpacing: "-0.02em",
            color: color ?? "white",
            whiteSpace: "nowrap",
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

/** Dashboard card wrapper with consistent glassmorphism */
function DashCard({
  title,
  children,
  maxHeight,
  style: extra,
}: {
  title: string;
  children: React.ReactNode;
  maxHeight?: number;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{ ...card, padding: 0, overflow: maxHeight ? "hidden" : undefined, ...extra }}>
      <div
        style={{
          padding: "10px 14px 6px",
          fontSize: 9,
          color: "rgba(255,255,255,0.3)",
          textTransform: "uppercase",
          letterSpacing: "0.15em",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          flexShrink: 0,
        }}
      >
        {title}
      </div>
      <div style={{ padding: "8px 14px 12px", maxHeight: maxHeight, overflowY: maxHeight ? "auto" : undefined }}>{children}</div>
    </div>
  );
}

/** AI Dashboard — context-aware situation summary on the right side */
function AIDashboard({
  visible,
  plan,
  summaryLoading,
  totalPosts,
  focusedCluster,
  clusters,
  postsByCluster,
  clusterAvgScores,
}: {
  visible: boolean;
  plan: DispatchPlan | null;
  summaryLoading: boolean;
  totalPosts: number;
  focusedCluster: string | null;
  clusters: Record<string, Cluster>;
  postsByCluster: Record<string, AnalyzedPost[]>;
  clusterAvgScores: Record<string, CategoryScores>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [selectedSupplyCat, setSelectedSupplyCat] = useState<Category | null>(null);
  const show = visible && (summaryLoading || !!plan);

  // Per-cluster LLM summary cache
  const [clusterSummaries, setClusterSummaries] = useState<Record<string, string>>({});
  const [clusterSummaryLoading, setClusterSummaryLoading] = useState<string | null>(null);
  const fetchingRef = useRef<Set<string>>(new Set());

  const fetchClusterSummary = useCallback((cid: string) => {
    if (clusterSummaries[cid] || fetchingRef.current.has(cid)) return;
    const cluster = clusters[cid];
    if (!cluster) return;
    const posts = postsByCluster[cid] ?? [];
    const avg = clusterAvgScores[cid] ?? {};
    const sevCounts: Record<string, number> = { severe: 0, mild: 0, little_or_none: 0 };
    for (const p of posts) sevCounts[p.severity_label] = (sevCounts[p.severity_label] ?? 0) + 1;

    fetchingRef.current.add(cid);
    setClusterSummaryLoading(cid);

    fetch("/api/cluster-summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cluster: {
          name: cluster.name,
          severity: cluster.combined_severity ?? "unknown",
          population: cluster.population ?? 0,
          postCount: posts.length,
          resourceScores: avg,
          severityCounts: sevCounts,
        },
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.summary) setClusterSummaries((prev) => ({ ...prev, [cid]: d.summary }));
      })
      .catch(() => {})
      .finally(() => {
        fetchingRef.current.delete(cid);
        setClusterSummaryLoading((prev) => (prev === cid ? null : prev));
      });
  }, [clusterSummaries, clusters, postsByCluster, clusterAvgScores]);

  useEffect(() => {
    if (focusedCluster && !clusterSummaries[focusedCluster]) {
      fetchClusterSummary(focusedCluster);
    }
  }, [focusedCluster, clusterSummaries, fetchClusterSummary]);

  // Compute demand per item using Sphere Standards per-capita needs
  const supplyDemand = useMemo(() => {
    // Compute estimated affected per cluster
    const clusterAffected: Record<string, number> = {};
    let totalAffected = 0;
    for (const [cid, posts] of Object.entries(postsByCluster)) {
      const pop = clusters[cid]?.population ?? 0;
      const affected = totalPosts > 0 ? pop * (posts.length / totalPosts) * AFFECTED_ALPHA : 0;
      clusterAffected[cid] = affected;
      totalAffected += affected;
    }

    // For each supply item, compute demand = affected × perCapita × (days if perDay)
    // Then aggregate by category
    const supply: Record<Category, { items: { name: string; qty: number; demand: number }[]; totalSupply: number; totalDemand: number }> = {
      sanitation_water: { items: [], totalSupply: 0, totalDemand: 0 },
      food: { items: [], totalSupply: 0, totalDemand: 0 },
      shelter: { items: [], totalSupply: 0, totalDemand: 0 },
      medication: { items: [], totalSupply: 0, totalDemand: 0 },
      infrastructure: { items: [], totalSupply: 0, totalDemand: 0 },
    };
    for (const s of FEMA_SUPPLY) {
      const itemDemand = Math.round(totalAffected * s.perCapita * (s.perDay ? RELIEF_DAYS : 1));
      supply[s.category].items.push({ name: s.item, qty: s.qty, demand: itemDemand });
      supply[s.category].totalSupply += s.qty;
      supply[s.category].totalDemand += itemDemand;
    }

    // Per-cluster demand breakdown weighted by AI resource scores × affected population
    const clusterDemand: Record<Category, { cid: string; name: string; demand: number }[]> = {
      sanitation_water: [], food: [], shelter: [], medication: [], infrastructure: [],
    };
    for (const [cid] of Object.entries(postsByCluster)) {
      const affected = clusterAffected[cid] ?? 0;
      if (affected <= 0) continue;
      const avg = clusterAvgScores[cid];
      for (const cat of CATEGORIES) {
        // Weight by resource score (AI signal) × affected population
        const score = avg?.[cat] ?? 0;
        const weight = score * affected;
        if (weight > 0) {
          clusterDemand[cat].push({ cid, name: clusters[cid]?.name ?? cid, demand: weight });
        }
      }
    }
    for (const cat of CATEGORIES) clusterDemand[cat].sort((a, b) => b.demand - a.demand);

    return CATEGORIES.map((cat) => {
      const s = supply[cat];
      const ratio = s.totalDemand > 0 ? s.totalSupply / s.totalDemand : s.totalSupply > 0 ? Infinity : 0;
      return { category: cat, supply: s.totalSupply, supplyItems: s.items, demand: s.totalDemand, ratio, clusterDemand: clusterDemand[cat] };
    }).sort((a, b) => a.ratio - b.ratio);
  }, [postsByCluster, clusters, clusterAvgScores, totalPosts]);

  const isFocused = focusedCluster !== null;
  const focusedData = focusedCluster ? clusters[focusedCluster] : null;
  const focusedSummary = focusedCluster ? clusterSummaries[focusedCluster] : null;
  const isFocusedLoading = clusterSummaryLoading === focusedCluster;

  return (
    <div
      style={{
        position: "absolute",
        right: 16,
        top: 16,
        width: 380,
        bottom: 16,
        zIndex: 1000,
        opacity: show ? 1 : 0,
        transform: show ? "translateX(0)" : "translateX(12px)",
        pointerEvents: show ? "auto" : "none",
        transition: "opacity 0.4s ease, transform 0.4s ease",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <div style={{ ...card, padding: 0, overflow: "hidden", flexShrink: 0 }}>
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
          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.15em" }}>
            Situation Summary
          </span>
          <span style={{ fontSize: 14, color: "rgba(255,255,255,0.3)", transform: collapsed ? "rotate(-90deg)" : "rotate(0)", transition: "transform 0.2s" }}>
            ▼
          </span>
        </button>
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          overflow: collapsed ? "hidden" : "auto",
          maxHeight: collapsed ? 0 : undefined,
          transition: "max-height 0.3s ease",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          marginTop: 8,
        }}
      >
        {summaryLoading ? (
          <div style={{ ...card, display: "flex", alignItems: "center", gap: 8, justifyContent: "center", padding: "24px 16px" }}>
            <div style={{ width: 14, height: 14, border: "2px solid rgba(255,255,255,0.15)", borderTopColor: "#6c63ff", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
            <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>Analyzing situation...</span>
          </div>
        ) : plan ? (
          isFocused && focusedData ? (
            
            <>
              {/* ── CLUSTER-FOCUSED VIEW ── */}
              <DashCard title={`${focusedData.name} — AI Overview`}>
                {isFocusedLoading ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0" }}>
                    <div style={{ width: 12, height: 12, border: "2px solid rgba(255,255,255,0.15)", borderTopColor: "#6c63ff", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                    <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>Generating cluster overview...</span>
                  </div>
                ) : (
                  <div style={{ fontSize: 11, lineHeight: 1.6, color: "rgba(255,255,255,0.7)" }}>
                    {focusedSummary ?? "Loading..."}
                  </div>
                )}
              </DashCard>

              {/* ── Resource Allocation for this cluster ── */}
              <DashCard title={`${focusedData.name} — Recommended Resource Allocation`}>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {supplyDemand.map(({ category, supplyItems, clusterDemand: cd }) => {
                    const color = CATEGORY_COLORS[category];
                    const totalWeight = cd.reduce((s, c) => s + c.demand, 0);
                    const thisCluster = cd.find((c) => c.cid === focusedCluster);
                    const pct = thisCluster && totalWeight > 0 ? thisCluster.demand / totalWeight : 0;
                    if (pct === 0) return null;
                    const allocPct = Math.max(1, Math.round(pct * 100));
                    return (
                      <div key={category}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <div style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
                            <span style={{ fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.85)" }}>
                              {CATEGORY_LABELS[category]}
                            </span>
                          </div>
                          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
                            {allocPct}% of supply
                          </span>
                        </div>
                        <div style={{ height: 4, borderRadius: 2, background: "rgba(255,255,255,0.06)", overflow: "hidden", marginBottom: 4 }}>
                          <div style={{ height: "100%", borderRadius: 2, width: `${allocPct}%`, background: color, opacity: 0.8, transition: "width 0.3s" }} />
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 1, paddingLeft: 14 }}>
                          {supplyItems.filter((si) => si.qty > 0).map((si) => {
                            const allocated = Math.max(1, Math.round(si.qty * pct));
                            return (
                              <div key={si.name} style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "rgba(255,255,255,0.35)" }}>
                                <span>{si.name}</span>
                                <span style={{ color: "rgba(255,255,255,0.5)", fontWeight: 500 }}>{allocated.toLocaleString()}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  }).filter(Boolean)}
                </div>
                <div style={{ fontSize: 8, color: "rgba(255,255,255,0.2)", marginTop: 8, textAlign: "center" }}>
                  Allocation weighted by AI resource scores × affected population
                </div>
              </DashCard>
            </>
          ) : (
            <>
              {/* ── GLOBAL OVERVIEW ── */}
              <DashCard title="General Overview">
                <div style={{ fontSize: 11, lineHeight: 1.6, color: "rgba(255,255,255,0.7)" }}>
                  {plan.situation}
                </div>
              </DashCard>

              {/* Supply vs Demand — real FEMA inventory */}
              <DashCard title={selectedSupplyCat ? `${CATEGORY_LABELS[selectedSupplyCat]} — Recommended Distribution` : "General — FEMA Supply vs Demand"}>
                {selectedSupplyCat ? (() => {
                  const sel = supplyDemand.find((s) => s.category === selectedSupplyCat);
                  if (!sel) return null;
                  const color = CATEGORY_COLORS[selectedSupplyCat];
                  const totalDemand = sel.clusterDemand.reduce((s, c) => s + c.demand, 0);
                  return (
                    <div>
                      <button
                        onClick={() => setSelectedSupplyCat(null)}
                        style={{
                          background: "none", border: "none", cursor: "pointer", padding: 0,
                          fontSize: 11, color: "rgba(255,255,255,0.4)", display: "flex", alignItems: "center", gap: 6, marginBottom: 10,
                          transition: "color 0.15s",
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.7)")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.4)")}
                      >
                        ← Back
                      </button>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "rgba(255,255,255,0.4)", marginBottom: 6 }}>
                        <span>Total supply: {sel.supply.toLocaleString()}</span>
                        <span>Total demand: ~{sel.demand.toLocaleString()}</span>
                      </div>
                      <div style={{ marginBottom: 8 }}>
                        {sel.supplyItems.map((si) => (
                          <div key={si.name} style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", marginBottom: 2, display: "flex", justifyContent: "space-between" }}>
                            <span>{si.name}</span>
                            <span>{si.qty.toLocaleString()} / ~{si.demand.toLocaleString()} needed</span>
                          </div>
                        ))}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {sel.clusterDemand.map((c) => {
                          const pct = totalDemand > 0 ? c.demand / totalDemand : 0;
                          const allocated = Math.max(1, Math.round(sel.supply * pct));
                          const allocPct = Math.max(1, Math.round(pct * 100));
                          return (
                            <div key={c.cid}>
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, marginBottom: 3 }}>
                                <span style={{ color: "rgba(255,255,255,0.7)", fontWeight: 600 }}>{c.name}</span>
                                <span style={{ color: "rgba(255,255,255,0.5)" }}>{allocated.toLocaleString()} ({allocPct}%)</span>
                              </div>
                              <div style={{ height: 4, borderRadius: 2, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
                                <div style={{ height: "100%", borderRadius: 2, width: `${allocPct}%`, background: color, opacity: 0.8, transition: "width 0.3s" }} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })() : (
                  <div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {supplyDemand.map(({ category, supply, supplyItems, demand, ratio }) => {
                        const label = CATEGORY_LABELS[category];
                        const color = CATEGORY_COLORS[category];
                        const maxVal = Math.max(supply, demand, 1);
                        const status = ratio >= 1 ? "Adequate" : ratio > 0.5 ? "Low" : "Inadequate";
                        const statusColor = ratio >= 1 ? "#22c55e" : ratio > 0.5 ? "#f59e0b" : "#ef4444";
                        const isInadequate = ratio < 0.5;
                        return (
                          <div
                            key={category}
                            onClick={() => setSelectedSupplyCat(category)}
                            style={{
                              padding: "8px 10px",
                              borderRadius: 8,
                              cursor: "pointer",
                              transition: "background 0.15s",
                              border: isInadequate ? `1px solid ${statusColor}4D` : "1px solid transparent",
                              boxShadow: isInadequate ? `0 0 12px ${statusColor}26, inset 0 0 8px ${statusColor}0D` : "none",
                              background: isInadequate ? `${statusColor}0A` : "transparent",
                            }}
                            onMouseEnter={(e) => { if (!isInadequate) e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
                            onMouseLeave={(e) => { if (!isInadequate) e.currentTarget.style.background = "transparent"; }}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                              <span style={{ fontSize: 11, fontWeight: 600, color }}>{label}</span>
                              <span style={{ fontSize: 9, fontWeight: 600, color: statusColor, textTransform: "uppercase", letterSpacing: "0.05em", padding: "2px 6px", borderRadius: 10, background: `${statusColor}18` }}>
                                {status}
                              </span>
                            </div>
                            {/* Supply bar */}
                            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                              <span style={{ fontSize: 8, color: "rgba(255,255,255,0.35)", width: 36, flexShrink: 0 }}>Supply</span>
                              <div style={{ flex: 1, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
                                <div style={{ height: "100%", borderRadius: 2, width: `${(supply / maxVal) * 100}%`, background: color, opacity: 0.8 }} />
                              </div>
                              <span style={{ fontSize: 9, color: "rgba(255,255,255,0.5)", width: 52, textAlign: "right", flexShrink: 0 }}>{supply.toLocaleString()}</span>
                            </div>
                            {/* Demand bar */}
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ fontSize: 8, color: "rgba(255,255,255,0.35)", width: 36, flexShrink: 0 }}>Demand</span>
                              <div style={{ flex: 1, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
                                <div style={{ height: "100%", borderRadius: 2, width: `${(demand / maxVal) * 100}%`, background: "rgba(255,255,255,0.4)" }} />
                              </div>
                              <span style={{ fontSize: 9, color: "rgba(255,255,255,0.5)", width: 52, textAlign: "right", flexShrink: 0 }}>~{demand.toLocaleString()}</span>
                            </div>
                            {/* Per-item supply vs computed demand */}
                            <div style={{ marginTop: 3, paddingLeft: 42 }}>
                              {supplyItems.map((si: { name: string; qty: number; demand: number }) => (
                                <div key={si.name} style={{ fontSize: 8, color: "rgba(255,255,255,0.25)", marginBottom: 1 }}>
                                  {si.name}: {si.qty.toLocaleString()} supply / ~{si.demand.toLocaleString()} need
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ fontSize: 8, color: "rgba(255,255,255,0.2)", marginTop: 8, textAlign: "center" }}>
                      Supply: FEMA warehouse inventory · Demand: Sphere Standards × est. affected × {RELIEF_DAYS} days
                    </div>
                  </div>
                )}
              </DashCard>

              <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", textAlign: "center", padding: "4px 0" }}>
                Select a cluster for detailed breakdown
              </div>
            </>
          )
        ) : null}
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
  dispatchPlan: DispatchPlan | null;
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
  dispatchPlan,
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
  const globalPeople =
    totalPosts > 0
      ? Math.round(
          Object.entries(postsByCluster).reduce((sum, [cid, posts]) => {
            const pop = clusters[cid]?.population ?? 0;
            return sum + pop * (posts.length / totalPosts) * AFFECTED_ALPHA;
          }, 0),
        )
      : 0;

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
  const focusedPeople =
    totalPosts > 0 && focusedClusterData?.population
      ? Math.round(
          focusedClusterData.population *
            (focusedPosts.length / totalPosts) *
            AFFECTED_ALPHA,
        )
      : 0;

  const focusedSevCounts: Record<string, number> = {
    severe: 0,
    mild: 0,
    little_or_none: 0,
  };
  for (const p of focusedPosts) {
    focusedSevCounts[p.severity_label] =
      (focusedSevCounts[p.severity_label] ?? 0) + 1;
  }

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
  const F_HEADER_H = 30;
  const F_AID_H = 258;
  const F1 = 16; // header (back + name inline)
  const F2 = F1 + F_HEADER_H + GAP; // stats row: Time | Affected | Severity
  const F3 = F2 + STAT_H + GAP; // aid needed
  const F4 = F3 + F_AID_H + GAP; // post list (fills to bottom)

  return (
    <>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.22); }
      `}</style>
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
          bottom: 16,
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
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            Clusters
            <SeverityLegendButton />
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

      {/* Back + cluster name header (inline, no card) */}
      <div style={{
        ...base(isFocused),
        left: LEFT,
        top: F1,
        width: W_FULL,
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: F_HEADER_H,
      }}>
        <button
          onClick={() => onFocusCluster(null)}
          style={{
            ...glassStyle,
            border: "1px solid rgba(255,255,255,0.12)",
            cursor: "pointer",
            padding: "4px 10px",
            borderRadius: 8,
            fontSize: 11,
            color: "rgba(255,255,255,0.5)",
            flexShrink: 0,
            transition: "all 0.15s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "#fff"; e.currentTarget.style.background = "rgba(255,255,255,0.08)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(255,255,255,0.5)"; e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
        >
          ← Back
        </button>
        {focusedClusterData && (
          <>
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                flexShrink: 0,
                background: SEV_COLORS[focusedSev] ?? "#556",
                boxShadow: `0 0 6px ${SEV_COLORS[focusedSev] ?? "#556"}`,
              }}
            />
            <span style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>
              {focusedClusterData.name}
            </span>
            {focusedSev && (
              <span
                style={{
                  marginLeft: "auto",
                  fontSize: 9,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  padding: "2px 7px",
                  borderRadius: 20,
                  background: `${SEV_COLORS[focusedSev]}18`,
                  color: SEV_COLORS[focusedSev],
                }}
              >
                {SEV_LABELS[focusedSev]}
              </span>
            )}
          </>
        )}
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

      {/* Aid needed (radar chart) — cluster-specific */}
      <div style={{ ...base(isFocused), left: LEFT, top: F3, width: W_FULL }}>
        {focusedAvg && (
          <div style={card}>
            <div
              style={{
                fontSize: 10,
                color: "rgba(255,255,255,0.3)",
                textTransform: "uppercase",
                letterSpacing: "0.15em",
                marginBottom: 4,
              }}
            >
              Aid Needed
            </div>
            {(() => {
              const rawScores = CATEGORIES.map((cat) => Math.min(Math.max(focusedAvg[cat] ?? 0, 0), 1));
              const maxScore = Math.max(...rawScores, 0.01);
              const radarData = CATEGORIES.map((cat, i) => {
                const pct = Math.round((rawScores[i] / maxScore) * 100);
                return {
                  category: CATEGORY_LABELS[cat],
                  catKey: cat,
                  score: pct,
                  rawPct: Math.round(rawScores[i] * 100),
                  fullMark: 100,
                };
              });

              const AidTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: typeof radarData[number] }> }) => {
                if (!active || !payload?.[0]) return null;
                const d = payload[0].payload;
                const color = CATEGORY_COLORS[d.catKey as Category];
                return (
                  <div style={{
                    background: "rgba(16,18,27,0.95)",
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 6,
                    padding: "4px 10px",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}>
                    <div style={{ width: 6, height: 6, borderRadius: 2, background: color }} />
                    <span style={{ fontSize: 10, fontWeight: 600, color: "#fff" }}>{d.category}</span>
                    <span style={{ fontSize: 10, color: "rgba(255,255,255,0.5)" }}>{d.rawPct}%</span>
                  </div>
                );
              };

              return (
                <div style={{ width: "100%", height: 210 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <RadarChart cx="50%" cy="50%" outerRadius="75%" data={radarData}>
                      <PolarGrid stroke="rgba(255,255,255,0.1)" />
                      <PolarAngleAxis
                        dataKey="category"
                        tick={{ fill: "rgba(255,255,255,0.7)", fontSize: 9, fontWeight: 600 }}
                      />
                      <PolarRadiusAxis
                        angle={90}
                        domain={[0, 100]}
                        tick={false}
                        axisLine={false}
                      />
                      <Tooltip content={<AidTooltip />} />
                      <Radar
                        dataKey="score"
                        stroke="#6c63ff"
                        fill="#6c63ff"
                        fillOpacity={0.3}
                        strokeWidth={2}
                        dot={{ r: 3, fill: "#6c63ff", stroke: "#fff", strokeWidth: 1 }}
                        activeDot={{ r: 5, fill: "#6c63ff", stroke: "#fff", strokeWidth: 2 }}
                      />
                    </RadarChart>
                  </ResponsiveContainer>
                </div>
              );
            })()}
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
          bottom: 16,
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
                    (e.currentTarget.style.background =
                      "rgba(255,255,255,0.05)")
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
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      opacity: post.informative ? 1 : 0.4,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 10,
                        color: "rgba(255,255,255,0.25)",
                        marginBottom: 2,
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      {post.date}
                      <span
                        style={{
                          fontSize: 8,
                          padding: "1px 5px",
                          borderRadius: 3,
                          fontWeight: 600,
                          background: post.informative
                            ? "rgba(255,255,255,0.10)"
                            : "rgba(255,255,255,0.06)",
                          color: post.informative
                            ? "rgba(255,255,255,0.85)"
                            : "rgba(255,255,255,0.45)",
                          textTransform: "uppercase",
                          letterSpacing: 0.3,
                        }}
                      >
                        {post.informative ? "informative" : "not informative"}
                      </span>
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

      {/* ════════════ AI DASHBOARD (right side) ════════════ */}
      <AIDashboard
        visible={phase === "done"}
        plan={dispatchPlan}
        summaryLoading={summaryLoading}
        totalPosts={totalPosts}
        focusedCluster={focusedCluster}
        clusters={clusters}
        postsByCluster={postsByCluster}
        clusterAvgScores={clusterAvgScores}
      />
    </>
  );
}
