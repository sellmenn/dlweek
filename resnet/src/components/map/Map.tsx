import { useEffect, useState } from "react";
import 'leaflet/dist/leaflet.css';
import {MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap} from "react-leaflet";
import L from 'leaflet';
import { useLocationStore } from "../../stores/locationStore.ts";
import MyLocationIcon from '@mui/icons-material/MyLocation';
import { useSession } from "../../contexts/SessionContext.tsx";
import { useNavigate } from "react-router-dom";
import personPinIcon from "../../assets/icons/person-pin.svg";
import {displayTime} from "../../utils/timeFunctions.ts";
import {routeService} from "@/services/routeService.ts";
import {workoutService} from "@/services/workoutService.ts";
import type {Workout} from "../../../../types/workout.ts";

const workoutMarkerIcon = L.divIcon({
  html: `
    <div style="
      width: 24px;
      height: 24px;
      background-color: #8685AD;
      border: 3px solid white;
      border-radius: 50%;
      box-shadow: 0 0 8px #8685AD;
    "></div>
  `,
  className: 'workout-marker',
});

const clusterMarkerIcon = (count: number) => L.divIcon({
  html: `
    <div style="position: relative;">
      <div style="
        width: 24px;
        height: 24px;
        background-color: #8685AD;
        border: 3px solid white;
        border-radius: 50%;
        box-shadow: 0 0 8px #8685AD;
      "></div>
      <div style="
        position: absolute;
        top: -8px;
        right: -8px;
        width: 20px;
        height: 20px;
        background-color: #FF4444;
        border: 2px solid white;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: bold;
        color: white;
        font-size: 11px;
      ">${count}</div>
    </div>
  `,
  className: 'cluster-marker',
  iconSize: [24, 24],
});

const currentLocationIcon = L.icon({
  iconUrl: personPinIcon,
  iconSize: [48, 48],
  iconAnchor: [16, 32],
});

function RecenterMap({ position }) {
  const map = useMap();
  useEffect(() => {
    if (position) {
      map.setView(position, map.getZoom());
    }
  }, []);
  return null;
}

function RecenterButton({ position }) {
  const map = useMap();
  const handleRecenter = () => {
    if (position) {
      map.setView(position, map.getZoom());
    }
  };
  return (
      <button
          onClick={handleRecenter}
          className="absolute bottom-1/7 right-6 bg-accent-dark p-3 rounded-full shadow-lg z-[999]"
      >
        <MyLocationIcon sx={{ color: 'white', fontSize: 30 }} />
      </button>
  );
}

function TimePeriodFilter({ selectedPeriod, onPeriodChange }) {
  return (
      <div className="absolute top-[env(safe-area-inset-top)] mt-4 left-1/2 -translate-x-1/2 bg-[#C4C4C4] rounded-full flex gap-1 shadow-lg z-[999]">
        {['w', 'm', 'y'].map((period) => (
            <button
                key={period}
                onClick={() => onPeriodChange(period)}
                className={`px-8 py-2 rounded-full font-heading transition-all duration-300 ${
                    selectedPeriod === period
                        ? 'bg-accent text-white'
                        : 'bg-transparent text-[#6F6F6F]'
                }`}
            >
              {period === 'w' ? 'Week' : period === 'm' ? 'Month' : 'Year'}
            </button>
        ))}
      </div>
  );
}

// Clustering logic
function clusterWorkouts(workouts: Workout[], zoom: number) {
  const threshold = zoom < 15 ? 0.005 : zoom < 17 ? 0.001 : 0.0003;

  const clusters: Workout[][] = [];
  const processed = new Set<number>();

  workouts.forEach((workout, idx) => {
    if (processed.has(idx)) return;

    const cluster = [workout];
    processed.add(idx);

    workouts.forEach((other, otherIdx) => {
      if (processed.has(otherIdx)) return;

      const distance = Math.sqrt(
          Math.pow(workout.start_location.lat - other.start_location.lat, 2) +
          Math.pow(workout.start_location.lng - other.start_location.lng, 2)
      );

      if (distance < threshold) {
        cluster.push(other);
        processed.add(otherIdx);
      }
    });

    clusters.push(cluster);
  });

  return clusters;
}

