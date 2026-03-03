import 'leaflet/dist/leaflet.css';
import { MapContainer, TileLayer } from "react-leaflet";
import PostMarkers from "./cluster.tsx";
import { useEffect, useState } from "react";
import type { Post } from '../../types/post';
import type { Cluster } from '../../types/cluster';

const Map = () => {
    const [posts, setPosts] = useState<Post[]>([]);
    const [clusters, setClusters] = useState<Record<string, Cluster>>({});

    useEffect(() => {
        fetch('http://localhost:8000/api/posts')
            .then(res => res.json())
            .then(data => {
                setPosts(data.posts);
                setClusters(data.clusters);
            })
            .catch(err => console.error('Failed to fetch posts:', err));
    }, []);

    return (
        <div style={{ height: '100vh', width: '100%' }}>
            <MapContainer
                center={[18.45, -66.07]}
                zoom={9}
                style={{ height: '100%', width: '100%' }}
            >
                <TileLayer
                    url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
                />
                <PostMarkers posts={posts} clusters={clusters} />
            </MapContainer>
        </div>
    );
};

export default Map;