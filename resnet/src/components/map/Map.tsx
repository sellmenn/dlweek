import "leaflet/dist/leaflet.css";
import { MapContainer, TileLayer, useMap, useMapEvents } from "react-leaflet";
import PostMarkers from "./cluster.tsx";
import AnalysisSidebar from "./AnalysisSidebar.tsx";
import { useEffect, useState, useRef, useCallback } from "react";
import type { Post, AnalyzedPost } from "../../types/post";
import type { Cluster } from "../../types/cluster";

const POSTS_PER_TICK = 5;
const INTERVAL_MS = 20;
const ZOOM_THRESHOLD = 11;

type Phase = "idle" | "predicting" | "animating" | "done";

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
  suppressRef,
}: {
  target: [number, number] | null;
  suppressRef: React.MutableRefObject<boolean>;
}) {
  const map = useMap();
  useEffect(() => {
    if (target) {
      suppressRef.current = true;
      map.flyTo(target, 12, { duration: 1 });
      map.once("moveend", () => {
        suppressRef.current = false;
      });
    }
  }, [target, map, suppressRef]);
  return null;
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
  const [analyzedPosts, setAnalyzedPosts] = useState<AnalyzedPost[]>([]);
  const [analysisStartTime, setAnalysisStartTime] = useState<number>(0);
  const [llmSummary, setLlmSummary] = useState("");
  const [summaryLoading, setSummaryLoading] = useState(false);

  const allPostsRef = useRef<Post[]>([]);
  const clustersRef = useRef<Record<string, Cluster>>({});
  const flyingSuppressRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dripIndexRef = useRef(0);
  const dripTargetRef = useRef(0);
  const inferDoneRef = useRef(false);
  const clusterSeverityRef = useRef<Record<string, number[]>>({});
  const postSeverityRef = useRef<Array<{ cluster: string; weight: number }>>(
    [],
  );
  // Per-post analyzed data (scores + severity) accumulated during inference
  const analyzedPostsRef = useRef<AnalyzedPost[]>([]);

  useEffect(() => {
    fetch("/api/posts")
      .then((res) => res.json())
      .then((data) => {
        allPostsRef.current = data.posts;
        clustersRef.current = data.clusters;
        setClusters(data.clusters);
        setTotal(data.posts.length);
      })
      .catch((err) => console.error("Failed to fetch posts:", err));
  }, []);

  // Fetch LLM summary when analysis completes
  useEffect(() => {
    if (phase !== "done" || analyzedPosts.length === 0) return;
    setSummaryLoading(true);
    setLlmSummary("");

    const sevCounts: Record<string, number> = {
      severe: 0,
      mild: 0,
      little_or_none: 0,
    };
    for (const p of analyzedPosts) {
      sevCounts[p.severity_label] = (sevCounts[p.severity_label] ?? 0) + 1;
    }

    const clusterData = Object.entries(clusters).map(([cid, c]) => ({
      name: c.name,
      postCount: c.count,
      severity: c.combined_severity ?? "unknown",
    }));

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
      .then((d) => setLlmSummary(d.summary ?? "No summary available."))
      .catch(() => setLlmSummary("Failed to generate summary."))
      .finally(() => setSummaryLoading(false));
  }, [phase, analyzedPosts, clusters]);

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
          postSeverityRef.current.push({ cluster: cid, weight: w });
          if (!clusterSeverityRef.current[cid])
            clusterSeverityRef.current[cid] = [];
          clusterSeverityRef.current[cid].push(w);

          const arr = clusterSeverityRef.current[cid];
          const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
          const severity =
            avg < 0.2 ? "little_or_none" : avg < 0.3 ? "mild" : "severe";

          const updated = { ...clustersRef.current };
          if (updated[cid]) {
            updated[cid] = { ...updated[cid], combined_severity: severity };
            clustersRef.current = updated;
            setClusters(updated);
          }
        }

        // If this is the last progress event, treat as done
        if (data.current >= data.total) {
          es.close();
          dripTargetRef.current = allPostsRef.current.length;
          inferDoneRef.current = true;
        }
      }

      if (data.type === "done") {
        es.close();
        dripTargetRef.current = allPostsRef.current.length;
        inferDoneRef.current = true;
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
      const { cluster, weight } = postSeverityRef.current[i];
      if (!accum[cluster]) accum[cluster] = [];
      accum[cluster].push(weight);
    }
    const updated = { ...clustersRef.current };
    for (const [cid, meta] of Object.entries(updated)) {
      if (accum[cid]) {
        const avg = accum[cid].reduce((a, b) => a + b, 0) / accum[cid].length;
        const sev =
          avg < 0.33
            ? SEVERITY_LABELS[0]
            : avg < 0.66
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
      if (cid && clusters[cid]) {
        setFlyTarget(clusters[cid].centroid);
      } else {
        setFlyTarget(null);
      }
    },
    [clusters],
  );

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
    phase === "animating" || phase === "done" ? "#22c55e" : "#6c63ff";

  return (
    <div style={{ height: "100vh", width: "100%", position: "relative" }}>
      <MapContainer
        center={[18.45, -66.07]}
        zoom={9}
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}" />
        <PostMarkers
          posts={visiblePosts}
          clusters={clusters}
          analyzedPosts={analyzedPosts}
          onPostClick={(post) => {
            if (phase !== "done") return;
            const cid = String(post.cluster);
            if (cid === "-1") return;
            handleFocusCluster(cid);
          }}
        />
        <MapEventHandler
          clusters={clusters}
          phase={phase}
          onFocusCluster={setFocusedCluster}
          suppressRef={flyingSuppressRef}
        />
        <MapFlyTo target={flyTarget} suppressRef={flyingSuppressRef} />
      </MapContainer>

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
            analysisStartTime={analysisStartTime}
            llmSummary={llmSummary}
            summaryLoading={summaryLoading}
          />
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 32,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 1000,
          background: "rgba(22,25,34,0.92)",
          backdropFilter: "blur(8px)",
          border: "1px solid #2a2d3a",
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
                  background: "#1e2130",
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
                    border: `2px solid ${isDone ? "#2ecc71" : isActive ? "#6c63ff" : "#3a3d4a"}`,
                    color: isDone ? "#fff" : isActive ? "#6c63ff" : "#555",
                    background: isDone ? "#2ecc71" : "transparent",
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
            background: "#262938",
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
          disabled={phase === "predicting" || phase === "animating"}
          style={{
            width: "100%",
            padding: "7px 0",
            borderRadius: 6,
            border: "none",
            background:
              phase === "predicting" || phase === "animating"
                ? "#3a3d4a"
                : "#6c63ff",
            color: "white",
            cursor:
              phase === "predicting" || phase === "animating"
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
