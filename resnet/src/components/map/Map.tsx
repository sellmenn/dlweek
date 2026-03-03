import 'leaflet/dist/leaflet.css';
import { MapContainer, TileLayer } from "react-leaflet";
import PostMarkers from "./cluster.tsx";
import { useEffect, useState, useRef } from "react";
import type { Post } from '../../types/post';
import type { Cluster } from '../../types/cluster';

type Phase = 'idle' | 'predicting' | 'done';

const Map = () => {
    const [visiblePosts, setVisiblePosts] = useState<Post[]>([]);
    const [clusters, setClusters]         = useState<Record<string, Cluster>>({});
    const [phase, setPhase]               = useState<Phase>('idle');
    const [progress, setProgress]         = useState({ current: 0, total: 0 });

    // Fetch clusters on mount (no posts yet — those stream in via SSE)
    useEffect(() => {
        fetch('http://localhost:8000/api/posts')
            .then(r => r.json())
            .then(data => setClusters(data.clusters))
            .catch(err => console.error('Failed to fetch:', err));
    }, []);

    const handleRun = () => {
        if (phase === 'predicting') return;

        // Reset
        setVisiblePosts([]);
        setProgress({ current: 0, total: 0 });
        setPhase('predicting');

        const es = new EventSource('http://localhost:8000/api/predict');

        es.onmessage = (e) => {
            const data = JSON.parse(e.data);

            if (data.type === 'progress') {
                setProgress({ current: data.current, total: data.total });
                // Drop the dot on the map immediately
                setVisiblePosts(prev => [...prev, data.post]);
            }

            if (data.type === 'done') {
                es.close();
                // Swap in final scored posts + updated cluster severities
                setVisiblePosts(data.posts);
                setClusters(prev => {
                    const updated = { ...prev };
                    Object.entries(data.cluster_scores).forEach(([id, scores]: [string, any]) => {
                        if (updated[id]) updated[id] = { ...updated[id], combined_severity: scores.combined_severity };
                    });
                    return updated;
                });
                setPhase('done');
            }
        };

        es.onerror = () => { setPhase('idle'); es.close(); };
    };

    const pct = progress.total ? (progress.current / progress.total) * 100 : 0;

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
                padding: '14px 20px', display: 'flex', flexDirection: 'column',
                alignItems: 'stretch', gap: 8, minWidth: 320, color: 'white',
            }}>
                {/* Progress bar */}
                <div style={{ height: 4, background: '#262938', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{
                        height: '100%', borderRadius: 2, background: phase === 'done' ? '#22c55e' : '#6c63ff',
                        width: `${pct}%`, transition: 'width 0.1s linear',
                    }} />
                </div>

                {/* Status */}
                <div style={{ fontSize: 11, color: '#888', textAlign: 'center' }}>
                    {phase === 'idle'       && 'Ready — click Run to analyse posts'}
                    {phase === 'predicting' && `Analysing… ${progress.current} / ${progress.total}`}
                    {phase === 'done'       && `✓ ${visiblePosts.length} posts plotted`}
                </div>

                {/* Button */}
                <button onClick={handleRun} disabled={phase === 'predicting'} style={{
                    padding: '7px 0', borderRadius: 6, border: 'none', fontWeight: 600, fontSize: 13,
                    background: phase === 'predicting' ? '#3a3d4a' : '#6c63ff',
                    color: 'white', cursor: phase === 'predicting' ? 'default' : 'pointer',
                }}>
                    {phase === 'predicting' ? 'Analysing…' : phase === 'done' ? '↺ Re-run' : '▶ Run'}
                </button>
            </div>
        </div>
    );
};

export default Map;