function WorkoutClusters({ workouts, activeTooltip, setActiveTooltip, tooltipPosition, setTooltipPosition, handleTooltipClick }) {
  const map = useMap();
  const [zoom, setZoom] = useState(map.getZoom());

  useEffect(() => {
    const handleZoom = () => setZoom(map.getZoom());
    map.on('zoom', handleZoom);
    return () => map.off('zoom', handleZoom);
  }, [map]);

  const clusters = clusterWorkouts(workouts, zoom);

  const handleWorkoutClick = (workoutId, latlng) => {
    if (activeTooltip === workoutId) {
      setActiveTooltip(null);
      setTooltipPosition(null);
    } else {
      setActiveTooltip(workoutId);
      setTooltipPosition(latlng);
    }
  };

  const handleClusterClick = (clusterIdx, latlng) => {
    if (activeTooltip === `cluster-${clusterIdx}`) {
      setActiveTooltip(null);
      setTooltipPosition(null);
    } else {
      setActiveTooltip(`cluster-${clusterIdx}`);
      setTooltipPosition(latlng);
    }
  };

  return (
      <>
        {clusters.map((cluster, clusterIdx) => {
          const centerLat = cluster.reduce((sum, w) => sum + w.start_location.lat, 0) / cluster.length;
          const centerLng = cluster.reduce((sum, w) => sum + w.start_location.lng, 0) / cluster.length;

          if (cluster.length === 1) {
            // Single workout - render as before
            const workout = cluster[0];
            const workoutPos = [
              workout.start_location.lat,
              workout.start_location.lng,
            ];

            return (
                <div key={workout.id}>
                  {/* Start location marker */}
                  <Marker
                      position={workoutPos}
                      icon={workoutMarkerIcon}
                      eventHandlers={{
                        click: (e) => handleWorkoutClick(workout.id, e.latlng),
                      }}
                  />

                  {/* Route and end marker for distance-based workouts */}
                  {workout.is_distance_based && workout.route?.positions && (
                      <>
                        <Polyline
                            positions={workout.route.positions.map(pos => [pos.lat, pos.lng])}
                            pathOptions={{
                              color: '#8685AD',
                              weight: 8,
                              lineJoin: 'round',
                              lineCap: 'round',
                            }}
                            eventHandlers={{
                              click: (e) => handleWorkoutClick(workout.id, e.latlng),
                            }}
                        />
                        <Marker
                            position={[workout.end_location.lat, workout.end_location.lng]}
                            icon={workoutMarkerIcon}
                            eventHandlers={{
                              click: (e) => handleWorkoutClick(workout.id, e.latlng),
                            }}
                        />
                      </>
                  )}

                  {/* Tooltip */}
                  {activeTooltip === workout.id && tooltipPosition && (
                      <Marker
                          position={[tooltipPosition.lat, tooltipPosition.lng]}
                          icon={L.divIcon({
                            html: '',
                            className: 'invisible-marker',
                            iconSize: [0, 0]
                          })}
                      >
                        <Tooltip
                            direction="top"
                            offset={[0, 0]}
                            permanent
                            interactive={true}
                        >
                          <div
                              className="px-2"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleTooltipClick(workout);
                              }}
                              onMouseDown={(e) => e.stopPropagation()}
                              onTouchStart={(e) => e.stopPropagation()}
                          >
                            <h1 className="font-body text-xs text-black font-bold capitalize">{workout.activity}</h1>
                            <p className="font-body text-black">
                              {new Date(workout.start_time).toLocaleDateString([], {day: 'numeric', month: 'short'})}  •  {displayTime(workout.duration)}
                            </p>
                            <p className="font-body text-black/70">
                              Tap to view more
                            </p>
                          </div>
                        </Tooltip>
                      </Marker>
                  )}
                </div>
            );
          }

          // Multiple workouts - show cluster marker
          return (
              <div key={`cluster-${clusterIdx}`}>
                <Marker
                    position={[centerLat, centerLng]}
                    icon={clusterMarkerIcon(cluster.length)}
                    eventHandlers={{
                      click: (e) => handleClusterClick(clusterIdx, e.latlng),
                    }}
                />

                {/* Cluster tooltip */}
                {activeTooltip === `cluster-${clusterIdx}` && tooltipPosition && (
                    <Marker
                        position={[tooltipPosition.lat, tooltipPosition.lng]}
                        icon={L.divIcon({
                          html: '',
                          className: 'invisible-marker',
                          iconSize: [0, 0]
                        })}
                    >
                      <Tooltip
                          direction="top"
                          offset={[0, 0]}
                          permanent
                          interactive={true}
                      >
                        <div className="max-h-48 overflow-y-auto">
                          {cluster.map((workout) => (
                              <div
                                  key={workout.id}
                                  className="px-2 py-2 hover:bg-gray-100 cursor-pointer border-b last:border-b-0"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleTooltipClick(workout);
                                  }}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onTouchStart={(e) => e.stopPropagation()}
                              >
                                <h1 className="font-body text-xs text-black font-bold capitalize">{workout.activity}</h1>
                                <p className="font-body text-black">
                                  {new Date(workout.start_time).toLocaleDateString([], {day: 'numeric', month: 'short'})}  •  {displayTime(workout.duration)}
                                </p>
                                <p className="font-body text-black/70">
                                  Tap to view more
                                </p>
                              </div>
                          ))}
                        </div>
                      </Tooltip>
                    </Marker>
                )}
              </div>
          );
        })}
      </>
  );
}

