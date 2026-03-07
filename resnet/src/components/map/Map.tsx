import "leaflet/dist/leaflet.css";
import {
  MapContainer,
  TileLayer,
  Polygon,
  useMap,
  useMapEvents,
} from "react-leaflet";
import PostMarkers from "./cluster.tsx";
import AnalysisSidebar from "./AnalysisSidebar.tsx";
import { useEffect, useState, useRef, useCallback } from "react";
import type { Post, AnalyzedPost } from "../../types/post";
import type { Cluster } from "../../types/cluster";
import { glassStyle } from "../widgets/glassCard";

const SEV_COLORS: Record<string, string> = {
  severe: "#ef4444",
  mild: "#f59e0b",
  little_or_none: "#22c55e",
};

const POSTS_PER_TICK = 5;
const INTERVAL_MS = 20;
const ZOOM_THRESHOLD = 11;

type Phase = "idle" | "predicting" | "animating" | "done";

export interface DispatchPlan {
  situation: string;
  priorities: { cluster: string; level: string; top_need: string }[];
  dispatch: { cluster: string; team_count: number; teams: string; supplies: string; timeline: string; allocation_pct: number; est_affected: number }[];
}

/** Convex hull via Graham scan — returns the true edge points in order. */
function convexHull(points: [number, number][]): [number, number][] {
  if (points.length < 3) return points;
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Smooth an ordered polygon ring using Chaikin's algorithm. */
function smoothPolygon(pts: [number, number][], iterations = 3): [number, number][] {
  let result = pts;
  for (let iter = 0; iter < iterations; iter++) {
    const next: [number, number][] = [];
    for (let j = 0; j < result.length; j++) {
      const p0 = result[j];
      const p1 = result[(j + 1) % result.length];
      next.push([0.75 * p0[0] + 0.25 * p1[0], 0.75 * p0[1] + 0.25 * p1[1]]);
      next.push([0.25 * p0[0] + 0.75 * p1[0], 0.25 * p0[1] + 0.75 * p1[1]]);
    }
    result = next;
  }
  return result;
}

function clusterBoundary(points: [number, number][]): [number, number][] {
  const hull = convexHull(points);
  if (hull.length < 3) return hull;
  return smoothPolygon(hull);
}

/** Watches map zoom/pan and auto-focuses the nearest cluster when zoomed in. */
function MapEventHandler({
  clusters,
  phase,
  onFocusCluster,
  suppressRef,
}: {
  clusters: Record<string, Cluster>;
  phase: string;
  onFocusCluster: (cid: string | null) => void;
  suppressRef: React.MutableRefObject<boolean>;
}) {
  useMapEvents({
    moveend: () => checkFocus(),
    zoomend: () => checkFocus(),
  });

  const map = useMap();

  const checkFocus = () => {
    if (phase === "idle") return;
    if (suppressRef.current) return;
    const zoom = map.getZoom();
    if (zoom >= ZOOM_THRESHOLD) {
      const center = map.getCenter();
      let nearest: string | null = null;
      let minDist = Infinity;
      for (const [cid, cluster] of Object.entries(clusters)) {
        const [lat, lon] = cluster.centroid;
        const dist = Math.hypot(center.lat - lat, center.lng - lon);
        if (dist < minDist) {
          minDist = dist;
          nearest = cid;
        }
      }
      onFocusCluster(nearest);
    } else {
      onFocusCluster(null);
    }
  };

  return null;
}

/** Flies the map to a target when it changes. Suppresses MapEventHandler during flight. */
function MapFlyTo({
  target,
  zoom,
  suppressRef,
}: {
  target: [number, number] | null;
  zoom?: number;
  suppressRef: React.MutableRefObject<boolean>;
}) {
  const map = useMap();
  useEffect(() => {
    if (target) {
      suppressRef.current = true;
      map.flyTo(target, zoom ?? 12, { duration: 1 });
      map.once("moveend", () => {
        suppressRef.current = false;
      });
    }
  }, [target, zoom, map, suppressRef]);
  return null;
}

/** Re-centers the map when disaster changes. */
function MapRecenter({
  center,
  zoom,
}: {
  center: [number, number];
  zoom: number;
}) {
  const map = useMap();
  const prevCenter = useRef(center);
  useEffect(() => {
    if (
      center[0] !== prevCenter.current[0] ||
      center[1] !== prevCenter.current[1]
    ) {
      prevCenter.current = center;
      map.flyTo(center, zoom, { duration: 1.5 });
    }
  }, [center, zoom, map]);
  return null;
}

interface DisasterOption {
  key: string;
  label: string;
  max_posts: number;
}

const Map = () => {
  const [visiblePosts, setVisiblePosts] = useState<Post[]>([]);
  const [clusters, setClusters] = useState<Record<string, Cluster>>({});
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [sliderValue, setSliderValue] = useState(0);
  const [focusedCluster, setFocusedCluster] = useState<string | null>(null);
  const [flyTarget, setFlyTarget] = useState<[number, number] | null>(null);
  const [flyZoom, setFlyZoom] = useState<number | undefined>(undefined);
  const [analyzedPosts, setAnalyzedPosts] = useState<AnalyzedPost[]>([]);
  const [analysisStartTime, setAnalysisStartTime] = useState<number>(0);
  const [llmSummary, setLlmSummary] = useState<DispatchPlan | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [disasters, setDisasters] = useState<DisasterOption[]>([]);
  const [activeDisaster, setActiveDisaster] = useState("");
  const [mapCenter, setMapCenter] = useState<[number, number]>([18.45, -66.07]);
  const [mapZoom, setMapZoom] = useState(9);
  const [disasterLoading, setDisasterLoading] = useState(false);
  const [sampleSize, setSampleSize] = useState(500);
  const [selectedPostKey, setSelectedPostKey] = useState<string | null>(null);

  const allPostsRef = useRef<Post[]>([]);
  const clustersRef = useRef<Record<string, Cluster>>({});
  const flyingSuppressRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dripIndexRef = useRef(0);
  const dripTargetRef = useRef(0);
  const inferDoneRef = useRef(false);
  const clusterSeverityRef = useRef<Record<string, number[]>>({});
  const postSeverityRef = useRef<
    Array<{ cluster: string; weight: number; informative: boolean }>
  >([]);
  // Per-post analyzed data (scores + severity) accumulated during inference
  const analyzedPostsRef = useRef<AnalyzedPost[]>([]);

  const fetchPosts = useCallback(() => {
    return fetch("/api/posts")
      .then((res) => res.json())
      .then((data) => {
        allPostsRef.current = data.posts;
        clustersRef.current = data.clusters;
        setClusters(data.clusters);
        setTotal(data.posts.length);
        if (data.map_center) setMapCenter(data.map_center);
        if (data.map_zoom) setMapZoom(data.map_zoom);
      })
      .catch((err) => console.error("Failed to fetch posts:", err));
  }, []);

  const resetState = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setVisiblePosts([]);
    setClusters({});
    setProgress(0);
    setTotal(0);
    setPhase("idle");
    setSliderValue(0);
    setFocusedCluster(null);
    setFlyTarget(null);
    setAnalyzedPosts([]);
    setLlmSummary(null);
    setSummaryLoading(false);
    allPostsRef.current = [];
    clustersRef.current = {};
    dripIndexRef.current = 0;
    dripTargetRef.current = 0;
    inferDoneRef.current = false;
    clusterSeverityRef.current = {};
    postSeverityRef.current = [];
    analyzedPostsRef.current = [];
  }, []);

  // Fetch disaster list + initial posts on mount
  useEffect(() => {
    fetch("/api/disasters")
      .then((res) => res.json())
      .then((data) => {
        setDisasters(data.disasters ?? []);
        setActiveDisaster(data.active ?? "");
        if (data.sample) setSampleSize(data.sample);
      })
      .then(() => fetchPosts())
      .catch((err) => console.error("Failed to fetch disasters:", err));
  }, [fetchPosts]);

  const loadDisaster = (disaster: string, sample: number) => {
    if (disasterLoading) return;
    resetState();
    setDisasterLoading(true);
    fetch(`/api/load?disaster=${encodeURIComponent(disaster)}&sample=${sample}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.active) setActiveDisaster(data.active);
        if (data.sample) setSampleSize(data.sample);
        return fetchPosts();
      })
      .catch((err) => console.error("Failed to load disaster:", err))
      .finally(() => setDisasterLoading(false));
  };

  // Fetch dispatch plan when analysis completes
  useEffect(() => {
    if (phase !== "done" || analyzedPosts.length === 0) return;
    setSummaryLoading(true);
    setLlmSummary(null);

    const sevCounts: Record<string, number> = { severe: 0, mild: 0, little_or_none: 0 };
    for (const p of analyzedPosts) {
      sevCounts[p.severity_label] = (sevCounts[p.severity_label] ?? 0) + 1;
    }

    // Compute per-cluster average resource scores from analyzed posts
    const clusterPostMap: Record<string, typeof analyzedPosts> = {};
    for (const p of analyzedPosts) {
      const cid = String(p.cluster);
      if (cid === "-1") continue;
      if (!clusterPostMap[cid]) clusterPostMap[cid] = [];
      clusterPostMap[cid].push(p);
    }

    const clusterData = Object.entries(clusters).map(([cid, c]) => {
      const posts = clusterPostMap[cid] ?? [];
      const cats = ["infrastructure", "food", "shelter", "sanitation_water", "medication"];
      const avgScores: Record<string, number> = {};
      for (const cat of cats) {
        const vals = posts.map((p) => p.scores[cat] ?? 0);
        avgScores[cat] = vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : 0;
      }
      return {
        name: c.name,
        postCount: c.count,
        severity: c.combined_severity ?? "unknown",
        population: c.population ?? 0,
        resourceScores: avgScores,
      };
    });

    fetch("/api/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        totalPosts: analyzedPosts.length,
        clusterCount: Object.keys(clusters).length,
        severityDistribution: sevCounts,
        clusters: clusterData,
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.structured) {
          setLlmSummary(d.structured as DispatchPlan);
        } else {
          setLlmSummary(null);
        }
      })
      .catch(() => setLlmSummary(null))
      .finally(() => setSummaryLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, analyzedPosts.length, Object.keys(clusters).length]);

  const startDrip = () => {
    dripIndexRef.current = 0;
    dripTargetRef.current = 0;
    inferDoneRef.current = false;

    intervalRef.current = setInterval(() => {
      const i = dripIndexRef.current;
      const target = dripTargetRef.current;

      if (i >= target) return;

      const next = Math.min(i + POSTS_PER_TICK, target);
      setVisiblePosts(allPostsRef.current.slice(0, next));
      dripIndexRef.current = next;

      if (inferDoneRef.current && next >= allPostsRef.current.length) {
        clearInterval(intervalRef.current!);
        setSliderValue(allPostsRef.current.length);
        setAnalyzedPosts([...analyzedPostsRef.current]);
        setPhase("done");
      }
    }, INTERVAL_MS);
  };

  const handleRun = () => {
    if (phase === "predicting" || phase === "animating") return;
    setAnalysisStartTime(Date.now());

    if (intervalRef.current) clearInterval(intervalRef.current);
    setVisiblePosts([]);
    setProgress(0);
    setPhase("predicting");
    clusterSeverityRef.current = {};
    postSeverityRef.current = [];
    analyzedPostsRef.current = [];

    startDrip();

    const es = new EventSource("/api/predict");

    es.onmessage = (e) => {
      let data;
      try {
        data = JSON.parse(e.data);
      } catch {
        console.warn("SSE parse error, ignoring message");
        return;
      }

      if (data.type === "progress") {
        setProgress(data.current);
        setTotal(data.total);
        dripTargetRef.current = data.current;

        // Store analyzed post data and push to state periodically
        const postIdx = data.current - 1;
        if (postIdx < allPostsRef.current.length) {
          analyzedPostsRef.current.push({
            ...allPostsRef.current[postIdx],
            scores: data.scores ?? {},
            severity_label: data.severity_label ?? "little_or_none",
            informative: !!data.informative,
          });
          // Update state every 10 posts for live widget updates
          if (data.current % 10 === 0 || data.current >= data.total) {
            setAnalyzedPosts([...analyzedPostsRef.current]);
          }
        }

        const cid = String(data.cluster);
        if (cid !== "-1" && data.severity_label) {
          const WEIGHTS: Record<string, number> = {
            little_or_none: 0.1,
            mild: 0.3,
            severe: 1,
          };
          const w = WEIGHTS[data.severity_label] ?? 0;
          const isInformative = !!data.informative;
          postSeverityRef.current.push({
            cluster: cid,
            weight: w,
            informative: isInformative,
          });

          // Only informative posts contribute to real-time severity
          if (isInformative) {
            if (!clusterSeverityRef.current[cid])
              clusterSeverityRef.current[cid] = [];
            clusterSeverityRef.current[cid].push(w);

            // Batch cluster severity updates every 10 posts to reduce re-renders
            if (data.current % 10 === 0 || data.current >= data.total) {
              const updated = { ...clustersRef.current };
              for (const [sid, arr] of Object.entries(clusterSeverityRef.current)) {
                const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
                const severity =
                  avg < 0.2 ? "little_or_none" : avg < 0.3 ? "mild" : "severe";
                if (updated[sid]) {
                  updated[sid] = { ...updated[sid], combined_severity: severity };
                }
              }
              clustersRef.current = updated;
              setClusters(updated);
            }
          }
        }
      }

      if (data.type === "done") {
        es.close();
        dripTargetRef.current = allPostsRef.current.length;
        inferDoneRef.current = true;

        // Apply authoritative cluster scores from backend (includes fallback for clusters with no informative posts)
        if (data.cluster_scores) {
          const updated = { ...clustersRef.current };
          for (const [cid, scores] of Object.entries(data.cluster_scores) as [
            string,
            Record<string, unknown>,
          ][]) {
            if (updated[cid]) {
              updated[cid] = {
                ...updated[cid],
                combined_severity: scores.combined_severity as
                  | "severe"
                  | "mild"
                  | "little_or_none"
                  | undefined,
              };
            }
          }
          clustersRef.current = updated;
          setClusters(updated);
        }
      }
    };

    es.onerror = () => {
      console.error("SSE error");
      // If all progress was received, treat as done rather than resetting
      if (dripTargetRef.current >= allPostsRef.current.length) {
        inferDoneRef.current = true;
      } else {
        if (intervalRef.current) clearInterval(intervalRef.current);
        setPhase("idle");
      }
      es.close();
    };
  };

  const recomputeSeverity = (n: number) => {
    const SEVERITY_LABELS = ["little_or_none", "mild", "severe"] as const;
    const accum: Record<string, number[]> = {};
    for (let i = 0; i < n && i < postSeverityRef.current.length; i++) {
      const { cluster, weight, informative } = postSeverityRef.current[i];
      if (!informative) continue;
      if (!accum[cluster]) accum[cluster] = [];
      accum[cluster].push(weight);
    }
    const updated = { ...clustersRef.current };
    for (const [cid, meta] of Object.entries(updated)) {
      if (accum[cid]) {
        const avg = accum[cid].reduce((a, b) => a + b, 0) / accum[cid].length;
        const sev =
          avg < 0.2
            ? SEVERITY_LABELS[0]
            : avg < 0.3
              ? SEVERITY_LABELS[1]
              : SEVERITY_LABELS[2];
        updated[cid] = { ...meta, combined_severity: sev };
      } else {
        updated[cid] = { ...meta, combined_severity: undefined };
      }
    }
    clustersRef.current = updated;
    setClusters(updated);
  };

  const handleSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value);
    setSliderValue(val);
    setVisiblePosts(allPostsRef.current.slice(0, val));
    recomputeSeverity(val);
  };

  const handleFocusCluster = useCallback(
    (cid: string | null) => {
      setFocusedCluster(cid);
      setSelectedPostKey(null);
      if (cid && clusters[cid]) {
        setFlyTarget(clusters[cid].centroid);
        setFlyZoom(12);
      } else {
        setFlyTarget(mapCenter);
        setFlyZoom(mapZoom);
      }
    },
    [clusters, mapCenter, mapZoom],
  );

  const handlePostSelect = useCallback((post: Post) => {
    const key = `${post.lat},${post.lon},${post.caption}`;
    setSelectedPostKey(key);
    setFlyTarget([post.lat, post.lon]);
    setFlyZoom(14);
  }, []);

  const statusText = {
    idle: "Ready",
    predicting: `Analyzing... ${progress} / ${total}`,
    animating: `Plotting... ${visiblePosts.length} / ${total}`,
    done: `${visiblePosts.length} / ${total} posts`,
  }[phase];

  const buttonText = {
    idle: "▶ Run",
    predicting: "Analyzing...",
    animating: "Plotting...",
    done: "↺ Re-run",
  }[phase];

  const progressPct =
    phase === "predicting"
      ? total
        ? (progress / total) * 100
        : 0
      : phase === "animating" || phase === "done"
        ? total
          ? (visiblePosts.length / total) * 100
          : 0
        : 0;

  const progressColor =
    phase === "animating" || phase === "done" ? "rgba(255,255,255,0.6)" : "#6c63ff";

  return (
    <div style={{ height: "100vh", width: "100%", position: "relative" }}>
      <MapContainer
        center={mapCenter}
        zoom={mapZoom}
        zoomControl={false}
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}" />
        <PostMarkers
          posts={visiblePosts}
          clusters={clusters}
          analyzedPosts={analyzedPosts}
          selectedPostKey={selectedPostKey}
          onPostClick={(post) => {
            if (phase !== "done") return;
            const cid = String(post.cluster);
            if (cid === "-1") return;
            handleFocusCluster(cid);
          }}
        />
        {phase === "done" &&
          Object.keys(clusters).map((cid) => {
            const clusterPosts = visiblePosts.filter(
              (p) => String(p.cluster) === cid,
            );
            if (clusterPosts.length < 3) return null;
            const hull = clusterBoundary(
              clusterPosts.map((p) => [p.lat, p.lon] as [number, number]),
            );
            if (hull.length < 3) return null;
            const sev = clusters[cid]?.combined_severity ?? "little_or_none";
            const sevColor = SEV_COLORS[sev] ?? "#22c55e";
            return (
              <Polygon
                key={`boundary-${cid}`}
                positions={hull}
                pathOptions={{
                  color: sevColor,
                  weight: 1.5,
                  fill: true,
                  fillColor: sevColor,
                  fillOpacity: 0.1,
                  opacity: 0.5,
                  lineCap: "round",
                  lineJoin: "round",
                }}
              />
            );
          })}
        <MapEventHandler
          clusters={clusters}
          phase={phase}
          onFocusCluster={setFocusedCluster}
          suppressRef={flyingSuppressRef}
        />
        <MapFlyTo
          target={flyTarget}
          zoom={flyZoom}
          suppressRef={flyingSuppressRef}
        />
        <MapRecenter center={mapCenter} zoom={mapZoom} />
      </MapContainer>

      {/* ResNet branding — only in general view */}
      {!focusedCluster && (
        <div
          style={{
            position: "absolute",
            top: 18,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1001,
            pointerEvents: "none",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span
            style={{
              fontSize: 30,
              fontWeight: 400,
              color: "white",
              letterSpacing: "0.02em",
              fontFamily: '"Share Tech", sans-serif',
              textShadow: "0 2px 16px rgba(0,0,0,0.5)",
            }}
          >
            Res<span style={{ color: "#6c63ff" }}>Net</span>
          </span>
          <span
            style={{
              fontSize: 12,
              fontWeight: 400,
              color: "rgba(255,255,255,0.35)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              fontFamily: '"Share Tech", sans-serif',
              textShadow: "0 1px 8px rgba(0,0,0,0.4)",
            }}
          >
            Post-Crisis Resource Allocation
          </span>
        </div>
      )}

      {/* Analysis widgets overlay — sits above the map */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 1000,
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            pointerEvents: "none",
          }}
        >
          <AnalysisSidebar
            clusters={clusters}
            analyzedPosts={analyzedPosts}
            phase={phase}
            sliderValue={sliderValue}
            focusedCluster={focusedCluster}
            onFocusCluster={handleFocusCluster}
            onPostSelect={handlePostSelect}
            analysisStartTime={analysisStartTime}
            dispatchPlan={llmSummary}
            summaryLoading={summaryLoading}
          />
          {/* Floating cluster name banner */}
          {focusedCluster && clusters[focusedCluster] && (
            <div
              style={{
                position: "absolute",
                top: 18,
                left: "50%",
                transform: "translateX(-50%)",
                zIndex: 1001,
                pointerEvents: "none",
                fontSize: 28,
                fontWeight: 700,
                color: "white",
                textShadow: "0 2px 16px rgba(0,0,0,0.6), 0 0 40px rgba(0,0,0,0.3)",
                letterSpacing: "-0.02em",
                whiteSpace: "nowrap",
              }}
            >
              {clusters[focusedCluster].name}
              {clusters[focusedCluster].state && (
                <span style={{ fontWeight: 400, opacity: 0.6, fontSize: 20, marginLeft: 8 }}>
                  {clusters[focusedCluster].state}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div
        style={{
          ...glassStyle,
          position: "absolute",
          bottom: 32,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 1000,
          borderRadius: 12,
          padding: "12px 20px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          minWidth: 340,
          color: "white",
        }}
      >
        {/* Disaster + sample selectors */}
        {phase === "idle" || phase === "done" ? (
          <div style={{ display: "flex", gap: 8, width: "100%" }}>
            <select
              value={activeDisaster}
              onChange={(e) => loadDisaster(e.target.value, sampleSize)}
              disabled={disasterLoading}
              style={{
                flex: 1,
                background: "rgba(255,255,255,0.04)",
                backdropFilter: "blur(12px)",
                WebkitBackdropFilter: "blur(12px)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 6,
                color: "white",
                padding: "6px 8px",
                fontSize: 12,
                fontWeight: 600,
                cursor: disasterLoading ? "wait" : "pointer",
                outline: "none",
              }}
            >
              {disasters.map((d) => (
                <option
                  key={d.key}
                  value={d.key}
                  style={{ background: "#161922" }}
                >
                  {d.label}
                </option>
              ))}
            </select>
            <select
              value={sampleSize}
              onChange={(e) =>
                loadDisaster(activeDisaster, parseInt(e.target.value))
              }
              disabled={disasterLoading}
              style={{
                background: "rgba(255,255,255,0.04)",
                backdropFilter: "blur(12px)",
                WebkitBackdropFilter: "blur(12px)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 6,
                color: "white",
                padding: "6px 8px",
                fontSize: 12,
                fontWeight: 600,
                cursor: disasterLoading ? "wait" : "pointer",
                outline: "none",
                minWidth: 80,
              }}
            >
              {[100, 250, 500, 1000, 2000]
                .filter((n) => {
                  const d = disasters.find((d) => d.key === activeDisaster);
                  return !d || n <= d.max_posts;
                })
                .map((n) => (
                  <option key={n} value={n} style={{ background: "#161922" }}>
                    {n} posts
                  </option>
                ))}
              {(() => {
                const d = disasters.find((d) => d.key === activeDisaster);
                if (d && ![100, 250, 500, 1000, 2000].includes(d.max_posts)) {
                  return (
                    <option
                      value={d.max_posts}
                      style={{ background: "#161922" }}
                    >
                      All ({d.max_posts})
                    </option>
                  );
                }
                return null;
              })()}
            </select>
          </div>
        ) : null}

        {/* Phase indicators */}
        <div style={{ display: "flex", gap: 6, width: "100%" }}>
          {[
            { label: "Collect + Cluster", phase: "idle" },
            { label: "CLIP + Model", phase: "predicting" },
            { label: "Results", phase: "done" },
          ].map((s, i) => {
            const stepNum = i + 1;
            const isActive =
              phase === s.phase ||
              (stepNum === 2 && phase === "predicting") ||
              (stepNum === 3 && (phase === "animating" || phase === "done"));
            const isDone =
              stepNum === 1 ||
              (stepNum === 2 && (phase === "animating" || phase === "done"));
            return (
              <div
                key={i}
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 8px",
                  borderRadius: 6,
                  background: isDone ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.03)",
                  border: `1px solid ${isDone ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.06)"}`,
                  backdropFilter: "blur(12px)",
                  WebkitBackdropFilter: "blur(12px)",
                }}
              >
                <div
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: "50%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 11,
                    fontWeight: 700,
                    flexShrink: 0,
                    border: `2px solid ${isDone ? "rgba(255,255,255,0.4)" : isActive ? "#6c63ff" : "rgba(255,255,255,0.12)"}`,
                    color: isDone ? "#fff" : isActive ? "#6c63ff" : "#555",
                    background: isDone ? "rgba(255,255,255,0.15)" : "transparent",
                  }}
                >
                  {isDone ? "✓" : stepNum}
                </div>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: isActive || isDone ? "#e0e0e0" : "#555",
                  }}
                >
                  {s.label}
                </span>
              </div>
            );
          })}
        </div>

        {/* Progress bar */}
        <div
          style={{
            width: "100%",
            height: 6,
            background: "rgba(255,255,255,0.06)",
            borderRadius: 3,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              borderRadius: 3,
              width: `${progressPct}%`,
              background: progressColor,
              transition: "width 0.15s linear",
            }}
          />
        </div>

        <div style={{ fontSize: 11, color: "#888" }}>{statusText}</div>

        {/* Timeline slider — visible after analysis */}
        {phase === "done" && total > 0 && (
          <input
            type="range"
            min={0}
            max={total}
            value={sliderValue}
            onChange={handleSlider}
            style={{ width: "100%", accentColor: "#6c63ff", cursor: "pointer" }}
          />
        )}

        <button
          onClick={handleRun}
          disabled={
            phase === "predicting" ||
            phase === "animating" ||
            disasterLoading ||
            total === 0
          }
          style={{
            width: "100%",
            padding: "7px 0",
            borderRadius: 6,
            border: "none",
            background:
              phase === "predicting" ||
              phase === "animating" ||
              disasterLoading ||
              total === 0
                ? "#3a3d4a"
                : "#6c63ff",
            color: "white",
            cursor:
              phase === "predicting" ||
              phase === "animating" ||
              disasterLoading ||
              total === 0
                ? "default"
                : "pointer",
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          {buttonText}
        </button>
      </div>
    </div>
  );
};

export default Map;
