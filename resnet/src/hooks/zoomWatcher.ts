// Component that watches zoom changes
import {useMap} from "react-leaflet";
import {useEffect} from "react";

export function ZoomWatcher({ incidents, onSelect, onClear }) {
    const map = useMap();

    useEffect(() => {
        const handleMoveEnd = () => {
            const zoom = map.getZoom();

            if (zoom < 13) {
                onClear();  // zoomed out → back to global dashboard
                return;
            }

            // Find the incident closest to current map center
            const center = map.getCenter();
            let closest = null;
            let minDist = Infinity;

            incidents.forEach(incident => {
                const dist = map.distance(center, [incident.lat, incident.lng]);
                if (dist < minDist) {
                    minDist = dist;
                    closest = incident;
                }
            });

            if (closest && minDist < 500) {  // within 500m of center
                onSelect(closest);
            }
        };

        map.on('moveend', handleMoveEnd);
        return () => map.off('moveend', handleMoveEnd);
    }, [map, incidents]);

    return null;
}