const Map = () => {
  const { user } = useSession();
  const { currentLocation, getCurrentLocation } = useLocationStore();
  const navigate = useNavigate();
  const [selectedPeriod, setSelectedPeriod] = useState('w');
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [activeTooltip, setActiveTooltip] = useState(null);
  const [tooltipPosition, setTooltipPosition] = useState(null);

  useEffect(() => {
    getCurrentLocation();
  }, []);

  useEffect(() => {
    const fetchWorkouts = async () => {
      if (!user) {
        console.log('No user found');
        return;
      }

      try {
        const data = await workoutService.getUserWorkouts(selectedPeriod);

        // Fetch routes for distance-based workouts
        const workoutsWithRoutes = await Promise.all(
            data.map(async (workout) => {
              if (workout.is_distance_based && workout.route_id) {
                try {
                  const route = await routeService.getRoute(workout.route_id);
                  // Store the complete route object instead of just positions
                  return { ...workout, route: route };
                } catch (error) {
                  console.error(`Error fetching route for workout ${workout.id}:`, error);
                  return workout;
                }
              }
              return workout;
            })
        );

        console.log('Fetched workouts with routes:', workoutsWithRoutes);
        setWorkouts(workoutsWithRoutes);
      } catch (error) {
        console.error('Error fetching workouts:', error);
      }
    };

    fetchWorkouts();
  }, [selectedPeriod, user]);

  const handleTooltipClick = (workout) => {
    console.log('Navigating to workout:', workout);
    navigate('/workout-details', {
      state: {
        workout
      }
    });
  };

  const position = currentLocation
      ? [currentLocation.lat, currentLocation.lng]
      : [1.3521, 103.8198];

  return (
      <div className="h-screen w-full relative z-0">
        <MapContainer
            center={position}
            zoom={17}
            scrollWheelZoom={true}
            style={{ height: '100%', width: '100%' }}
            zoomControl={false}
        >
          <TileLayer
              url="https://www.onemap.gov.sg/maps/tiles/Grey/{z}/{x}/{y}.png"
              maxZoom={19}
              minZoom={11}
          />

          {/* Current location */}
          {currentLocation && (
              <>
                <RecenterMap position={position} />
                <Marker position={position} icon={currentLocationIcon} />
              </>
          )}

          {/* Past workouts with clustering */}
          <WorkoutClusters
              workouts={workouts}
              activeTooltip={activeTooltip}
              setActiveTooltip={setActiveTooltip}
              tooltipPosition={tooltipPosition}
              setTooltipPosition={setTooltipPosition}
              handleTooltipClick={handleTooltipClick}
          />

          <RecenterButton position={position} />
        </MapContainer>

        <TimePeriodFilter
            selectedPeriod={selectedPeriod}
            onPeriodChange={setSelectedPeriod}
        />
      </div>
  );
};

export default Map;