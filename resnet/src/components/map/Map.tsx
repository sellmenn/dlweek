import 'leaflet/dist/leaflet.css';
import { MapContainer, TileLayer } from "react-leaflet";
import PostMarkers from "./cluster.tsx";



const Map = () => {
  return (
      <div style={{ height: '100vh', width: '100%' }}>
        <MapContainer
            center={[16.7253, 93.0195]}
            zoom={12}
            style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
              url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
          />
          <PostMarkers posts={SYNTHETIC_POSTS} clusters={SYNTHETIC_CLUSTERS} />
        </MapContainer>
      </div>
  );
};

export default Map;