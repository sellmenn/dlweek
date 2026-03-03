import 'leaflet/dist/leaflet.css';
import { MapContainer, TileLayer } from "react-leaflet";
import PostMarkers from "./cluster.tsx";
import { useEffect, useState, useRef } from "react";
import type { Post } from '../../types/post';
import type { Cluster } from '../../types/cluster';

const POSTS_PER_TICK = 5;
const INTERVAL_MS = 20;

type Phase = 'idle' | 'predicting' | 'animating' | 'done';

const Map = () => {
    const [visiblePosts, setVisiblePosts] = useState<Post[]>([]);
    const [clusters, setClusters] = useState<Record<string, Cluster>>({});
    const [progress, setProgress] = useState(0);
    const [total, setTotal] = useState(0);
    const [phase, setPhase] = useState<Phase>('idle');

    const allPostsRef = useRef<Post[]>([]);
    const clustersRef = useRef<Record<string, Cluster>>({});
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const dripIndexRef = useRef(0);

    useEffect(() => {
        fetch('http://localhost:8000/api/posts')
            .then(res => res.json())
            .then(data => {
                allPostsRef.current = data.posts;
                clustersRef.current = data.clusters;
                setClusters(data.clusters);
                setTotal(data.posts.length);
            })
            .catch(err => console.error('Failed to fetch posts:', err));
    }, []);

    const startDrip = (posts: Post[]) => {
        dripIndexRef.current = 0;
        setVisiblePosts([]);
        setPhase('animating');

        intervalRef.current = setInterval(() => {
            const i = dripIndexRef.current;
            if (i >= posts.length) {
                clearInterval(intervalRef.current!);
                setPhase('done');
                return;
            }
            setVisiblePosts(posts.slice(0, i + POSTS_PER_TICK));
            dripIndexRef.current += POSTS_PER_TICK;
        }, INTERVAL_MS);
    };

    const handleRun = () => {
        if (phase === 'predicting' || phase === 'animating') return;

        // Reset
        if (intervalRef.current) clearInterval(intervalRef.current);
        setVisiblePosts([]);
        setProgress(0);
        setPhase('predicting');

        const es = new EventSource('http://localhost:8000/api/predict');

        es.onmessage = (e) => {
            const data = JSON.parse(e.data);

            if (data.type === 'progress') {
                setProgress(data.current);
            }

            if (data.type === 'done') {
                es.close();

                // Merge severity into clusters
                const updatedClusters = { ...clustersRef.current };
                Object.entries(data.cluster_scores).forEach(([id, scores]: [string, any]) => {
                    if (updatedClusters[id]) {
                        updatedClusters[id] = { ...updatedClusters[id], combined_severity: scores.combined_severity };
                    }
                });
                setClusters(updatedClusters);
                clustersRef.current = updatedClusters;

                startDrip(allPostsRef.current);
            }
        };

        es.onerror = () => {
            console.error('SSE error');
            setPhase('idle');
            es.close();
        };
    };

    const statusText = {
        idle: 'Ready',
        predicting: `Analyzing... ${progress} / ${total}`,
        animating: `Plotting... ${visiblePosts.length} / ${total}`,
        done: `✓ Done — ${visiblePosts.length} posts`,
    }[phase];

    const buttonText = {
        idle: '▶ Run',
        predicting: 'Analyzing...',
        animating: 'Plotting...',
        done: '↺ Re-run',
    }[phase];

    const progressPct = phase === 'predicting'
        ? (total ? (progress / total) * 100 : 0)
        : phase === 'animating' || phase === 'done'
            ? (total ? (visiblePosts.length / total) * 100 : 0)
            : 0;

    const progressColor = phase === 'animating' || phase === 'done' ? '#22c55e' : '#6c63ff';

    return (
        <div style={{ height: '100vh', width: '100%', position: 'relative' }}>
            <MapContainer center={[18.45, -66.07]} zoom={9} style={{ height: '100%', width: '100%' }}>
                <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}" />
                <PostMarkers posts={visiblePosts} clusters={clusters} />
            </MapContainer>

            <div style={{
                position: 'absolute', bottom: 32, left: '50%', transform: 'translateX(-50%)',
                zIndex: 1000, background: 'rgba(22,25,34,0.92)', backdropFilter: 'blur(8px)',
                border: '1px solid #2a2d3a', borderRadius: 12,
                padding: '12px 20px', display: 'flex', flexDirection: 'column',
                alignItems: 'center', gap: 8, minWidth: 340, color: 'white',
            }}>

                {/* Phase indicators */}
                <div style={{ display: 'flex', gap: 6, width: '100%' }}>
                    {[
                        { label: 'Collect + Cluster', phase: 'idle' },
                        { label: 'CLIP + Model',      phase: 'predicting' },
                        { label: 'Results',           phase: 'done' },
                    ].map((s, i) => {
                        const stepNum = i + 1;
                        const isActive = phase === s.phase || (stepNum === 2 && phase === 'predicting') || (stepNum === 3 && (phase === 'animating' || phase === 'done'));
                        const isDone = (stepNum === 1) || (stepNum === 2 && (phase === 'animating' || phase === 'done'));
                        return (
                            <div key={i} style={{
                                flex: 1, display: 'flex', alignItems: 'center', gap: 6,
                                padding: '6px 8px', borderRadius: 6,
                                background: '#1e2130',
                            }}>
                                <div style={{
                                    width: 22, height: 22, borderRadius: '50%', display: 'flex',
                                    alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700,
                                    flexShrink: 0, border: `2px solid ${isDone ? '#2ecc71' : isActive ? '#6c63ff' : '#3a3d4a'}`,
                                    color: isDone ? '#fff' : isActive ? '#6c63ff' : '#555',
                                    background: isDone ? '#2ecc71' : 'transparent',
                                }}>
                                    {isDone ? '✓' : stepNum}
                                </div>
                                <span style={{ fontSize: 10, fontWeight: 600, color: isActive || isDone ? '#e0e0e0' : '#555' }}>
                  {s.label}
                </span>
                            </div>
                        );
                    })}
                </div>

                {/* Progress bar */}
                <div style={{ width: '100%', height: 6, background: '#262938', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{
                        height: '100%', borderRadius: 3,
                        width: `${progressPct}%`,
                        background: progressColor,
                        transition: 'width 0.15s linear',
                    }} />
                </div>

                <div style={{ fontSize: 11, color: '#888' }}>{statusText}</div>

                <button
                    onClick={handleRun}
                    disabled={phase === 'predicting' || phase === 'animating'}
                    style={{
                        width: '100%', padding: '7px 0', borderRadius: 6, border: 'none',
                        background: phase === 'predicting' || phase === 'animating' ? '#3a3d4a' : '#6c63ff',
                        color: 'white', cursor: phase === 'predicting' || phase === 'animating' ? 'default' : 'pointer',
                        fontWeight: 600, fontSize: 13,
                    }}
                >
                    {buttonText}
                </button>
            </div>
        </div>
    );
};

export default Map;
