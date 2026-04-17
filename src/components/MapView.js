import React, { useState, useRef, useEffect, useMemo } from 'react';
import { renderToString } from 'react-dom/server';
import {
  Layout,
  Typography,
  Input,
  Button,
  Card,
  Space,
  List,
  Avatar,
  Row,
  Col,
  Alert,
  Drawer,
  Image,
  Modal,
  Spin,
  Tooltip,
  Slider,
  Checkbox,
  Collapse
} from 'antd';
import {
  SearchOutlined,
  EnvironmentFilled,
  PhoneFilled,
  CarOutlined,
  SunOutlined,
  ArrowLeftOutlined,
  StarFilled,
  PlayCircleOutlined,
  PauseCircleOutlined,
  StopOutlined,
} from '@ant-design/icons';
import {
  Hotel,
  UtensilsCrossed,
  Wine,
  ShoppingCart,
  Landmark,
  Hospital,
  Dumbbell,
  Building2,
  MapPin,
} from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { createGrabMapWithPreferredInit } from '../services/grabMapsBrowserSdk';
import { getGrabNavigationRoute } from '../services/grabNavigationApi';
import {
  searchGrabPois,
  searchGrabNearbyPlaces,
  GRAB_POI_SEARCH_RADIUS_MAX_METERS
} from '../services/grabPoiSearchApi';
import { getTrafficAwareTravelTip } from '../services/grabTrafficApi';
import {
  DESTINATION_DINING_DISPLAY_MAX_METERS,
  DESTINATION_DINING_SEARCH_RADIUS_METERS,
  fetchTopRestaurantsNearDropoff,
  getLocalTravelTip,
  pickLocalTip
} from '../utils/travelTips';
import {
  filterLandmarksNearRoute,
  sortLandmarksByPolylineDistance
} from '../utils/landmarkRouteProximity';
import { locationToLngLatArray } from '../utils/routeCoordinates';
import { publicAssetUrl } from '../utils/publicAssetUrl';
import {
  isWeatherFetchConfigured,
  buildOpenWeatherClientUrl,
  USE_API_PROXY
} from '../config/apiProxy';
import '../App.css'; // Using existing styles

function dedupeLandmarks(landmarks) {
  if (!Array.isArray(landmarks) || !landmarks.length) return [];
  const seen = new Set();
  const out = [];
  for (const lm of landmarks) {
    if (!lm) continue;
    const k = lm.id != null && lm.id !== ''
      ? String(lm.id)
      : `${lm.name || ''}-${lm.location?.latitude}-${lm.location?.longitude}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(lm);
  }
  return out;
}

/** Map may exist before canvas/style APIs used by DOM markers are ready */
function isMapReadyForMapboxMarkers(map) {
  return Boolean(
    map &&
    typeof map.getCanvasContainer === 'function' &&
    typeof map.addLayer === 'function'
  );
}

function resolveGrabMapInstance(map) {
  if (!map) return null;
  if (typeof map.getBounds === 'function' && typeof map.getCenter === 'function') return map;
  return null;
}

/** Bearing in degrees MapLibre style: east of north, clockwise (0 = north). */
function bearingFromLngLats(from, to) {
  if (!from || !to || from.length < 2 || to.length < 2) return 0;
  const [lng1, lat1] = from;
  const [lng2, lat2] = to;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const q = s1 * s1 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(q)));
}

/** Cumulative distance (m) at each vertex; `cum[i]` = distance from start to `coords[i]`. */
function buildRouteDistanceIndex(coords) {
  const n = coords?.length || 0;
  if (n < 2) return { totalM: 0, cum: [0] };
  const cum = [0];
  let total = 0;
  for (let i = 1; i < n; i += 1) {
    total += haversineMeters(coords[i - 1], coords[i]);
    cum.push(total);
  }
  return { totalM: total, cum };
}

/**
 * @param {[number, number][]} coords
 * @param {number[]} cum
 * @param {number} distM distance from route start along the polyline
 * @returns {{ lngLat: [number, number], bearing: number }}
 */
function interpolateRouteByMeters(coords, cum, distM) {
  const total = cum[cum.length - 1];
  const d = Math.max(0, Math.min(distM, total));
  let i = 0;
  while (i < cum.length - 1 && cum[i + 1] < d) i += 1;
  const i1 = Math.min(i + 1, coords.length - 1);
  const seg0 = Math.max(0, i);
  const c0 = cum[seg0];
  const c1 = cum[i1];
  const span = Math.max(1e-6, c1 - c0);
  const f = (d - c0) / span;
  const a = coords[seg0];
  const b = coords[i1];
  const lngLat = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  const bearing = bearingFromLngLats(a, b);
  return { lngLat, bearing };
}

function smoothstep01(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function lerpNum(a, b, t) {
  return a + (b - a) * t;
}

function lerpLngLat(a, b, t) {
  if (!a || !b) return b || a;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Shortest-turn interpolation between bearings in degrees. */
function lerpBearingDeg(from, to, t) {
  let d = ((((to - from) % 360) + 540) % 360) - 180;
  return from + d * t;
}

function computeStreetBlend(distM, totalM, linearFrac) {
  const FINAL_RUN_METERS = 100;
  const streetPhaseStartM = Math.max(0, totalM - FINAL_RUN_METERS);
  if (totalM <= FINAL_RUN_METERS) return smoothstep01(linearFrac);
  if (distM > streetPhaseStartM) {
    return smoothstep01((distM - streetPhaseStartM) / Math.max(1e-6, totalM - streetPhaseStartM));
  }
  return 0;
}

/** Move [lng,lat] forward along bearing (deg, clockwise from north), ~meters on Earth surface. */
function offsetLngLatAlongBearing(lngLat, bearingDeg, distanceM) {
  const [lng, lat] = lngLat;
  const br = (bearingDeg * Math.PI) / 180;
  const latRad = (lat * Math.PI) / 180;
  const dy = (distanceM * Math.cos(br)) / 111320;
  const dx = (distanceM * Math.sin(br)) / (111320 * Math.max(0.2, Math.cos(latRad)));
  return [lng + dx, lat + dy];
}

function createRoutePlaybackArrowElement() {
  const el = document.createElement('div');
  el.className = 'route-playback-arrow';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', 'Route playback');
  el.innerHTML = `
    <svg viewBox="0 0 40 52" width="34" height="44" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M20 3 L37 42 L20 34 L3 42 Z"
        fill="#1677ff" stroke="#ffffff" stroke-width="2.2" stroke-linejoin="round"
        style="filter: drop-shadow(0 2px 5px rgba(22,119,255,0.55))"/>
    </svg>`;
  return el;
}

const { Header, Content } = Layout;
const { Title, Text } = Typography;
const { Search } = Input;

/** Search text → POI icon bucket (quick pills + natural language). */
function inferIconTypeFromSearchKeyword(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  const quickTokens = {
    hotels: 'hotel',
    restaurants: 'restaurant',
    bars: 'bars',
    shops: 'shopping',
    banks: 'bank',
    hospitals: 'hospital',
    sports: 'sports',
    commercial: 'commercial',
  };
  if (quickTokens[t]) return quickTokens[t];
  if (t.includes('hotel') || t.includes('accommodation')) return 'hotel';
  if (t.includes('restaurant') || t.includes('food') || t.includes('dining') || t.includes('cafe')) return 'restaurant';
  if (t.includes('bar') || t.includes('pub') || t.includes('nightlife') || t.includes('club')) return 'bars';
  if (t.includes('shop') || t.includes('mall') || t.includes('store') || t.includes('retail') || t.includes('grocery') || t.includes('market')) {
    return 'shopping';
  }
  if (t.includes('bank') || t.includes('atm') || t.includes('financial')) return 'bank';
  if (t.includes('hospital') || t.includes('medical') || t.includes('clinic') || t.includes('pharmacy') || t.includes('health')) {
    return 'hospital';
  }
  if (t.includes('sport') || t.includes('gym') || t.includes('fitness') || t.includes('recreation')) return 'sports';
  if (t.includes('office') || t.includes('business') || t.includes('commercial') || t.includes('corporate')) {
    return 'commercial';
  }
  return null;
}

/** Resolve which POI icon bucket to show (search intent overrides weak POI metadata). */
function resolvePoiMarkerIconType(businessType, category, searchKeyword) {
  const fromSearch = searchKeyword ? inferIconTypeFromSearchKeyword(String(searchKeyword)) : null;
  const type = (businessType?.toLowerCase() || category?.toLowerCase() || '');
  let iconType = 'default';
  if (type.includes('hotel') || type.includes('accommodation')) {
    iconType = 'hotel';
  } else if (type.includes('restaurant') || type.includes('food') || type.includes('dining') || type.includes('cafe')) {
    iconType = 'restaurant';
  } else if (type.includes('bar') || type.includes('pub') || type.includes('nightlife') || type.includes('club')) {
    iconType = 'bars';
  } else if (type.includes('shop') || type.includes('mall') || type.includes('store') || type.includes('retail') || type.includes('grocery') || type.includes('market')) {
    iconType = 'shopping';
  } else if (type.includes('bank') || type.includes('atm') || type.includes('financial')) {
    iconType = 'bank';
  } else if (type.includes('hospital') || type.includes('medical') || type.includes('clinic') || type.includes('pharmacy') || type.includes('health')) {
    iconType = 'hospital';
  } else if (type.includes('sport') || type.includes('gym') || type.includes('fitness') || type.includes('recreation')) {
    iconType = 'sports';
  } else if (type.includes('office') || type.includes('business') || type.includes('commercial') || type.includes('corporate')) {
    iconType = 'commercial';
  }
  return fromSearch || iconType;
}

/** Lucide icon for POI buckets — same set as quick-search pills + MapPin fallback. */
function PoiKindLucideIcon({ kind, size = 16, className, color = '#00b14f' }) {
  const p = { size, className, color, strokeWidth: 2.25, 'aria-hidden': true };
  switch (kind) {
    case 'hotel':
      return <Hotel {...p} />;
    case 'restaurant':
      return <UtensilsCrossed {...p} />;
    case 'bars':
      return <Wine {...p} />;
    case 'shopping':
      return <ShoppingCart {...p} />;
    case 'bank':
      return <Landmark {...p} />;
    case 'hospital':
      return <Hospital {...p} />;
    case 'sports':
      return <Dumbbell {...p} />;
    case 'commercial':
      return <Building2 {...p} />;
    default:
      return <MapPin {...p} />;
  }
}

function poiKindLucideSvgString(kind, size = 15) {
  return renderToString(<PoiKindLucideIcon kind={kind} size={size} color="#00b14f" />);
}

function MapView() {
  const navigate = useNavigate();
  const location = useLocation();
  
  // Extract data from navigation state
  const routeData = location.state?.routeData;
  const pickupLocation = location.state?.pickupLocation;
  const dropoffLocation = location.state?.dropoffLocation;
  const weatherData = location.state?.weatherData;
  const selectedCountry = location.state?.selectedCountry || 'singapore';
/*
  console.log('🔍 MapView initialized with:', {
    routeData,
    pickupLocation,
    dropoffLocation,
    weatherData,
    selectedCountry,
    fullState: location.state
  });
  */

  const [searchResults, setSearchResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchValue, setSearchValue] = useState('');
  /** When set, list + POI markers prefer this search category for icons (e.g. all "restaurants" hits show fork/knife). */
  const [lastPoiSearchQuery, setLastPoiSearchQuery] = useState('');
  const [startPoint, setStartPoint] = useState(pickupLocation || null);
  const [endPoint, setEndPoint] = useState(dropoffLocation || null);
  const [waypoints, setWaypoints] = useState([]); // New state for multi-point routing
  const [routeInfo, setRouteInfo] = useState(null); // Initialize as null, will be set in useEffect
  const [routeLandmarks, setRouteLandmarks] = useState([]);
  /** Top Grab-ranked restaurants within strict radius of drop-off — shown as map pins */
  const [destinationDiningPicks, setDestinationDiningPicks] = useState([]);
  /** True while Grab POI dining search runs for the current destination pin. */
  const [destinationDiningLoading, setDestinationDiningLoading] = useState(false);
  /** Bumped after a successful on-map replan so dining refetches even when drop-off coords are unchanged. */
  const [diningRefreshTrigger, setDiningRefreshTrigger] = useState(0);
  /** Dining list + help text collapsed by default to reduce sidebar noise */
  const [diningPanelExpanded, setDiningPanelExpanded] = useState(false);
  /** When true, draw Grab-ranked dining pins on the map (off by default — less clutter / faster feel) */
  const [showDiningMarkers, setShowDiningMarkers] = useState(false);
  /** When true, draw route landmark / attraction pins (off by default) */
  const [showLandmarkMarkers, setShowLandmarkMarkers] = useState(false);
  const [routeLoading, setRouteLoading] = useState(false);
  const [userLocation, setUserLocation] = useState(null);
  const [selectedPOIIndex, setSelectedPOIIndex] = useState(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [showAddPointModal, setShowAddPointModal] = useState(false);
  /** LineString geometry for the route currently drawn on the map */
  const activeRouteGeometryRef = useRef(null);
  /** Enables route playback CTA after `drawRouteFromGeometry` succeeds */
  const [hasRouteOnMap, setHasRouteOnMap] = useState(false);
  /** Animated driving-style playback along the polyline */
  const [routePlaybackActive, setRoutePlaybackActive] = useState(false);
  const [routePlaybackPaused, setRoutePlaybackPaused] = useState(false);
  const [routePlaybackProgressPct, setRoutePlaybackProgressPct] = useState(0);
  /** @type {React.MutableRefObject<null | Record<string, unknown>>} */
  const routePlaybackRunRef = useRef(null);

  // New responsive state
  const [isMobile, setIsMobile] = useState(false);
  const [showMobileSidebar, setShowMobileSidebar] = useState(false);
  const [, setActiveView] = useState('map'); // 'map' or 'sidebar'

  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const routeMarkersRef = useRef([]);
  const routeLandmarkMarkersRef = useRef([]);
  const diningMarkersRef = useRef([]);
  const diningFetchGenRef = useRef(0);
  /** Grab POI `country` when not bbox-only — follows map center (nearest SEA hub), not only landing-page selection. */
  const [poiCountryKey, setPoiCountryKey] = useState(selectedCountry);

  function stopRoutePlaybackAnim(finished = false) {
    const run = routePlaybackRunRef.current;
    if (run) {
      run.cancelled = true;
      if (run.rafId) cancelAnimationFrame(run.rafId);
      try {
        run.marker?.remove();
      } catch (_) {
        /* ignore */
      }
    }
    routePlaybackRunRef.current = null;
    setRoutePlaybackActive(false);
    setRoutePlaybackPaused(false);
    setRoutePlaybackProgressPct(0);
    const map = resolveGrabMapInstance(mapRef.current);
    if (!map) return;
    if (!finished) {
      try {
        map.easeTo({ pitch: 0, duration: 750, essential: true });
        map.setMaxPitch(60);
      } catch (_) {
        /* ignore */
      }
    } else {
      try {
        map.setMaxPitch(60);
      } catch (_) {
        /* ignore */
      }
    }
  }

  // Southeast Asian countries with their coordinates (matching LandingPage)
  const SOUTHEAST_ASIAN_COUNTRIES = {
    singapore: {
      name: 'Singapore 🇸🇬',
      coordinates: '1.3521,103.8198',
      center: { lat: 1.3521, lng: 103.8198 },
      flag: '🇸🇬'
    },
    indonesia: {
      name: 'Indonesia 🇮🇩',
      coordinates: '-6.2088,106.8456', // Jakarta
      center: { lat: -6.2088, lng: 106.8456 },
      flag: '🇮🇩'
    },
    thailand: {
      name: 'Thailand 🇹🇭',
      coordinates: '13.7563,100.5018', // Bangkok
      center: { lat: 13.7563, lng: 100.5018 },
      flag: '🇹🇭'
    },
    malaysia: {
      name: 'Malaysia 🇲🇾',
      coordinates: '3.1390,101.6869', // Kuala Lumpur
      center: { lat: 3.1390, lng: 101.6869 },
      flag: '🇲🇾'
    },
    philippines: {
      name: 'Philippines 🇵🇭',
      coordinates: '14.5995,120.9842', // Manila
      center: { lat: 14.5995, lng: 120.9842 },
      flag: '🇵🇭'
    },
    vietnam: {
      name: 'Vietnam 🇻🇳',
      coordinates: '21.0285,105.8542', // Hanoi
      center: { lat: 21.0285, lng: 105.8542 },
      flag: '🇻🇳'
    },
    myanmar: {
      name: 'Myanmar 🇲🇲',
      coordinates: '16.8661,96.1951', // Yangon
      center: { lat: 16.8661, lng: 96.1951 },
      flag: '🇲🇲'
    },
    cambodia: {
      name: 'Cambodia 🇰🇭',
      coordinates: '11.5564,104.9282', // Phnom Penh
      center: { lat: 11.5564, lng: 104.9282 },
      flag: '🇰🇭'
    }
  };

  // Get current country data
  const getCurrentCountryData = () => {
    return SOUTHEAST_ASIAN_COUNTRIES[selectedCountry] || SOUTHEAST_ASIAN_COUNTRIES.singapore;
  };

  // Get initial map center based on selected country
  const getInitialMapCenter = () => {
    const countryData = getCurrentCountryData();
    //console.log(`🗺️ Setting initial map center to ${countryData.name}:`, countryData.center);
    return [countryData.center.lng, countryData.center.lat];
  };

  const OPENWEATHER_API_KEY = process.env.REACT_APP_OPENWEATHER_API_KEY;

  if (!isWeatherFetchConfigured()) {
    console.warn('⚠️ OpenWeather API key not configured. Weather features will use fallback data.');
  }

  // Responsive detection
  useEffect(() => {
    const checkScreenSize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (!mobile) {
        setShowMobileSidebar(false);
        setActiveView('map');
      }
    };

    checkScreenSize();
    window.addEventListener('resize', checkScreenSize);
    return () => window.removeEventListener('resize', checkScreenSize);
  }, []);

  useEffect(() => {
    setPoiCountryKey(selectedCountry);
  }, [selectedCountry]);

  const diningEndpointKey = useMemo(() => {
    const c = locationToLngLatArray(endPoint);
    return c ? `${c[0].toFixed(5)},${c[1].toFixed(5)}` : '';
  }, [endPoint]);

  useEffect(() => {
    let cancelled = false;
    const reqId = ++diningFetchGenRef.current;

    const doneLoading = () => {
      if (!cancelled && reqId === diningFetchGenRef.current) {
        setDestinationDiningLoading(false);
      }
    };

    if (!diningEndpointKey) {
      setDestinationDiningLoading(false);
      setDestinationDiningPicks([]);
      return () => {
        cancelled = true;
      };
    }

    const seeded = routeData?.destinationDining;
    const seedKey = routeData?.destinationDiningEndpointKey;
    const hasSeed = Array.isArray(seeded) && seeded.length > 0 && seedKey && seedKey === diningEndpointKey;
    const wantLiveFetch = diningPanelExpanded || showDiningMarkers;

    if (hasSeed) {
      if (!cancelled && reqId === diningFetchGenRef.current) {
        setDestinationDiningPicks(seeded);
      }
      doneLoading();
      if (!wantLiveFetch) {
        return () => {
          cancelled = true;
        };
      }
      return () => {
        cancelled = true;
      };
    }

    if (!wantLiveFetch) {
      if (!cancelled && reqId === diningFetchGenRef.current) {
        setDestinationDiningPicks([]);
        setDestinationDiningLoading(false);
      }
      return () => {
        cancelled = true;
      };
    }

    setDestinationDiningLoading(true);
    (async () => {
      const picks = await fetchTopRestaurantsNearDropoff(endPoint, selectedCountry);
      if (!cancelled && reqId === diningFetchGenRef.current) {
        setDestinationDiningPicks(picks);
      }
      doneLoading();
    })();

    return () => {
      cancelled = true;
    };
  }, [
    diningEndpointKey,
    selectedCountry,
    endPoint,
    routeData?.destinationDining,
    routeData?.destinationDiningEndpointKey,
    diningRefreshTrigger,
    diningPanelExpanded,
    showDiningMarkers
  ]);

  // Initialize with route data if available
  useEffect(() => {
    if (routeData && pickupLocation && dropoffLocation) {
      console.log('🚗 Setting up route info from LandingPage data');
      console.log('📊 Route Data:', routeData);
      console.log('📍 Pickup:', pickupLocation);
      console.log('📍 Dropoff:', dropoffLocation);
      console.log('🌤️ Weather:', weatherData);
      
      // Set route info with data from LandingPage
      const newRouteInfo = {
        distance: String(routeData.distance || '0'), // Ensure string format
        duration: String(routeData.duration || '0'), // Ensure string format
        weather: weatherData || {
          condition: 'Clear',
          temperature: 28
        },
        traffic: {
          congestion: 'Light'
        },
        description: routeData.humanDescription || 'Route information not available'
      };
      
      console.log('📋 Setting route info:', newRouteInfo);
      setRouteInfo(newRouteInfo);
      setRouteLandmarks(dedupeLandmarks(routeData.landmarks || []));
      // Set start and end points from passed data
      setStartPoint(pickupLocation);
      setEndPoint(dropoffLocation);
      
      console.log('✅ Route info and points initialized successfully from LandingPage');
    } else {
      //console.log('📍 No complete route data available - starting with map-only mode');
      console.log('🔍 Available data:', {
        hasRouteData: !!routeData,
        hasPickup: !!pickupLocation,
        hasDropoff: !!dropoffLocation
      });
    }
  }, [routeData, pickupLocation, dropoffLocation, weatherData]);

  // Get user's current location for accurate distance calculation
  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const userPos = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude
          };
          setUserLocation(userPos);
          console.log('📍 User location obtained:', userPos);
        },
        (error) => {
          console.warn('⚠️ Could not get user location:', error.message);
          console.log('ℹ️ Distance information will not be shown in POI popups without location access');
          // Don't show distance if we can't get user location
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 300000 // 5 minutes
        }
      );
    } else {
      console.warn('⚠️ Geolocation not supported by this browser');
    }
  }, []);

  // Handle route visualization when map is ready and route data is available
  useEffect(() => {
    if (!routeData || !routeData.geometry || !startPoint || !endPoint) {
      console.log('🔍 Route visualization skipped - missing data:', {
        hasRouteData: !!routeData,
        hasGeometry: !!routeData?.geometry,
        hasStartPoint: !!startPoint,
        hasEndPoint: !!endPoint
      });
      return;
    }

    const drawRouteVisualization = () => {
      console.log('🎨 Attempting to draw route from LandingPage data');
      console.log('🔍 Map ready check:', {
        mapRef: !!mapRef.current,
        hasStyleLoaded: !!mapRef.current?.isStyleLoaded,
        styleLoaded: mapRef.current?.isStyleLoaded?.()
      });

      if (!mapRef.current) {
        console.log('⏳ Map reference not available, retrying in 500ms...');
        setTimeout(drawRouteVisualization, 500);
        return;
      }

      // Check if map is fully loaded - try multiple methods
      const isMapReady = mapRef.current.isStyleLoaded?.() || 
                        mapRef.current.loaded?.() || 
                        mapRef.current.getStyle?.();

      if (!isMapReady) {
        console.log('⏳ Map style not loaded, retrying in 500ms...');
        setTimeout(drawRouteVisualization, 500);
        return;
      }

      try {
        console.log('✅ Map is ready, drawing route visualization');
        console.log('🔍 Route geometry:', routeData.geometry);
        console.log('🔍 Start point:', startPoint);
        console.log('🔍 End point:', endPoint);
        
        // Clear POI + route A/B + line — do not remove landmark markers from LandingPage
        clearRouteABMarkersAndLayer();
        
        // Add route markers with A, B labels
        addRouteMarker(startPoint, 'start', 'A');
        addRouteMarker(endPoint, 'end', 'B');
        
        // Draw the route line
        drawRouteFromGeometry(routeData.geometry);
        
        // Fit map to show the route
        if (mapRef.current && mapRef.current.fitBounds && maplibregl.LngLatBounds) {
          try {
            const bounds = new maplibregl.LngLatBounds();
            
            // Handle different coordinate formats for start point
            const startCoords = startPoint.coordinates && Array.isArray(startPoint.coordinates) 
              ? startPoint.coordinates 
              : [startPoint.location?.longitude, startPoint.location?.latitude];
            
            // Handle different coordinate formats for end point
            const endCoords = endPoint.coordinates && Array.isArray(endPoint.coordinates)
              ? endPoint.coordinates
              : [endPoint.location?.longitude, endPoint.location?.latitude];
            
            if (startCoords && startCoords[0] && startCoords[1]) bounds.extend(startCoords);
            if (endCoords && endCoords[0] && endCoords[1]) bounds.extend(endCoords);
            
            mapRef.current.fitBounds(bounds, {
              padding: { top: 50, bottom: 50, left: 50, right: 50 },
              maxZoom: 16,
              duration: 1000
            });
            console.log('✅ Map fitted to route bounds');
          } catch (error) {
            console.warn('Could not fit map bounds:', error);
          }
        }
        
        console.log('🎉 Route visualization completed successfully');
      } catch (error) {
        console.error('❌ Error drawing route visualization:', error);
        // Retry once more after a delay
        setTimeout(drawRouteVisualization, 1000);
      }
    };

    // Start visualization with multiple retry attempts
    const maxRetries = 10;
    let retryCount = 0;
    
    const tryDrawRoute = () => {
      if (retryCount >= maxRetries) {
        console.warn('⚠️ Route visualization failed after maximum retries');
        return;
      }
      retryCount++;
      console.log(`🔄 Route visualization attempt ${retryCount}/${maxRetries}`);
      drawRouteVisualization();
    };

    // Start with a small delay to ensure component is mounted
    const timeoutId = setTimeout(tryDrawRoute, 300);
    
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- drawRouteVisualization captures drawRouteFromGeometry; deps intentionally limited to avoid re-running on function identity changes
  }, [routeData, startPoint, endPoint]);

  // Auto-plan route when both start and end points are set manually (not from LandingPage)
  useEffect(() => {
    if (startPoint && endPoint && mapRef.current && !routeData) {
      console.log('🚀 Auto-planning route: start and end points set manually');
      planRoute();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- planRoute is stable enough for this trigger; full deps would cause unnecessary re-runs
  }, [startPoint, endPoint, waypoints, routeData]);

  // Calculate straight-line distance using Haversine formula
  const calculateDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371; // Earth's radius in kilometers
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c; // Distance in kilometers
  };

  const inferCountryKeyFromLatLng = (lat, lng) => {
    const la = Number(lat);
    const ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) return poiCountryKey;
    let bestKey = 'singapore';
    let bestKm = Infinity;
    for (const key of Object.keys(SOUTHEAST_ASIAN_COUNTRIES)) {
      const c = SOUTHEAST_ASIAN_COUNTRIES[key]?.center;
      if (!c) continue;
      const d = calculateDistance(la, ln, c.lat, c.lng);
      if (d < bestKm) {
        bestKm = d;
        bestKey = key;
      }
    }
    return bestKey;
  };

  const inferCountryFromMapRef = useRef(inferCountryKeyFromLatLng);
  inferCountryFromMapRef.current = inferCountryKeyFromLatLng;

  const getPoiCountryData = () =>
    SOUTHEAST_ASIAN_COUNTRIES[poiCountryKey] || SOUTHEAST_ASIAN_COUNTRIES.singapore;

  /**
   * Live map viewport for Grab POI search (bounds string per Grab docs:
   * southWestLat,southWestLon,northEastLat,northEastLon).
   * Uses LngLatBounds axis extrema + loaded/style checks so we never send a bogus bbox.
   * @see https://maps.grab.com/developer/documentation/searching
   */
  const getViewportPoiSearchContext = () => {
    const countryData = getPoiCountryData();
    const fallback = () => ({
      lat: countryData.center.lat,
      lng: countryData.center.lng,
      radiusMeters: Math.min(25000, GRAB_POI_SEARCH_RADIUS_MAX_METERS),
      boundsRect: null,
      boundsParam: null,
      usedLiveMap: false
    });

    const map = resolveGrabMapInstance(mapRef.current);
    if (!map || typeof map.getBounds !== 'function') return fallback();

    try {
      const loaded = typeof map.loaded === 'function' ? map.loaded() : true;
      const styleOk = typeof map.isStyleLoaded === 'function' ? map.isStyleLoaded() : true;
      if (!loaded || !styleOk) return fallback();

      const b = map.getBounds();
      if (!b || typeof b.getCenter !== 'function') return fallback();

      const center = b.getCenter();
      const clat = Number(center?.lat);
      const clng = Number(center?.lng);
      if (!Number.isFinite(clat) || !Number.isFinite(clng)) return fallback();

      let south = typeof b.getSouth === 'function' ? Number(b.getSouth()) : NaN;
      let west = typeof b.getWest === 'function' ? Number(b.getWest()) : NaN;
      let north = typeof b.getNorth === 'function' ? Number(b.getNorth()) : NaN;
      let east = typeof b.getEast === 'function' ? Number(b.getEast()) : NaN;

      if (![south, west, north, east].every(Number.isFinite)) {
        const sw = typeof b.getSouthWest === 'function' ? b.getSouthWest() : null;
        const ne = typeof b.getNorthEast === 'function' ? b.getNorthEast() : null;
        if (!sw || !ne) return fallback();
        south = Number(sw.lat);
        west = Number(sw.lng);
        north = Number(ne.lat);
        east = Number(ne.lng);
      }

      if (![south, west, north, east].every(Number.isFinite)) return fallback();
      if (south < -90 || north > 90 || south > north) return fallback();
      const latSpan = Math.abs(north - south);
      const lngSpan = Math.abs(east - west);
      if (latSpan < 1e-7 || (lngSpan < 1e-7 && west <= east)) return fallback();

      const r7 = (x) => Number(Number(x).toFixed(7));
      const boundsParam = `${r7(south)},${r7(west)},${r7(north)},${r7(east)}`;
      const boundsRect = { west, south, east, north };

      const corners = [
        { lat: south, lng: west },
        { lat: south, lng: east },
        { lat: north, lng: west },
        { lat: north, lng: east }
      ];
      let maxKm = 0;
      corners.forEach((corner) => {
        const d = calculateDistance(clat, clng, corner.lat, corner.lng);
        if (d > maxKm) maxKm = d;
      });
      const radiusMeters = Math.min(
        GRAB_POI_SEARCH_RADIUS_MAX_METERS,
        Math.max(400, Math.round(maxKm * 1000 * 1.08))
      );

      return {
        lat: clat,
        lng: clng,
        radiusMeters,
        boundsRect,
        boundsParam,
        usedLiveMap: true
      };
    } catch (e) {
      console.warn('Viewport POI context failed, using country center:', e);
      return fallback();
    }
  };

  /**
   * Two POI flows coexist: (1) ranked destination dining (max 3, strict radius from B) — `destinationDiningPicks`;
   * (2) map search (default: viewport center + bbox, up to 20). Food queries with B set used to use the whole
   * viewport, which duplicated pins and looked like “many restaurants” unrelated to B.
   */
  const DESTINATION_BIAS_QUERY_RE =
    /restaurant|food|dining|cafe|coffee|eat|lunch|dinner|breakfast|hawker|kopitiam|^bars?$/i;

  const getDestinationBiasedFoodPoiContext = (query) => {
    const q = String(query || '').trim();
    if (!q || !endPoint) return null;
    if (!DESTINATION_BIAS_QUERY_RE.test(q)) return null;
    const pair = locationToLngLatArray(endPoint);
    if (!pair) return null;
    const [lng, lat] = pair;
    return {
      lat,
      lng,
      radiusMeters: Math.min(4000, GRAB_POI_SEARCH_RADIUS_MAX_METERS),
      boundsRect: null,
      boundsParam: null,
      usedLiveMap: true,
      anchor: 'destination'
    };
  };

  const resolvePoiSearchContext = (query) => {
    const dest = getDestinationBiasedFoodPoiContext(query);
    if (dest) return dest;
    const v = getViewportPoiSearchContext();
    return { ...v, anchor: 'viewport' };
  };

  const isPoiInsideBounds = (poi, boundsRect) => {
    if (!boundsRect || !poi?.location) return true;
    const lat = Number(poi.location.latitude);
    const lng = Number(poi.location.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    if (lat < boundsRect.south || lat > boundsRect.north) return false;
    if (boundsRect.west <= boundsRect.east) {
      return lng >= boundsRect.west && lng <= boundsRect.east;
    }
    return lng >= boundsRect.west || lng <= boundsRect.east;
  };

  // Get weather data using OpenWeather API with secure handling
  const getWeatherData = async (coordinates) => {
    // Check if API key is configured
    if (!isWeatherFetchConfigured()) {
      console.warn('🌤️ Using fallback weather data - API key not configured');
      // Return fallback weather data when API key is not available
      return {
        temperature: 28,
        condition: 'Clear',
        description: 'API key not configured',
        humidity: 70,
        icon: '01d'
      };
    }

    try {
      const apiUrl = USE_API_PROXY
        ? buildOpenWeatherClientUrl(coordinates[1], coordinates[0])
        : `https://api.openweathermap.org/data/2.5/weather?lat=${coordinates[1]}&lon=${coordinates[0]}&appid=${OPENWEATHER_API_KEY}&units=metric`;
      console.log('🌤️ Fetching weather data for route destination');
      
      const response = await fetch(apiUrl);
      
      if (!response.ok) {
        throw new Error(`Weather API error: ${response.status}`);
      }
      
      const data = await response.json();
      
      const weatherData = {
        temperature: Math.round(data.main.temp),
        condition: data.weather[0].main,
        description: data.weather[0].description,
        humidity: data.main.humidity,
        icon: data.weather[0].icon
      };
      
      console.log('✅ Weather data retrieved successfully');
      return weatherData;
    } catch (error) {
      console.error('Error fetching weather data:', error);
      // Fallback to default weather data if API fails
      return {
        temperature: 28,
        condition: 'Clear',
        description: 'weather data unavailable',
        humidity: 70,
        icon: '01d'
      };
    }
  };

  // Get landmarks along the route
  const getLandmarksAlongRoute = async (route, pickup, dropoff) => {
    try {
      const landmarks = [];
      const routeCoordinates = route.geometry?.coordinates || [];

      if (routeCoordinates.length === 0) return landmarks;

      const totalPoints = routeCoordinates.length;
      const idxSet = new Set();
      const numSamples = Math.min(12, Math.max(5, Math.ceil(totalPoints / 80)));
      for (let i = 0; i < numSamples; i += 1) {
        const t = numSamples <= 1 ? 0 : i / (numSamples - 1);
        idxSet.add(Math.min(Math.floor(t * (totalPoints - 1)), totalPoints - 1));
      }
      const samplePoints = [...idxSet].sort((a, b) => a - b).map((i) => routeCoordinates[i]);

      const landmarkPromises = samplePoints.map(async (point, index) => {
        const [lng, lat] = point;
        try {
          const pois = await searchGrabNearbyPlaces({
            lat,
            lng,
            limit: 12,
            radius: 450,
            rankBy: 'distance',
            calculateDistance: () => null
          });
          return pois.map((place) => ({
            ...place,
            routeIndex: index,
            side: determineSide(routeCoordinates, point, [place.location.longitude, place.location.latitude]),
            distance: index * (parseFloat(route.distance) / 1000 / 5),
            searchKeyword: 'nearby'
          }));
        } catch (error) {
          console.log('Could not fetch nearby landmarks for point:', point, error);
        }
        return [];
      });
      
      const landmarkResults = await Promise.all(landmarkPromises);
      const allLandmarks = landmarkResults.flat();
      
      // Filter and sort landmarks - prioritize interesting ones for tourists
      const interestingTypes = ['shopping_mall', 'tourist_attraction', 'landmark', 'museum', 'park', 'monument', 'temple', 'building', 'hotel', 'mall', 'tower', 'casino', 'entertainment'];
      const filteredLandmarks = allLandmarks
        .filter(landmark => {
          // More inclusive filtering for tourist attractions
          return interestingTypes.includes(landmark.businessType) || 
                 landmark.category?.includes('landmark') ||
                 landmark.category?.includes('attraction') ||
                 landmark.category?.includes('building') ||
                 landmark.name?.toLowerCase().includes('tower') ||
                 landmark.name?.toLowerCase().includes('mall') ||
                 landmark.name?.toLowerCase().includes('temple') ||
                 (landmark.score && landmark.score > 0.7); // High-rated places
        })
        .sort((a, b) => {
          const scoreA = (a.score || 0) + (a.Popularity?.pickupCount || 0) / 10000;
          const scoreB = (b.score || 0) + (b.Popularity?.pickupCount || 0) / 10000;
          return scoreB - scoreA;
        });

      let alongRoute = filterLandmarksNearRoute(routeCoordinates, filteredLandmarks, 220);
      if (alongRoute.length === 0 && filteredLandmarks.length > 0) {
        alongRoute = filterLandmarksNearRoute(routeCoordinates, filteredLandmarks, 400);
      }
      alongRoute = sortLandmarksByPolylineDistance(routeCoordinates, alongRoute);
      alongRoute.sort((a, b) => {
        const scoreA = (a.score || 0) + (a.Popularity?.pickupCount || 0) / 10000;
        const scoreB = (b.score || 0) + (b.Popularity?.pickupCount || 0) / 10000;
        return scoreB - scoreA;
      });
      const top = alongRoute.slice(0, 5);

      console.log(`🏛️ Found ${top.length} landmarks near the route:`, top.map((l) => l.name));
      return top;
    } catch (error) {
      console.log('Could not fetch route landmarks:', error);
      return [];
    }
  };

  // Determine if landmark is on left or right side of route
  const determineSide = (routeCoordinates, currentPoint, landmarkPoint) => {
    try {
      const [routeLng, routeLat] = currentPoint;
      const [landmarkLng, landmarkLat] = landmarkPoint;
      
      // Find the next point on the route to determine direction
      const currentIndex = routeCoordinates.findIndex(coord => 
        Math.abs(coord[0] - routeLng) < 0.001 && Math.abs(coord[1] - routeLat) < 0.001
      );
      
      if (currentIndex < routeCoordinates.length - 1) {
        const nextPoint = routeCoordinates[currentIndex + 1];
        const [nextLng, nextLat] = nextPoint;
        
        // Calculate cross product to determine left/right
        const routeVector = [nextLng - routeLng, nextLat - routeLat];
        const landmarkVector = [landmarkLng - routeLng, landmarkLat - routeLat];
        const crossProduct = routeVector[0] * landmarkVector[1] - routeVector[1] * landmarkVector[0];
        
        return crossProduct > 0 ? 'left' : 'right';
      }
    } catch (error) {
      console.log('Could not determine landmark side');
    }
    return Math.random() > 0.5 ? 'left' : 'right'; // Random fallback
  };

  // Get weather-based advice
  const getWeatherAdvice = (duration) => {
    const hour = new Date().getHours();
    const timeBasedAdvice = [];
    
    if (hour < 10) {
      timeBasedAdvice.push(`Morning light is perfect for photography during your ${duration}-minute journey`);
      timeBasedAdvice.push(`Beat the crowds with this early ${duration}-minute adventure`);
    } else if (hour < 16) {
      timeBasedAdvice.push(`Midday energy is ideal for your ${duration}-minute exploration`);
      timeBasedAdvice.push(`Perfect timing for lunch stops during your ${duration}-minute route`);
    } else {
      timeBasedAdvice.push(`Golden hour lighting will make your ${duration}-minute journey magical`);
      timeBasedAdvice.push(`Evening ambiance adds charm to your ${duration}-minute adventure`);
    }
    
    const generalAdvice = [
      `Ideal weather conditions for sightseeing along the way`,
      `Great visibility for spotting iconic landmarks`,
      `Comfortable temperature for window-down sightseeing`,
      `Perfect conditions for outdoor photo opportunities`
    ];
    
    const allAdvice = [...timeBasedAdvice, ...generalAdvice];
    return allAdvice[Math.floor(Math.random() * allAdvice.length)];
  };

  // Generate human-like route description with landmarks for multi-point routes (matching LandingPage.js pattern)
  const generateHumanLikeDescription = async (route, pickup, dropoff, waypoints = []) => {
    const distance = (route.distance / 1000).toFixed(1);
    const duration = Math.round(route.duration / 60);
    const steps = route.legs?.[0]?.steps || [];
    
    // For multi-leg routes, we have multiple legs
    const totalLegs = route.legs?.length || 1;
    const isMultiPoint = totalLegs > 1;
    
    const [landmarks, trafficTip, rankedDining] = await Promise.all([
      getLandmarksAlongRoute(route, pickup, dropoff),
      getTrafficAwareTravelTip(pickup, dropoff, route.geometry?.coordinates),
      fetchTopRestaurantsNearDropoff(dropoff, selectedCountry)
    ]);

    const diningTip = await getLocalTravelTip(pickup, dropoff, selectedCountry, {
      durationMinutes: duration,
      rankedRestaurants: rankedDining
    });
    const localTip =
      [trafficTip, diningTip].filter(Boolean).join(' ') || pickLocalTip(pickup, dropoff);

    // Create inspiring opening
    const timeOfDay = new Date().getHours();
    let timeGreeting = '';
    if (timeOfDay < 12) timeGreeting = 'morning';
    else if (timeOfDay < 17) timeGreeting = 'afternoon';
    else timeGreeting = 'evening';
    
    let description = `✨ **Embark on Your ${distance}km Adventure!**

🚗 Your ${timeGreeting} journey from **${pickup.name}** to **${dropoff.name}**`;
    
    if (isMultiPoint && waypoints.length > 0) {
      description += ` via **${waypoints.length} exciting waypoint${waypoints.length > 1 ? 's' : ''}**`;
    }
    
    description += ` promises to be spectacular! In just **${duration} minutes**, you'll experience the vibrant heart of Southeast Asia.

🏙️ **Your Scenic Route:**`;

    // Add landmark highlights if found
    if (landmarks.length > 0) {
      description += `\n\n🎯 **Iconic Sights Along Your Way**\nTap the flagged markers on the map (name labels) to see photos and place details.`;
      description += `\n\n💫 **Pro Tip:** Keep your camera ready for these stunning landmarks!`;
    } else {
      // Fallback when no landmarks found
      description += `\n\n🌆 **Urban Adventure Awaits:**\nWhile we search for specific landmarks, you'll experience the vibrant streetscape of Southeast Asia with its unique architecture, bustling markets, and local life unfolding around every corner.`;
    }

    // Add multi-point route details
    if (isMultiPoint && waypoints.length > 0) {
      description += `\n\n🗺️ **Multi-Point Adventure:**`;
      description += `\n📍 **Start:** ${pickup.address || pickup.name}`;
      
      waypoints.forEach((waypoint, index) => {
        description += `\n🔸 **Stop ${index + 1}:** ${waypoint.name}`;
      });
      
      description += `\n🎯 **Final Destination:** ${dropoff.address || dropoff.name}`;
    } else {
      description += `\n\n🗺️ **Route Overview:**`;
      description += `\n📍 **Start:** ${pickup.address || pickup.name}`;
      description += `\n🎯 **Destination:** ${dropoff.address || dropoff.name}`;
    }

    // Add route highlights (Grab navigation step structure)
    const keyInstructions = steps
      .filter(step => step.maneuver?.type !== 'depart' && step.maneuver?.type !== 'arrive')
      .slice(0, 2) // Take first 2 major turns
      .map(step => {
        const instruction = step.maneuver?.instruction || 'Continue';
        const streetName = step.name || 'unnamed road';
        return `• ${instruction} onto **${streetName}**`;
      });

    if (keyInstructions.length > 0) {
      description += `\n\n🧭 **Key Route Highlights:**\n${keyInstructions.join('\n')}`;
    }

    description += `\n\n📍 **Your Destination Awaits:** ${dropoff.address || dropoff.name}

🌟 **Make This Journey Memorable:**
• ${getWeatherAdvice(duration)}
• **Photo Opportunity:** ${landmarks.length > 0 ? `Don't miss ${landmarks[0]?.name || 'the scenic views'}!` : 'Capture the urban landscape!'}
• **Local Tip:** ${localTip}`;

    if (isMultiPoint) {
      description += `\n• **Multi-Point Adventure:** ${waypoints.length} stop${waypoints.length > 1 ? 's' : ''} along your ${distance}km journey`;
    }

    description += `\n• **Journey Time:** ${duration} minutes (${distance}km of discovery)

Ready for an unforgettable Southeast Asian adventure? 🌏✨`;

    return { description, landmarks: dedupeLandmarks(landmarks) };
  };

  // Plan route between start and end points
  const planRoute = async () => {
    if (!startPoint || !endPoint) {
      console.warn('Cannot plan route: missing start or end point');
      return;
    }

    console.log('🗺️ Planning route from', startPoint.name, 'to', endPoint.name);
    setRouteLoading(true);
    setWeatherLoading(true);

    try {
      // Clear existing route markers and route line before planning new route
      console.log('🧹 Clearing existing route markers and route line...');
      routeMarkersRef.current.forEach(marker => marker.remove());
      routeMarkersRef.current = [];

      routeLandmarkMarkersRef.current.forEach((m) => m.remove());
      routeLandmarkMarkersRef.current = [];

      diningMarkersRef.current.forEach((m) => m.remove());
      diningMarkersRef.current = [];
      diningFetchGenRef.current += 1;
      setDestinationDiningPicks([]);
      
      // Remove existing route layer if it exists
      if (mapRef.current && mapRef.current.getLayer && mapRef.current.getLayer('route')) {
        mapRef.current.removeLayer('route');
        mapRef.current.removeSource('route');
        console.log('🗺️ Existing route layer removed');
      }
      activeRouteGeometryRef.current = null;
      setHasRouteOnMap(false);
      stopRoutePlaybackAnim(false);

      // Get route from GrabNavigation with multi-point support — canonical [lng, lat]
      const startCoords = locationToLngLatArray(startPoint);
      const endCoords = locationToLngLatArray(endPoint);
      if (!startCoords || !endCoords) {
        alert('Start or end is missing valid coordinates. Please set both points again.');
        return;
      }

      const coordinates = [startCoords];
      if (waypoints.length > 0) {
        console.log(`🗺️ Including ${waypoints.length} waypoint(s) in route`);
        waypoints.forEach((waypoint, index) => {
          const waypointCoords = locationToLngLatArray(waypoint);
          if (waypointCoords) {
            coordinates.push(waypointCoords);
            console.log(`   📍 Waypoint ${index + 1}: ${waypoint.name}`);
          }
        });
      }
      coordinates.push(endCoords);

      const routeJson = await getGrabNavigationRoute(coordinates, 'driving');

      if (routeJson.routes && routeJson.routes.length > 0) {
        const route = routeJson.routes[0];
        
        // Get weather data for the destination
        const weather = await getWeatherData(endCoords);
        setWeatherLoading(false);
        
        // Create human-like description with landmarks and waypoints
        const { description: humanDescription, landmarks } = await generateHumanLikeDescription(route, startPoint, endPoint, waypoints);
        setRouteLandmarks(landmarks || []);

        setDiningRefreshTrigger((t) => t + 1);

        const newRouteInfo = {
          distance: (route.distance / 1000).toFixed(1), // Convert to km
          duration: Math.round(route.duration / 60), // Convert to minutes
          weather: weather,
          description: humanDescription
        };

        setRouteInfo(newRouteInfo);
        console.log('✅ Route planned successfully:', newRouteInfo);

        // Draw route on map
        if (mapRef.current) {
          console.log('🎨 Drawing route visualization...');
          drawRouteFromGeometry(route.geometry);
          
          // Add route markers with A, B, C labels
          console.log('📍 Adding route markers with A, B, C labels...');
          
          // Create ordered list of all points for consistent labeling
          const allRoutePoints = [];
          allRoutePoints.push({ coordinates: startCoords, type: 'start' });
          
          if (waypoints.length > 0) {
            waypoints.forEach((waypoint) => {
              const waypointCoords = locationToLngLatArray(waypoint);
              if (waypointCoords) {
                allRoutePoints.push({ coordinates: waypointCoords, type: 'waypoint' });
              }
            });
          }
          
          allRoutePoints.push({ coordinates: endCoords, type: 'end' });
          
          // Add markers with sequential letters
          allRoutePoints.forEach((point, index) => {
            const letter = String.fromCharCode(65 + index); // A, B, C, D...
            addRouteMarker({coordinates: point.coordinates}, point.type, letter);
          });
          
          // Fit map to show the route including waypoints
          console.log('🗺️ Fitting map bounds to show route...');
          const bounds = new maplibregl.LngLatBounds();
          bounds.extend(startCoords);
          
          // Extend bounds to include waypoints
          if (waypoints.length > 0) {
            waypoints.forEach(waypoint => {
              const waypointCoords = waypoint.location ? 
                [waypoint.location.longitude, waypoint.location.latitude] : 
                waypoint.coordinates;
              bounds.extend(waypointCoords);
            });
          }
          
          bounds.extend(endCoords);
          
          mapRef.current.fitBounds(bounds, {
            padding: { top: 50, bottom: 50, left: 50, right: 50 },
            maxZoom: 16,
            duration: 1000
          });
          
          console.log('✅ Route visualization complete');
        } else {
          console.warn('⚠️ Map reference not available for route visualization');
        }
      } else {
        throw new Error('No route found');
      }
    } catch (error) {
      console.error('❌ Error planning route:', error);
      alert(`Unable to plan route: ${error.message}\n\nPlease try again with different locations.`);
    } finally {
      setRouteLoading(false);
      setWeatherLoading(false);
    }
  };

  // Calculate actual bookings per week from GrabMap MCP popularity data
  const calculateActualBookingsPerWeek = (popularityData) => {
    if (!popularityData) return 0;
    
    // Handle different popularity data formats
    if (typeof popularityData === 'object') {
      // GrabMap MCP format: {pickupCount: X, dropoffCount: Y}
      const pickupCount = popularityData.pickupCount || 0;
      const dropoffCount = popularityData.dropoffCount || 0;
      
      // Total bookings = pickups + dropoffs (both represent ride activity)
      const totalBookings = pickupCount + dropoffCount;
      
      if (totalBookings > 0) {
        //console.log(`📊 Actual booking data: ${pickupCount} pickups + ${dropoffCount} dropoffs = ${totalBookings} total`);
      }
      return totalBookings;
    } else if (typeof popularityData === 'number') {
      // Fallback: If it's a simple numeric score, convert to estimated bookings
      console.log(`📊 Fallback: Converting popularity score ${popularityData} to estimated bookings`);
      return Math.floor(popularityData * 50); // Scale factor for fallback
    }
    
    return 0;
  };

  // Check if POI is popular enough for star indicator based on actual booking data
  const isPopularPOI = (popularityData) => {
    if (!popularityData) return false;
    
    const totalBookings = calculateActualBookingsPerWeek(popularityData);
    
    // Threshold: 2000+ total bookings per week gets a star
    // This represents high-traffic locations
    return totalBookings >= 2000;
  };

  // Format popularity display with actual booking numbers
  const formatPopularityText = (popularityData) => {
    if (!popularityData) return null;
    
    const totalBookings = calculateActualBookingsPerWeek(popularityData);
    if (totalBookings === 0) return null;
    
    // Qualitative labels only (no raw booking counts in the UI)
    if (typeof popularityData === 'object' && (popularityData.pickupCount || popularityData.dropoffCount)) {
      if (totalBookings >= 2000) return 'Very popular with riders';
      if (totalBookings >= 500) return 'Popular with riders';
      return 'Moderate rider activity';
    }
    if (typeof popularityData === 'number') {
      if (totalBookings >= 2000) return 'Very popular with riders';
      if (totalBookings >= 500) return 'Popular with riders';
      return 'Moderate rider activity';
    }
    return null;
  };

  // Clear POI markers only (keep route markers)
  const clearPOIMarkers = () => {
    markersRef.current.forEach(marker => marker.remove());
    markersRef.current = [];
  };

  /** Clear POI + A/B route markers + route line — keeps landmark & destination-dining markers (they re-sync from state). */
  const clearRouteABMarkersAndLayer = () => {
    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current = [];
    routeMarkersRef.current.forEach((marker) => marker.remove());
    routeMarkersRef.current = [];
    if (mapRef.current && mapRef.current.getLayer && mapRef.current.getLayer('route')) {
      try {
        mapRef.current.removeLayer('route');
        mapRef.current.removeSource('route');
        console.log('🧹 Route layer and source removed');
      } catch (error) {
        console.warn('Route layer may not exist:', error);
      }
    }
    activeRouteGeometryRef.current = null;
    setHasRouteOnMap(false);
    stopRoutePlaybackAnim(false);
  };

  // Clear all markers including route + landmark markers
  const clearAllMarkers = () => {
    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current = [];

    routeLandmarkMarkersRef.current.forEach((m) => m.remove());
    routeLandmarkMarkersRef.current = [];

    diningMarkersRef.current.forEach((m) => m.remove());
    diningMarkersRef.current = [];
    setDestinationDiningPicks([]);
    setDiningPanelExpanded(false);
    setShowDiningMarkers(false);
    setShowLandmarkMarkers(false);

    routeMarkersRef.current.forEach((marker) => marker.remove());
    routeMarkersRef.current = [];

    if (mapRef.current && mapRef.current.getLayer && mapRef.current.getLayer('route')) {
      try {
        mapRef.current.removeLayer('route');
        mapRef.current.removeSource('route');
        console.log('🧹 Route layer and source removed');
      } catch (error) {
        console.warn('Route layer may not exist:', error);
      }
    }
    activeRouteGeometryRef.current = null;
    setHasRouteOnMap(false);
    stopRoutePlaybackAnim(false);
  };

  // Waypoint management functions
  const addWaypoint = (point) => {
    const waypointData = {
      id: point.id,
      name: point.name,
      address: point.address,
      location: point.location,
      coordinates: point.location ? [point.location.longitude, point.location.latitude] : point.coordinates
    };
    setWaypoints(prev => [...prev, waypointData]);
    console.log('📍 Waypoint added:', waypointData.name);
  };

  const removeWaypoint = (index) => {
    setWaypoints(prev => {
      const updated = prev.filter((_, i) => i !== index);
      console.log(`🗑️ Waypoint ${index + 1} removed`);
      return updated;
    });
  };

  const moveWaypoint = (fromIndex, toIndex) => {
    setWaypoints(prev => {
      const updated = [...prev];
      const [moved] = updated.splice(fromIndex, 1);
      updated.splice(toIndex, 0, moved);
      console.log(`📍 Waypoint moved from position ${fromIndex + 1} to ${toIndex + 1}`);
      return updated;
    });
  };

  // Search POIs — Grab `/api/v1/maps/poi/v1/search` with bounds per https://maps.grab.com/developer/documentation/searching
  const searchPOIs = async (query) => {
    if (!query.trim()) {
      setSearchResults([]);
      setLastPoiSearchQuery('');
      clearPOIMarkers();
      setSelectedPOIIndex(null);
      return;
    }

    console.log('🔍 Grab POI search:', query);
    setLoading(true);
    setSelectedPOIIndex(null);

    try {
      const { lat, lng, radiusMeters, boundsRect, boundsParam, usedLiveMap, anchor } =
        resolvePoiSearchContext(query.trim());
      console.log('📍 POI search:', { lat, lng, radiusMeters, boundsParam, usedLiveMap, anchor });

      if (!usedLiveMap) {
        console.warn(
          'POI search: map is not ready or bounds are invalid — using country center only. Results may not match the visible map.'
        );
      }

      let transformedPOIs = await searchGrabPois({
        keyword: query.trim(),
        lat,
        lng,
        country: boundsParam ? null : poiCountryKey,
        limit: 20,
        radius: radiusMeters,
        bounds: boundsParam || undefined,
        userLocation: userLocation ? { latitude: userLocation.latitude, longitude: userLocation.longitude } : null,
        calculateDistance
      });

      if (boundsRect && transformedPOIs.length > 0) {
        const inView = transformedPOIs.filter((poi) => isPoiInsideBounds(poi, boundsRect));
        if (inView.length > 0) {
          transformedPOIs = inView;
        }
      }

      const rankedDiningIds = new Set(
        (destinationDiningPicks || [])
          .map((p) => (p.id != null && p.id !== '' ? String(p.id) : null))
          .filter(Boolean)
      );
      if (rankedDiningIds.size > 0) {
        transformedPOIs = transformedPOIs.filter((poi) => {
          const id = poi.id != null && poi.id !== '' ? String(poi.id) : null;
          return !id || !rankedDiningIds.has(id);
        });
      }

      if (anchor === 'destination' && endPoint) {
        const ep = locationToLngLatArray(endPoint);
        if (ep) {
          const [elng, elat] = ep;
          const maxKmFromB = 3;
          transformedPOIs = transformedPOIs.filter((poi) => {
            const plat = Number(poi.location?.latitude);
            const plng = Number(poi.location?.longitude);
            if (!Number.isFinite(plat) || !Number.isFinite(plng)) return false;
            const km = calculateDistance(elat, elng, plat, plng);
            return km <= maxKmFromB;
          });
        }
      }

      if (transformedPOIs.length > 1) {
        const distToSearchCenter = (poi) =>
          calculateDistance(lat, lng, Number(poi.location.latitude), Number(poi.location.longitude));
        transformedPOIs = [...transformedPOIs].sort(
          (a, b) => distToSearchCenter(a) - distToSearchCenter(b)
        );
      }

      transformedPOIs = transformedPOIs.slice(0, 20);

      if (transformedPOIs.length > 0) {
        console.log(`✅ Found ${transformedPOIs.length} Grab POIs`);
        transformedPOIs.forEach((poi) => {
          if (poi.popularity) {
            const totalBookings = calculateActualBookingsPerWeek(poi.popularity);
            console.log(`📊 ${poi.name}: ${totalBookings} bookings/week`);
          }
        });

        const q = query.trim();
        setLastPoiSearchQuery(q);
        setSearchResults(transformedPOIs);
        clearPOIMarkers();

        if (mapRef.current) {
          transformedPOIs.forEach((poi, index) => addEnhancedMarker(poi, index, q));
        }
      } else {
        console.warn('⚠️ No Grab POIs found for:', query);
        setSearchResults([]);
        setLastPoiSearchQuery('');
        clearPOIMarkers();
      }
    } catch (error) {
      console.error('❌ Grab POI search failed:', error);
      alert(`Search failed: ${error.message}\n\nPlease check your internet connection and try again.`);
      setSearchResults([]);
      setLastPoiSearchQuery('');
      clearPOIMarkers();
    } finally {
      setLoading(false);
      console.log('🏁 Grab POI search completed');
    }
  };

  // Create POI marker following GrabMaps MCP best practices
  const addEnhancedMarker = (poi, index, searchKeywordForIcons = '') => {
    if (!mapRef.current || !poi.location) {
      console.warn('⚠️ Map reference or POI location missing:', { mapRef: !!mapRef.current, location: poi.location });
      return;
    }
    
    //console.log('✅ Creating marker for:', poi.name);

    try {
      // Create simple green marker element following MCP guidance
      const markerElement = document.createElement('div');
      markerElement.className = 'grab-poi-marker';
      markerElement.dataset.poiIndex = index; // Store index for reference
      markerElement.style.cssText = `
        width: 32px;
        height: 32px;
        background-color: #ffffff;
        border: 2px solid #00b14f;
        border-radius: 50%;
        cursor: pointer;
        box-shadow: 0 3px 12px rgba(0, 177, 79, 0.3);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1;
        transition: box-shadow 0.3s ease, filter 0.3s ease, border 0.3s ease, background 0.3s ease;
      `;
      const iconKind = resolvePoiMarkerIconType(
        poi.businessType,
        poi.category,
        searchKeywordForIcons
      );
      markerElement.innerHTML = poiKindLucideSvgString(iconKind, 15);

      // Add click handler to marker for highlighting
      markerElement.addEventListener('click', () => {
        setSelectedPOIIndex(index);
        highlightMarker(index);
        
        // Scroll to corresponding list item
        setTimeout(() => {
          const listItem = document.querySelector(`[data-poi-index="${index}"]`);
          if (listItem) {
            listItem.scrollIntoView({ 
              behavior: 'smooth', 
              block: 'center' 
            });
          }
        }, 100);
      });

      // Calculate popularity information for popup
      const popularityText = formatPopularityText(poi.popularity);
      const isPOIPopular = isPopularPOI(poi.popularity);
      const popularityColor = isPOIPopular ? '#faad14' : '#666';

      // Create popup with POI details
      const popupContent = document.createElement('div');
      popupContent.className = 'grab-poi-popup';
      popupContent.innerHTML = `
        <div style="min-width: 250px; max-width: 350px; width: max-content; font-family: 'Plus Jakarta Sans', sans-serif; box-sizing: border-box; padding: 4px;">
          <h3 style="margin: 0 0 10px 0; color: #262626; font-size: 16px; font-weight: 600; line-height: 1.3; word-wrap: break-word; overflow-wrap: break-word; hyphens: auto; max-width: 100%; display: block;" title="${poi.name || 'Unknown Location'}">
            ${poi.name || 'Unknown Location'}
          </h3>
          ${popularityText ? `<p style="margin: 4px 0; color: ${popularityColor}; font-size: 12px; font-weight: 500;">${popularityText}</p>` : ''}
          <div style="margin-bottom: 12px;">
            <p style="margin: 4px 0; color: #595959; font-size: 13px; line-height: 1.4; word-wrap: break-word; overflow-wrap: break-word;">
              <strong style="color: #262626;">Address:</strong><br/>
              <span style="color: #666;">${poi.address || 'No address available'}</span>
            </p>
            ${poi.phone ? `<p style="margin: 6px 0 4px 0; color: #595959; font-size: 13px;"><strong style="color: #262626;">Phone:</strong> <span style="color: #666;">${poi.phone}</span></p>` : ''}
            ${poi.businessType ? `<p style="margin: 4px 0; color: #1890ff; font-size: 12px; font-weight: 500;"><strong>Type:</strong> ${poi.businessType.replace(/_/g, ' ')}</p>` : ''}
            ${poi.distance !== null ? `<p style="margin: 4px 0; color: #666; font-size: 12px; font-weight: 500;"><strong>Distance:</strong> ${poi.distance.toFixed(2)} km</p>` : ''}
            ${poi.attributes && poi.attributes.length > 0 ? `<p style="margin: 4px 0; color: #fa8c16; font-size: 12px; word-wrap: break-word; font-weight: 500;"><strong>Features:</strong> ${poi.attributes.slice(0, 3).join(', ')}</p>` : ''}
            ${poi.techFamilies && poi.techFamilies.length > 0 ? `<p style="margin: 4px 0; color: #00b14f; font-size: 12px; font-weight: 500;"><strong>Services:</strong> ${poi.techFamilies.map(tf => tf.replace('grab', 'Grab')).join(', ')}</p>` : ''}
          </div>
          <div style="display: flex; flex-direction: column; gap: 8px; width: 100%; box-sizing: border-box; margin-top: auto; flex-shrink: 0;">
            <div style="display: flex; gap: 8px;">
              <button data-action="set-start" style="padding: 10px 16px; background-color: #52c41a; color: white; border: none; border-radius: 8px; font-size: 12px; cursor: pointer; flex: 1; min-width: 90px; font-weight: 600; box-shadow: 0 2px 4px rgba(82, 196, 26, 0.3); transition: all 0.2s ease;" onmouseover="this.style.backgroundColor='#73d13d'" onmouseout="this.style.backgroundColor='#52c41a'">
                Set as Start
              </button>
              <button data-action="set-end" style="padding: 10px 16px; background-color: #f5222d; color: white; border: none; border-radius: 8px; font-size: 12px; cursor: pointer; flex: 1; min-width: 90px; font-weight: 600; box-shadow: 0 2px 4px rgba(245, 34, 45, 0.3); transition: all 0.2s ease;" onmouseover="this.style.backgroundColor='#ff4d4f'" onmouseout="this.style.backgroundColor='#f5222d'">
                Set as End
              </button>
            </div>
            <button data-action="add-waypoint" style="padding: 10px 16px; background-color: #1890ff; color: white; border: none; border-radius: 8px; font-size: 12px; cursor: pointer; width: 100%; font-weight: 600; box-shadow: 0 2px 4px rgba(24, 144, 255, 0.3); transition: all 0.2s ease;" onmouseover="this.style.backgroundColor='#40a9ff'" onmouseout="this.style.backgroundColor='#1890ff'">
              ➕ Add as Waypoint
            </button>
          </div>
        </div>
      `;

      // Create button event handlers that don't rely on global scope
      const handleSetAsStart = () => {
        console.log('🎯 Setting as start point:', poi.name);
        const startPointData = {
          id: poi.id,
          name: poi.name,
          address: poi.address,
          location: poi.location,
          coordinates: [poi.location.longitude, poi.location.latitude]
        };
        setStartPoint(startPointData);
        console.log('📍 Set start point:', startPointData.name);
        if (popup) popup.remove(); // Close popup after selection
      };

      const handleSetAsEnd = () => {
        console.log('🎯 Setting as end point:', poi.name);
        const endPointData = {
          id: poi.id,
          name: poi.name,
          address: poi.address,
          location: poi.location,
          coordinates: [poi.location.longitude, poi.location.latitude]
        };
        setEndPoint(endPointData);
        console.log('🎯 Set end point:', endPointData.name);
        if (popup) popup.remove(); // Close popup after selection
      };

      const handleAddAsWaypoint = () => {
        console.log('📍 Adding as waypoint:', poi.name);
        const waypointData = {
          id: poi.id,
          name: poi.name,
          address: poi.address,
          location: poi.location,
          coordinates: [poi.location.longitude, poi.location.latitude]
        };
        addWaypoint(waypointData);
        if (popup) popup.remove(); // Close popup after selection
      };

      // Create popup following MCP guidance
      const popup = new maplibregl.Popup({
        closeButton: true,
        closeOnClick: true,
        offset: [0, -30],
        className: 'grab-poi-popup-container',
        maxWidth: '400px'
      })
        .setLngLat([poi.location.longitude, poi.location.latitude])
        .setDOMContent(popupContent);

      // Variables to store button references for cleanup
      let startButton, endButton, waypointButton;

      // Attach event listeners after popup is opened (when DOM is ready)
      popup.on('open', () => {
        console.log('🎯 Popup opened for:', poi.name);
        
        const popupElement = popup.getElement();
        if (popupElement) {
          popupElement.style.zIndex = '99999';
          
          // Find buttons in the actual popup DOM (not the template)
          startButton = popupElement.querySelector('[data-action="set-start"]');
          endButton = popupElement.querySelector('[data-action="set-end"]');
          waypointButton = popupElement.querySelector('[data-action="add-waypoint"]');
          
          console.log('🔘 Start button found in popup:', !!startButton);
          console.log('🔘 End button found in popup:', !!endButton);
          console.log('🔘 Waypoint button found in popup:', !!waypointButton);
          
          if (startButton) {
            startButton.addEventListener('click', handleSetAsStart);
            console.log('✅ Start button event listener attached for:', poi.name);
          } else {
            console.warn('⚠️ Start button not found in popup DOM');
          }
          
          if (endButton) {
            endButton.addEventListener('click', handleSetAsEnd);
            console.log('✅ End button event listener attached for:', poi.name);
          } else {
            console.warn('⚠️ End button not found in popup DOM');
          }

          if (waypointButton) {
            waypointButton.addEventListener('click', handleAddAsWaypoint);
            console.log('✅ Waypoint button event listener attached for:', poi.name);
          } else {
            console.warn('⚠️ Waypoint button not found in popup DOM');
          }
        }
      });

      // Clean up event listeners when popup is closed
      popup.on('close', () => {
        if (startButton) {
          startButton.removeEventListener('click', handleSetAsStart);
        }
        if (endButton) {
          endButton.removeEventListener('click', handleSetAsEnd);
        }
        if (waypointButton) {
          waypointButton.removeEventListener('click', handleAddAsWaypoint);
        }
        //console.log('🧹 Popup event listeners cleaned up for:', poi.name);
      });

      // MapLibre requires `{ element }` — passing the node as the first arg omits `element` and creates the default blue teardrop on top of custom UI.
      const marker = new maplibregl.Marker({ element: markerElement })
        .setLngLat([poi.location.longitude, poi.location.latitude])
        .setPopup(popup)
        .addTo(mapRef.current);

      markersRef.current.push(marker);
      console.log('✅ Marker added successfully for:', poi.name);

    } catch (error) {
      console.error('Error creating marker for', poi.name, ':', error);
    }
  };

  // Add route markers following MCP guidance with A, B, C labeling
  const addRouteMarker = (location, type, letter = null) => {
    if (!mapRef.current) {
      console.warn('⚠️ Cannot add route marker: map reference missing');
      return;
    }

    // Handle different coordinate formats from LandingPage vs MapView
    let coordinates;
    if (location.coordinates && Array.isArray(location.coordinates)) {
      coordinates = location.coordinates;
    } else if (location.location && location.location.longitude && location.location.latitude) {
      coordinates = [location.location.longitude, location.location.latitude];
    } else {
      console.error('⚠️ Invalid location format for route marker:', location);
      return;
    }

    console.log(`📍 Adding ${type} route marker (${letter}) at:`, coordinates);

    const markerElement = document.createElement('div');
    markerElement.className = `route-marker ${type}-marker`;
    
    // Use the provided letter for all marker types
    markerElement.innerHTML = letter || 'A';
    
    // Set consistent styling for all markers with color variations
    let backgroundColor, shadowColor;
    if (type === 'start') {
      backgroundColor = '#52c41a';
      shadowColor = 'rgba(82, 196, 26, 0.4)';
    } else if (type === 'end') {
      backgroundColor = '#f5222d';
      shadowColor = 'rgba(245, 34, 45, 0.4)';
    } else {
      backgroundColor = '#1890ff';
      shadowColor = 'rgba(24, 144, 255, 0.4)';
    }
    
    markerElement.style.cssText = `
      width: 40px;
      height: 40px;
      background-color: ${backgroundColor};
      color: white;
      border: 3px solid white;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      font-size: 16px;
      box-shadow: 0 4px 12px ${shadowColor};
      z-index: 1000;
      cursor: pointer;
      transition: transform 0.2s ease;
    `;
    
    // Add hover effect
    markerElement.addEventListener('mouseenter', () => {
      markerElement.style.transform = 'scale(1.1)';
    });
    
    markerElement.addEventListener('mouseleave', () => {
      markerElement.style.transform = 'scale(1)';
    });

    const marker = new maplibregl.Marker({ element: markerElement })
      .setLngLat([coordinates[0], coordinates[1]])
      .addTo(mapRef.current);

    routeMarkersRef.current.push(marker);
    console.log(`✅ ${type} route marker (${letter}) added successfully`);
  };

  // Draw route from geometry (Grab navigation GeoJSON LineString)
  const drawRouteFromGeometry = (geometry) => {
    if (!mapRef.current || !geometry) {
      console.warn('⚠️ Cannot draw route: missing map reference or geometry');
      return;
    }

    const lineCoords = geometry.type === 'LineString' ? geometry.coordinates : null;
    if (!Array.isArray(lineCoords) || lineCoords.length < 2) {
      console.warn('⚠️ Cannot draw route: LineString needs at least 2 coordinates', {
        type: geometry.type,
        count: lineCoords?.length
      });
      return;
    }

    // Validate that map is properly loaded and has required methods
    if (!mapRef.current.addSource || !mapRef.current.addLayer || typeof mapRef.current.addSource !== 'function') {
      console.warn('⚠️ Map not fully loaded yet, retrying in 1 second...');
      setTimeout(() => drawRouteFromGeometry(geometry), 1000);
      return;
    }

    try {
      // Remove existing route if it exists
      if (mapRef.current.getLayer && typeof mapRef.current.getLayer === 'function') {
        const existingLayer = mapRef.current.getLayer('route');
        if (existingLayer) {
          mapRef.current.removeLayer('route');
          mapRef.current.removeSource('route');
          console.log('🗺️ Removed existing route layer');
        }
      }

      // Add new route source
      mapRef.current.addSource('route', {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: geometry
        }
      });

      // Add new route layer
      mapRef.current.addLayer({
        id: 'route',
        type: 'line',
        source: 'route',
        layout: {
          'line-join': 'round',
          'line-cap': 'round'
        },
        paint: {
          'line-color': '#00b14f',
          'line-width': 4
        }
      });
      
      console.log('✅ Route drawn successfully on map');
      activeRouteGeometryRef.current = geometry;
      setHasRouteOnMap(true);
    } catch (error) {
      console.error('❌ Error drawing route:', error);
      
      // If it's a map loading issue, retry after a delay
      if (error.message && error.message.includes('getCanvasContainer')) {
        console.log('🔄 Retrying route drawing after map loads...');
        setTimeout(() => drawRouteFromGeometry(geometry), 2000);
      }
    }
  };

  const seekRoutePlaybackToPct = (pct) => {
    const run = routePlaybackRunRef.current;
    const map = resolveGrabMapInstance(mapRef.current);
    if (!run || !map || run.cancelled) return;
    const f = Math.max(0, Math.min(100, pct)) / 100;
    const coords = run.coords;
    const cum = run.cum;
    const totalM = run.totalM;
    const durationMs = run.durationMs;
    const marker = run.marker;
    run.playbackClockStart = performance.now() - f * durationMs;
    run.wallPausedMs = 0;
    if (run.paused) {
      run.pauseWallStart = performance.now();
    }
    const distM = f * totalM;
    const { lngLat, bearing } = interpolateRouteByMeters(coords, cum, distM);
    const streetBlend = computeStreetBlend(distM, totalM, f);
    const pitch = lerpNum(run.pitchCruise, run.pitchStreet, streetBlend);
    const zoom = lerpNum(run.zoomCruise, run.zoomStreet, streetBlend);
    const lookAhead = lerpNum(run.lookAheadCruise, run.lookAheadStreet, streetBlend);
    const center = offsetLngLatAlongBearing(lngLat, bearing, lookAhead);
    try {
      marker.setLngLat(lngLat).setRotation(bearing);
      map.jumpTo({ center, bearing, pitch, zoom });
    } catch (_) {
      /* ignore */
    }
    run.smoothCenter = center.slice();
    run.smoothBearing = bearing;
    run.smoothPitch = pitch;
    run.smoothZoom = zoom;
    setRoutePlaybackProgressPct(f * 100);
  };

  const toggleRoutePlaybackPause = () => {
    const run = routePlaybackRunRef.current;
    if (!run || run.cancelled) return;
    if (run.paused) {
      run.wallPausedMs += performance.now() - run.pauseWallStart;
      run.paused = false;
      setRoutePlaybackPaused(false);
    } else {
      run.pauseWallStart = performance.now();
      run.paused = true;
      setRoutePlaybackPaused(true);
    }
  };

  const startRoutePlayback = () => {
    const map = resolveGrabMapInstance(mapRef.current);
    const geom = activeRouteGeometryRef.current;
    if (!map || !geom?.coordinates?.length) return;
    const coords = geom.coordinates;
    if (coords.length < 2) return;

    const { totalM, cum } = buildRouteDistanceIndex(coords);
    if (totalM < 8) return;

    stopRoutePlaybackAnim(false);

    try {
      map.setMaxPitch(85);
    } catch (_) {
      /* ignore */
    }

    const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
    let zoomFromBounds = 17.6;
    try {
      const cam = map.cameraForBounds(bounds, { padding: 48, maxZoom: 18.55 });
      if (cam && typeof cam.zoom === 'number' && Number.isFinite(cam.zoom)) zoomFromBounds = cam.zoom;
    } catch (_) {
      /* ignore */
    }
    const zoomCruise = Math.min(18.72, Math.max(17.15, zoomFromBounds + 0.52));
    const zoomStreet = Math.min(18.98, zoomCruise + 0.48);
    const pitchCruise = 70;
    const pitchStreet = 72;
    const lookAheadCruise = 44;
    const lookAheadStreet = 24;
    const durationMs = Math.min(90000, Math.max(24000, totalM * 40));

    const { lngLat: startLl, bearing: startBr } = interpolateRouteByMeters(coords, cum, 0);
    const startCenter = offsetLngLatAlongBearing(startLl, startBr, lookAheadCruise);

    const marker = new maplibregl.Marker({
      element: createRoutePlaybackArrowElement(),
      rotationAlignment: 'map',
      pitchAlignment: 'map',
      anchor: 'bottom'
    })
      .setLngLat(startLl)
      .setRotation(startBr)
      .addTo(map);

    try {
      map.jumpTo({
        center: startCenter,
        zoom: zoomCruise,
        pitch: pitchCruise,
        bearing: startBr
      });
    } catch (_) {
      /* ignore */
    }

    const run = {
      cancelled: false,
      rafId: 0,
      marker,
      coords,
      cum,
      totalM,
      durationMs,
      zoomCruise,
      zoomStreet,
      pitchCruise,
      pitchStreet,
      lookAheadCruise,
      lookAheadStreet,
      paused: false,
      playbackClockStart: performance.now(),
      wallPausedMs: 0,
      pauseWallStart: 0,
      lastUiMs: 0,
      smoothCenter: null,
      smoothBearing: null,
      smoothPitch: null,
      smoothZoom: null,
      glideAlpha: 0.16
    };
    routePlaybackRunRef.current = run;
    setRoutePlaybackActive(true);
    setRoutePlaybackPaused(false);
    setRoutePlaybackProgressPct(0);

    const tick = () => {
      const live = routePlaybackRunRef.current;
      if (!live || live !== run || run.cancelled) return;
      const now = performance.now();
      let wall = now - run.playbackClockStart - run.wallPausedMs;
      if (run.paused) {
        wall -= now - run.pauseWallStart;
      }
      const rawLinear = Math.min(1, Math.max(0, wall / durationMs));
      const distM = rawLinear * totalM;
      const { lngLat, bearing } = interpolateRouteByMeters(coords, cum, distM);

      try {
        marker.setLngLat(lngLat).setRotation(bearing);
      } catch (_) {
        /* ignore */
      }

      const streetBlend = computeStreetBlend(distM, totalM, rawLinear);
      const pitch = lerpNum(pitchCruise, pitchStreet, streetBlend);
      const zoom = lerpNum(zoomCruise, zoomStreet, streetBlend);
      const lookAhead = lerpNum(lookAheadCruise, lookAheadStreet, streetBlend);
      const center = offsetLngLatAlongBearing(lngLat, bearing, lookAhead);

      const ga = run.glideAlpha;
      if (!run.smoothCenter) {
        run.smoothCenter = center.slice();
        run.smoothBearing = bearing;
        run.smoothPitch = pitch;
        run.smoothZoom = zoom;
      } else {
        run.smoothCenter = lerpLngLat(run.smoothCenter, center, ga);
        run.smoothBearing = lerpBearingDeg(run.smoothBearing, bearing, ga);
        run.smoothPitch = lerpNum(run.smoothPitch, pitch, ga);
        run.smoothZoom = lerpNum(run.smoothZoom, zoom, ga);
      }
      try {
        map.jumpTo({
          center: run.smoothCenter,
          bearing: run.smoothBearing,
          pitch: run.smoothPitch,
          zoom: run.smoothZoom
        });
      } catch (_) {
        /* ignore */
      }

      if (now - run.lastUiMs > 120) {
        run.lastUiMs = now;
        setRoutePlaybackProgressPct(rawLinear * 100);
      }

      if (rawLinear < 1) {
        run.rafId = requestAnimationFrame(tick);
      } else {
        try {
          map.jumpTo({ center, bearing, pitch, zoom });
        } catch (_) {
          /* ignore */
        }
        run.smoothCenter = null;
        setRoutePlaybackProgressPct(100);
        stopRoutePlaybackAnim(true);
      }
    };

    run.rafId = requestAnimationFrame(tick);
    requestAnimationFrame(() => {
      try {
        map.resize?.();
      } catch (_) {
        /* ignore */
      }
    });
  };

  /**
   * Grab basemap: fetch `…/api/style.json` with Bearer, pass JSON to MapLibre (full vector: roads, buildings).
   * Optional: `REACT_APP_GRAB_MAPS_LIBRARY_FIRST=true` + `REACT_APP_GRAB_MAPS_LIBRARY_URL` — uses GrabMapsLib (config)
   * or MapBuilder when the bundle provides them; see Grab UI Library config docs.
   * @see https://maps.grab.com/developer/documentation/initializing-map
   * @see https://maps.grab.com/developer/documentation/ui-library-config
   * Re-inits when `isMobile` toggles because the map container lives in only one layout branch.
   */
  useEffect(() => {
    let cancelled = false;
    let mapInstance = null;
    let grabMapWrapper = null;
    let rafId = 0;

    const attachGrabBasemapHandlers = (map, { skipNavigationControl } = {}) => {
      if (!map || cancelled) return;
      mapRef.current = map;

      const ctrlKey = '_journeygenieMapControlsAdded';
      if (!map[ctrlKey]) {
        map[ctrlKey] = true;
        try {
          if (!skipNavigationControl) {
            map.addControl(
              new maplibregl.NavigationControl({ visualizePitch: true }),
              'top-right'
            );
          }
          map.addControl(
            new maplibregl.GeolocateControl({
              positionOptions: { enableHighAccuracy: true },
              trackUserLocation: false,
            }),
            'top-right'
          );
          map.addControl(
            new maplibregl.ScaleControl({ maxWidth: 140, unit: 'metric' }),
            'bottom-left'
          );
        } catch (e) {
          console.warn('Could not add map controls:', e);
        }
      }

      if (typeof map.on === 'function') {
        map.on('moveend', () => {
          try {
            const center = map.getCenter();
            const lat = Number(center?.lat);
            const lng = Number(center?.lng);
            if (Number.isFinite(lat) && Number.isFinite(lng)) {
              setPoiCountryKey(inferCountryFromMapRef.current(lat, lng));
            }
          } catch (error) {
            console.warn('Could not get updated map center:', error);
          }
        });
      }

      try {
        const c0 = map.getCenter();
        const la0 = Number(c0?.lat);
        const ln0 = Number(c0?.lng);
        if (Number.isFinite(la0) && Number.isFinite(ln0)) {
          setPoiCountryKey(inferCountryFromMapRef.current(la0, ln0));
        }
      } catch (_) {
        /* ignore */
      }

      // Flex layout can leave the container at 0×0 during first paint; Grab basic-init parity.
      requestAnimationFrame(() => {
        try {
          map.resize?.();
        } catch (_) {
          /* ignore */
        }
      });
    };

    rafId = requestAnimationFrame(() => {
      if (cancelled || !document.getElementById('journeygenie-grab-map')) return;
      (async () => {
        try {
          const { map, wrapper, via } = await createGrabMapWithPreferredInit({
            container: 'journeygenie-grab-map',
            center: getInitialMapCenter(),
            zoom: 12,
            minZoom: 2
          });
          if (cancelled) {
            try {
              if (wrapper && typeof wrapper.destroy === 'function') {
                wrapper.destroy();
              } else {
                map.remove();
              }
            } catch (_) {
              /* ignore */
            }
            return;
          }
          mapInstance = map;
          grabMapWrapper = wrapper;
          const runAttach = () =>
            attachGrabBasemapHandlers(map, {
              skipNavigationControl: via === 'grab-library' || via === 'grab-maps-lib'
            });
          if (typeof map.isStyleLoaded === 'function' && map.isStyleLoaded()) {
            runAttach();
          } else if (typeof map.once === 'function') {
            map.once('load', runAttach);
          } else {
            setTimeout(runAttach, 300);
          }
        } catch (err) {
          console.error('Grab map init failed:', err);
        }
      })();
    });

    return () => {
      cancelled = true;
      stopRoutePlaybackAnim(false);
      if (rafId) cancelAnimationFrame(rafId);
      try {
        if (grabMapWrapper && typeof grabMapWrapper.destroy === 'function') {
          grabMapWrapper.destroy();
        } else {
          mapInstance?.remove?.();
        }
      } catch (_) {
        /* ignore */
      }
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount per layout branch; center from latest render via getInitialMapCenter
  }, [isMobile]);

  useEffect(() => {
    mapRef.current?.resize?.();
  }, [isMobile]);

  // Handle quick search buttons
  const quickSearch = (query) => {
    setSearchValue(query);
    searchPOIs(query);
  };

  const handlePOIClick = (poi, index) => {
    console.log('🎯 POI clicked:', poi, 'at index:', index);
    setSelectedPOIIndex(index);
    
    // Center map on selected POI
    if (mapRef.current && poi.location) {
      mapRef.current.flyTo({
        center: [poi.location.longitude, poi.location.latitude],
        zoom: 16,
        duration: 1000,
        essential: true
      });
    }

    // Highlight and bounce the corresponding marker
    if (markersRef.current[index]) {
      highlightMarker(index);
    }
  };

  const flyToLandmark = (lm) => {
    if (!mapRef.current || !lm?.location) return;
    const { longitude, latitude } = lm.location;
    if (latitude == null || longitude == null) return;
    if (isMobile) {
      setShowMobileSidebar(false);
      setActiveView('map');
    }
    mapRef.current.flyTo({
      center: [longitude, latitude],
      zoom: 18,
      duration: 1000,
      essential: true
    });
  };

  useEffect(() => {
    let cancelled = false;
    const clearLmMarkers = () => {
      routeLandmarkMarkersRef.current.forEach((m) => m.remove());
      routeLandmarkMarkersRef.current = [];
    };

    if (!routeLandmarks?.length || !showLandmarkMarkers) {
      clearLmMarkers();
      return clearLmMarkers;
    }

    const run = (attempt = 0) => {
      if (cancelled) return;
      const map = mapRef.current;
      if (!isMapReadyForMapboxMarkers(map)) {
        if (attempt < 40) setTimeout(() => run(attempt + 1), 200);
        return;
      }

      clearLmMarkers();

      routeLandmarks.forEach((lm) => {
        const lat = lm.location?.latitude;
        const lng = lm.location?.longitude;
        if (lat == null || lng == null) return;

        const wrap = document.createElement('div');
        wrap.className = 'route-landmark-marker';
        wrap.style.cssText =
          'display:flex;flex-direction:column;align-items:center;cursor:pointer;pointer-events:auto;z-index:900;';

        const label = document.createElement('div');
        const fullName = lm.name || 'Sight';
        label.textContent = fullName.length > 40 ? `${fullName.slice(0, 38)}…` : fullName;
        label.title = fullName;
        label.style.cssText =
          'max-width:220px;padding:4px 10px;margin-bottom:2px;background:rgba(255,255,255,0.97);border:2px solid #52c41a;border-radius:8px;font-size:11px;font-weight:700;color:#1f1f1f;line-height:1.25;text-align:center;box-shadow:0 2px 10px rgba(0,0,0,0.12);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';

        const pin = document.createElement('div');
        pin.style.cssText =
          'width:36px;height:36px;border-radius:50%;background:#fff;border:3px solid #52c41a;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(82,196,26,0.35);';
        pin.innerHTML = poiKindLucideSvgString(
          resolvePoiMarkerIconType(lm.businessType, lm.category),
          15
        );

        wrap.appendChild(label);
        wrap.appendChild(pin);

        const box = document.createElement('div');
        box.style.cssText =
          "min-width:260px;max-width:340px;padding:4px;font-family:'Plus Jakarta Sans',sans-serif;";

        const h = document.createElement('h3');
        h.style.cssText = 'margin:0 0 8px 0;color:#262626;font-size:16px;font-weight:600;';
        h.textContent = lm.name || 'Sight';
        box.appendChild(h);

        let photoHref = null;
        if (lm.photoUrl && typeof lm.photoUrl === 'string') {
          try {
            const u = new URL(lm.photoUrl.trim());
            if (u.protocol === 'http:' || u.protocol === 'https:') photoHref = u.href;
          } catch {
            /* ignore */
          }
        }
        if (photoHref) {
          const im = document.createElement('img');
          im.src = photoHref;
          im.alt = '';
          im.style.cssText =
            'width:100%;max-height:200px;object-fit:cover;border-radius:8px;margin-bottom:10px;display:block;';
          box.appendChild(im);
        } else {
          const ph = document.createElement('div');
          ph.textContent = 'No photo available';
          ph.style.cssText =
            'height:120px;border-radius:8px;background:#f5f5f5;display:flex;align-items:center;justify-content:center;color:#999;font-size:13px;margin-bottom:10px;';
          box.appendChild(ph);
        }

        const addr = document.createElement('p');
        addr.style.cssText = 'margin:0 0 10px 0;color:#595959;font-size:13px;line-height:1.4;';
        const strong = document.createElement('strong');
        strong.textContent = 'Address';
        addr.appendChild(strong);
        addr.appendChild(document.createElement('br'));
        const span = document.createElement('span');
        span.style.color = '#666';
        span.textContent = lm.address || 'No address available';
        addr.appendChild(span);
        box.appendChild(addr);

        if (lm.side) {
          const sideEl = document.createElement('p');
          sideEl.style.cssText = 'margin:0 0 8px 0;color:#888;font-size:12px;';
          sideEl.textContent = `${lm.side} side of route`;
          box.appendChild(sideEl);
        }
        if (lm.distance != null && typeof lm.distance === 'number') {
          const dEl = document.createElement('p');
          dEl.style.cssText = 'margin:0 0 10px 0;color:#888;font-size:12px;';
          dEl.textContent = `About ${lm.distance.toFixed(1)} km along your route`;
          box.appendChild(dEl);
        }

        const zoomBtn = document.createElement('button');
        zoomBtn.type = 'button';
        zoomBtn.textContent = 'Zoom map here';
        zoomBtn.style.cssText =
          'margin-bottom:10px;padding:8px 14px;width:100%;border-radius:8px;border:1px solid #52c41a;background:#f6ffed;color:#389e0d;font-weight:600;cursor:pointer;font-size:13px;';
        zoomBtn.addEventListener('click', () => {
          flyToLandmark(lm);
        });
        box.appendChild(zoomBtn);

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;';
        const bStart = document.createElement('button');
        bStart.type = 'button';
        bStart.textContent = 'Set as Start';
        bStart.style.cssText =
          'flex:1;padding:10px;background:#52c41a;color:white;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;';
        const bEnd = document.createElement('button');
        bEnd.type = 'button';
        bEnd.textContent = 'Set as End';
        bEnd.style.cssText =
          'flex:1;padding:10px;background:#f5222d;color:white;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;';
        btnRow.appendChild(bStart);
        btnRow.appendChild(bEnd);
        box.appendChild(btnRow);

        const bWp = document.createElement('button');
        bWp.type = 'button';
        bWp.textContent = 'Add as Waypoint';
        bWp.style.cssText =
          'margin-top:8px;width:100%;padding:10px;background:#1890ff;color:white;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;';
        box.appendChild(bWp);

        const poi = {
          id: lm.id,
          name: lm.name,
          address: lm.address,
          location: { longitude: lng, latitude: lat },
          coordinates: [lng, lat]
        };

        const popup = new maplibregl.Popup({
          closeButton: true,
          closeOnClick: true,
          offset: [0, -10],
          className: 'grab-poi-popup-container',
          maxWidth: '360px'
        })
          .setLngLat([lng, lat])
          .setDOMContent(box);

        bStart.addEventListener('click', () => {
          setStartPoint({
            id: poi.id,
            name: poi.name,
            address: poi.address,
            location: poi.location,
            coordinates: poi.coordinates
          });
          popup.remove();
        });
        bEnd.addEventListener('click', () => {
          setEndPoint({
            id: poi.id,
            name: poi.name,
            address: poi.address,
            location: poi.location,
            coordinates: poi.coordinates
          });
          popup.remove();
        });
        bWp.addEventListener('click', () => {
          addWaypoint({
            id: poi.id,
            name: poi.name,
            address: poi.address,
            location: poi.location,
            coordinates: poi.coordinates
          });
          popup.remove();
        });

        popup.on('open', () => {
          const el = popup.getElement();
          if (el) el.style.zIndex = '99999';
        });

        try {
          const marker = new maplibregl.Marker({ element: wrap, anchor: 'bottom' })
            .setLngLat([lng, lat])
            .setPopup(popup)
            .addTo(map);

          routeLandmarkMarkersRef.current.push(marker);
        } catch (e) {
          console.warn('Could not add route landmark marker:', e?.message || e);
        }
      });
    };

    run(0);
    return () => {
      cancelled = true;
      clearLmMarkers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- redraw when landmark set changes; map handlers use latest closures via re-run
  }, [routeLandmarks, showLandmarkMarkers]);

  // Grab-ranked restaurants near destination (strict straight-line radius) — fork/knife + rank badge
  useEffect(() => {
    let cancelled = false;
    const clearDining = () => {
      diningMarkersRef.current.forEach((m) => m.remove());
      diningMarkersRef.current = [];
    };

    if (!destinationDiningPicks?.length || !showDiningMarkers) {
      clearDining();
      return clearDining;
    }

    const rankStyle = (rank) => {
      const palette = [
        { ring: '#cf1322', labelBg: '#fff1f0' },
        { ring: '#fa8c16', labelBg: '#fff7e6' },
        { ring: '#faad14', labelBg: '#fffbe6' }
      ];
      return palette[(Math.min(rank, 3) - 1) % 3];
    };

    const run = (attempt = 0) => {
      if (cancelled) return;
      const map = mapRef.current;
      if (!isMapReadyForMapboxMarkers(map)) {
        if (attempt < 40) setTimeout(() => run(attempt + 1), 200);
        return;
      }

      clearDining();

      destinationDiningPicks.forEach((poi) => {
        const lat = poi.location?.latitude;
        const lng = poi.location?.longitude;
        if (lat == null || lng == null) return;
        const rank = poi.diningRank || 1;
        const rs = rankStyle(rank);

        const wrap = document.createElement('div');
        wrap.className = 'destination-dining-marker';
        wrap.style.cssText =
          'display:flex;flex-direction:column;align-items:center;cursor:pointer;pointer-events:auto;z-index:870;';

        const label = document.createElement('div');
        const fullName = poi.name || 'Restaurant';
        label.textContent = fullName.length > 34 ? `${fullName.slice(0, 32)}…` : fullName;
        label.title = `${fullName} — Grab-ranked #${rank} near your drop-off`;
        label.style.cssText = `max-width:210px;padding:4px 10px;margin-bottom:3px;background:${rs.labelBg};border:2px solid ${rs.ring};border-radius:8px;font-size:11px;font-weight:700;color:#262626;line-height:1.25;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;

        const pinWrap = document.createElement('div');
        pinWrap.style.cssText = 'position:relative;width:44px;height:44px;';

        const pin = document.createElement('div');
        pin.style.cssText = `position:absolute;left:2px;top:2px;width:40px;height:40px;border-radius:50%;background:#fff;border:3px solid ${rs.ring};display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,0.14);`;
        pin.innerHTML = poiKindLucideSvgString('restaurant', 15);

        const badge = document.createElement('div');
        badge.setAttribute('aria-label', `Rank ${rank}`);
        badge.textContent = `#${rank}`;
        badge.style.cssText = `position:absolute;top:-2px;right:-4px;min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:${rs.ring};color:#fff;font:bold 11px/22px system-ui,-apple-system,sans-serif;text-align:center;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.18);`;

        pinWrap.appendChild(pin);
        pinWrap.appendChild(badge);

        wrap.appendChild(label);
        wrap.appendChild(pinWrap);

        const box = document.createElement('div');
        box.style.cssText =
          "min-width:240px;max-width:320px;padding:8px;font-family:'Plus Jakarta Sans',sans-serif;";

        const rankEl = document.createElement('p');
        rankEl.style.cssText = 'margin:0 0 6px 0;font-size:12px;font-weight:700;color:#595959;';
        const diningRadiusCopy =
          DESTINATION_DINING_DISPLAY_MAX_METERS >= 1000
            ? `${DESTINATION_DINING_DISPLAY_MAX_METERS / 1000} km`
            : `${DESTINATION_DINING_DISPLAY_MAX_METERS} m`;
        rankEl.textContent = `🍽 Grab-ranked #${rank} (within ~${diningRadiusCopy} straight-line of your drop-off)`;
        box.appendChild(rankEl);

        const h = document.createElement('h3');
        h.style.cssText = 'margin:0 0 8px 0;color:#262626;font-size:16px;font-weight:600;';
        h.textContent = fullName;
        box.appendChild(h);

        const addr = document.createElement('p');
        addr.style.cssText = 'margin:0;color:#595959;font-size:13px;line-height:1.45;';
        addr.textContent = poi.address || 'Address not available';
        box.appendChild(addr);

        if (poi.distanceFromDestinationMeters != null && Number.isFinite(poi.distanceFromDestinationMeters)) {
          const distEl = document.createElement('p');
          distEl.style.cssText = 'margin:8px 0 0 0;font-size:12px;color:#8c8c8c;';
          distEl.textContent = `~${poi.distanceFromDestinationMeters} m from your drop-off (straight line)`;
          box.appendChild(distEl);
        }

        const zoomBtn = document.createElement('button');
        zoomBtn.type = 'button';
        zoomBtn.textContent = 'Zoom map here';
        zoomBtn.style.cssText =
          'margin-top:12px;padding:8px 14px;width:100%;border-radius:8px;border:1px solid #fa541c;background:#fff7e6;color:#d4380d;font-weight:600;cursor:pointer;font-size:13px;';
        zoomBtn.addEventListener('click', () => {
          if (mapRef.current?.flyTo) {
            mapRef.current.flyTo({
              center: [lng, lat],
              zoom: 17,
              duration: 900,
              essential: true
            });
          }
        });
        box.appendChild(zoomBtn);

        const popup = new maplibregl.Popup({
          closeButton: true,
          closeOnClick: true,
          offset: [0, -12],
          className: 'grab-dining-popup-container',
          maxWidth: '340px'
        })
          .setLngLat([lng, lat])
          .setDOMContent(box);

        popup.on('open', () => {
          const el = popup.getElement();
          if (el) el.style.zIndex = '99998';
        });

        try {
          const marker = new maplibregl.Marker({ element: wrap, anchor: 'bottom' })
            .setLngLat([lng, lat])
            .setPopup(popup)
            .addTo(map);
          diningMarkersRef.current.push(marker);
        } catch (e) {
          console.warn('Could not add dining marker:', e?.message || e);
        }
      });
    };

    run(0);
    return () => {
      cancelled = true;
      clearDining();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pins refresh when dining list changes
  }, [destinationDiningPicks, showDiningMarkers]);

  // Highlight and bounce a specific marker
  const highlightMarker = (markerIndex) => {
    console.log(`🎯 Highlighting marker ${markerIndex}`);
    
    // Reset all markers to normal state
    markersRef.current.forEach((marker, idx) => {
      const markerElement = marker.getElement();
      if (markerElement) {
        markerElement.classList.remove('marker-selected', 'marker-bounce');
        markerElement.style.zIndex = '1';
        // Don't touch transform - let Mapbox handle positioning
      }
    });

    // Highlight the selected marker
    if (markersRef.current[markerIndex]) {
      const selectedMarker = markersRef.current[markerIndex];
      const markerElement = selectedMarker.getElement();
      
      if (markerElement) {
        // Add bounce and highlight classes - CSS will handle the animations
        markerElement.classList.add('marker-selected', 'marker-bounce');
        markerElement.style.zIndex = '1000';
        
        // Remove bounce animation after it completes but keep highlight
        setTimeout(() => {
          if (markerElement) {
            markerElement.classList.remove('marker-bounce');
          }
        }, 1200);
        
        // Reset highlight after 3 seconds
        setTimeout(() => {
          if (markerElement) {
            markerElement.classList.remove('marker-selected');
            markerElement.style.zIndex = '1';
          }
        }, 3000);
      }
    }
  };

  // Parse markdown-style bold text (**text**) to proper formatting
  const parseMarkdownText = (text) => {
    if (!text) return text;
    
    // Split by line breaks first to maintain formatting
    const lines = text.split('\n');
    
    return lines.map((line, lineIndex) => {
      const parts = line.split(/(\*\*.*?\*\*)/g);
      
      const parsedLine = parts.map((part, partIndex) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          // Remove ** and make bold
          const boldText = part.slice(2, -2);
          return <Text key={`${lineIndex}-${partIndex}`} strong style={{ fontWeight: 600 }}>{boldText}</Text>;
        }
        return part;
      });
      
      // Add line break after each line except the last one
      return (
        <span key={lineIndex}>
          {parsedLine}
          {lineIndex < lines.length - 1 && <br />}
        </span>
      );
    });
  };

  const renderRoutePlaybackOverlays = () => (
    <>
      {hasRouteOnMap && !routePlaybackActive && (
        <Tooltip title="Driving-style preview: blue arrow follows your route (tilted map, close zoom). Pause, scrub the bar, or let it finish in street-level view on the last 100 m.">
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={startRoutePlayback}
            className="route-playback-enter-btn"
            size={isMobile ? 'middle' : 'large'}
          >
            Play route
          </Button>
        </Tooltip>
      )}
      {routePlaybackActive && (
        <div className="route-playback-panel" role="status" aria-live="polite">
          <Text strong className="route-playback-panel__title">
            Route preview
          </Text>
          <Text type="secondary" className="route-playback-panel__hint">
            Driving-style follow (tilted map, closer zoom for 3D buildings) · street-level last 100 m — drag slider to scrub
          </Text>
          <Slider
            min={0}
            max={100}
            step={0.25}
            value={routePlaybackProgressPct}
            tooltip={{ formatter: (v) => `${Number(v).toFixed(0)}%` }}
            onChange={(v) => seekRoutePlaybackToPct(v)}
            className="route-playback-panel__slider"
          />
          <Space size="small" wrap className="route-playback-panel__actions">
            <Button
              type="primary"
              size="small"
              icon={routePlaybackPaused ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
              onClick={toggleRoutePlaybackPause}
            >
              {routePlaybackPaused ? 'Resume' : 'Pause'}
            </Button>
            <Button
              size="small"
              danger
              icon={<StopOutlined />}
              onClick={() => stopRoutePlaybackAnim(false)}
            >
              Stop
            </Button>
          </Space>
        </div>
      )}
    </>
  );

  // Render sidebar content
  const renderSidebarContent = () => (
    <div className="sidebar-content">
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        {/* Search Card */}
        <Card title="🔍 Search Places" className="search-card">
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
              <Search
                placeholder="Search restaurants, malls, hotels..."
                size={isMobile ? "middle" : "large"}
                value={searchValue}
                onChange={(e) => setSearchValue(e.target.value)}
                onSearch={searchPOIs}
                loading={loading}
                enterButton={<SearchOutlined />}
                className="search-input"
                style={{ flex: 1 }}
              />
              {(searchResults.length > 0 || searchValue) && (
                <Button
                  onClick={() => {
                    setSearchValue('');
                    setSearchResults([]);
                    setLastPoiSearchQuery('');
                    setSelectedPOIIndex(null);
                    clearPOIMarkers();
                    console.log('🧹 Search cleared by user');
                  }}
                  title="Clear search"
                  size={isMobile ? "middle" : "large"}
                  icon={<span style={{ fontSize: '14px' }}>✕</span>}
                  style={{ 
                    minWidth: 'auto',
                    padding: '0 8px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                />
              )}
            </div>
            
            {/* Quick Search Buttons - GrabMap MCP Categories */}
            <div className={`quick-search-buttons ${isMobile ? 'mobile-quick-search' : ''}`}>
              <Button
                size={isMobile ? 'middle' : 'small'}
                onClick={() => quickSearch('hotels')}
                icon={<Hotel className="quick-search-cat-icon" size={16} strokeWidth={2.25} aria-hidden />}
              >
                Hotels
              </Button>
              <Button
                size={isMobile ? 'middle' : 'small'}
                onClick={() => quickSearch('restaurants')}
                icon={<UtensilsCrossed className="quick-search-cat-icon" size={16} strokeWidth={2.25} aria-hidden />}
              >
                Restaurants
              </Button>
              <Button
                size={isMobile ? 'middle' : 'small'}
                onClick={() => quickSearch('bars')}
                icon={<Wine className="quick-search-cat-icon" size={16} strokeWidth={2.25} aria-hidden />}
              >
                Bars
              </Button>
              <Button
                size={isMobile ? 'middle' : 'small'}
                onClick={() => quickSearch('shops')}
                icon={<ShoppingCart className="quick-search-cat-icon" size={16} strokeWidth={2.25} aria-hidden />}
              >
                Shops
              </Button>
              <Button
                size={isMobile ? 'middle' : 'small'}
                onClick={() => quickSearch('banks')}
                icon={<Landmark className="quick-search-cat-icon" size={16} strokeWidth={2.25} aria-hidden />}
              >
                Banks
              </Button>
              <Button
                size={isMobile ? 'middle' : 'small'}
                onClick={() => quickSearch('hospitals')}
                icon={<Hospital className="quick-search-cat-icon" size={16} strokeWidth={2.25} aria-hidden />}
              >
                Hospitals
              </Button>
              <Button
                size={isMobile ? 'middle' : 'small'}
                onClick={() => quickSearch('sports')}
                icon={<Dumbbell className="quick-search-cat-icon" size={16} strokeWidth={2.25} aria-hidden />}
              >
                Sports
              </Button>
              <Button
                size={isMobile ? 'middle' : 'small'}
                onClick={() => quickSearch('commercial')}
                icon={<Building2 className="quick-search-cat-icon" size={16} strokeWidth={2.25} aria-hidden />}
              >
                Commercial
              </Button>
            </div>
          </Space>
        </Card>

                {/* Route Planning Section */}
        <Card title="🗺️ Route Planning" className="route-planning-card">
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {/* Route Points with A, B, C labeling */}
            <div className="route-points-list">
              {/* Create combined list of all points */}
              {(() => {
                const allPoints = [];
                if (startPoint) allPoints.push({ ...startPoint, type: 'start' });
                waypoints.forEach(wp => allPoints.push({ ...wp, type: 'waypoint' }));
                if (endPoint) allPoints.push({ ...endPoint, type: 'end' });
                
                return allPoints.map((point, index) => {
                  const letter = String.fromCharCode(65 + index); // A, B, C, D...
                  const isLast = index === allPoints.length - 1;
                  
                  return (
                    <div key={`${point.type}-${point.id || index}`} className="route-point" style={{ 
                      background: '#f9f9f9', 
                      border: '1px solid #e0e0e0', 
                      borderRadius: '8px', 
                      padding: '12px',
                      marginBottom: '8px',
                      position: 'relative'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                        {/* Letter Badge */}
                        <div style={{
                          width: '32px',
                          height: '32px',
                          borderRadius: '50%',
                          background: point.type === 'start' ? '#52c41a' : point.type === 'end' ? '#f5222d' : '#1890ff',
                          color: 'white',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontWeight: 'bold',
                          fontSize: '16px',
                          flexShrink: 0
                        }}>
                          {letter}
                        </div>
                        
                        {/* Point Details */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <Text strong style={{ 
                            color: point.type === 'start' ? '#52c41a' : point.type === 'end' ? '#f5222d' : '#1890ff',
                            fontSize: '14px'
                          }}>
                            {point.type === 'start' ? 'Start Point' : point.type === 'end' ? 'Destination' : `Stop ${index}`}
                          </Text>
                          <br />
                          <Text style={{ fontSize: '14px', fontWeight: '500' }}>{point.name}</Text>
                          <br />
                          <Text style={{ fontSize: '12px', color: '#666' }}>
                            {point.address || 'Address not available'}
                          </Text>
                        </div>
                        
                        {/* Controls */}
                        {point.type === 'waypoint' && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                            {index > 1 && (
                              <Button 
                                size="small" 
                                type="text"
                                onClick={() => moveWaypoint(index - 1, index - 2)}
                                style={{ minWidth: 'auto', padding: '2px 4px', height: '20px' }}
                                title="Move up"
                              >
                                ↑
                              </Button>
                            )}
                            {!isLast && (
                              <Button 
                                size="small" 
                                type="text"
                                onClick={() => moveWaypoint(index - 1, index)}
                                style={{ minWidth: 'auto', padding: '2px 4px', height: '20px' }}
                                title="Move down"
                              >
                                ↓
                              </Button>
                            )}
                            <Button 
                              size="small" 
                              type="text" 
                              danger
                              onClick={() => removeWaypoint(index - 1)}
                              style={{ minWidth: 'auto', padding: '2px 4px', height: '20px' }}
                              title="Remove point"
                            >
                              ✕
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>

            {endPoint && (
              <div
                className="map-overlay-controls"
                style={{
                  marginTop: 6,
                  padding: '10px 12px 12px',
                  background: 'linear-gradient(180deg, #fffdfb 0%, #fff4e6 100%)',
                  border: '1px solid #ffe7ba',
                  borderRadius: 8
                }}
              >
                <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8, letterSpacing: '0.02em' }}>
                  Map overlays stay off by default—enable pins when you want them (fewer markers, snappier map).
                </Text>
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  <Checkbox
                    checked={showLandmarkMarkers}
                    disabled={!routeLandmarks?.length}
                    onChange={(e) => setShowLandmarkMarkers(e.target.checked)}
                  >
                    <Text style={{ fontSize: 13 }}>
                      Show landmarks &amp; attractions on map
                      {routeLandmarks?.length > 0 ? (
                        <Text type="secondary" style={{ fontSize: 12 }}>{' '}({routeLandmarks.length})</Text>
                      ) : null}
                    </Text>
                  </Checkbox>
                  <Checkbox checked={showDiningMarkers} onChange={(e) => setShowDiningMarkers(e.target.checked)}>
                    <Text style={{ fontSize: 13 }}>Show famous dining spots near destination</Text>
                  </Checkbox>
                </Space>

                <Collapse
                  bordered={false}
                  className="destination-dining-collapse"
                  style={{ marginTop: 10, background: 'transparent' }}
                  expandIconPosition="end"
                  activeKey={diningPanelExpanded ? ['dining'] : []}
                  onChange={(key) => {
                    const keys = Array.isArray(key) ? key : key ? [key] : [];
                    setDiningPanelExpanded(keys.includes('dining'));
                  }}
                  items={[
                    {
                      key: 'dining',
                      label: (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          <UtensilsCrossed size={18} strokeWidth={2.25} color="#d4380d" aria-hidden />
                          <Text strong style={{ color: '#d4380d', fontSize: 14 }}>
                            Dining near destination
                          </Text>
                          {!diningPanelExpanded && destinationDiningPicks.length > 0 && (
                            <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                              · {destinationDiningPicks.length} pick{destinationDiningPicks.length === 1 ? '' : 's'}
                            </Text>
                          )}
                        </span>
                      ),
                      children: (
                        <div
                          className="destination-dining-sidebar"
                          style={{
                            padding: '4px 0 0',
                            background: 'transparent'
                          }}
                        >
                          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 10 }}>
                            Grab-ranked near <Text strong>{endPoint.name || 'destination'}</Text>: prefer within{' '}
                            {DESTINATION_DINING_SEARCH_RADIUS_METERS} m, up to {DESTINATION_DINING_DISPLAY_MAX_METERS} m
                            straight-line if the closest POIs sit just outside — same pins as on the map when the dining
                            overlay is checked.
                          </Text>
                          {destinationDiningLoading && (
                            <Space align="center" size="small">
                              <Spin size="small" />
                              <Text type="secondary">Searching restaurants…</Text>
                            </Space>
                          )}
                          {!destinationDiningLoading && destinationDiningPicks.length === 0 && (
                            <Alert
                              type="info"
                              showIcon
                              message="No ranked dining for this destination pin"
                              description={`Grab did not return POIs we could use within about ${DESTINATION_DINING_DISPLAY_MAX_METERS} m (straight line), or the POI request failed — check DevTools → Network for poi/v1/search. Dense areas like One-North usually have options: use the Restaurants quick search (centred on B) for more hits, or nudge the pin if the lobby geocode is offset.`}
                              style={{ fontSize: 12 }}
                            />
                          )}
                          {!destinationDiningLoading && destinationDiningPicks.length > 0 && (
                            <List
                              size="small"
                              dataSource={destinationDiningPicks}
                              renderItem={(poi) => (
                                <List.Item style={{ padding: '8px 0', borderColor: '#fff1b8' }}>
                                  <List.Item.Meta
                                    title={
                                      <Text strong style={{ fontSize: 13 }}>
                                        #{poi.diningRank} {poi.name}
                                      </Text>
                                    }
                                    description={
                                      <div>
                                        <Text type="secondary" style={{ fontSize: 12 }}>
                                          {poi.address || 'Address not available'}
                                        </Text>
                                        {poi.distanceFromDestinationMeters != null &&
                                          Number.isFinite(poi.distanceFromDestinationMeters) && (
                                          <div>
                                            <Text type="secondary" style={{ fontSize: 11 }}>
                                              ~{poi.distanceFromDestinationMeters} m from destination pin
                                            </Text>
                                          </div>
                                        )}
                                      </div>
                                    }
                                  />
                                </List.Item>
                              )}
                            />
                          )}
                        </div>
                      )
                    }
                  ]}
                />
              </div>
            )}

            {/* Add Point Button */}
            <Button
              type="dashed"
              onClick={() => setShowAddPointModal(true)}
              style={{ 
                width: '100%', 
                height: '48px',
                border: '2px dashed #d9d9d9',
                color: '#666'
              }}
              size={isMobile ? "large" : "middle"}
            >
              + Add Another Point
            </Button>

            {/* Route Actions */}
            {startPoint && endPoint && (
              <Button
                type="primary"
                loading={routeLoading}
                onClick={planRoute}
                style={{ width: '100%' }}
                icon={<CarOutlined />}
                size={isMobile ? "large" : "middle"}
              >
                {routeLoading ? 'Planning Route...' : waypoints.length > 0 ? `Plan ${waypoints.length + 2}-Point Route` : 'Plan Route'}
              </Button>
            )}

            {/* Clear Route Button */}
            {(startPoint || endPoint || waypoints.length > 0) && (
              <Button
                onClick={() => {
                  setStartPoint(null);
                  setEndPoint(null);
                  setWaypoints([]);
                  setRouteInfo(null);
                  setRouteLandmarks([]);
                  clearAllMarkers();
                }}
                style={{ width: '100%' }}
                size={isMobile ? "large" : "middle"}
              >
                Clear All Points
              </Button>
            )}
          </Space>
        </Card>

        {/* Route Information */}
        {routeInfo && (
          <Card title={`🗺️ Journey Details${waypoints.length > 0 ? ` (${waypoints.length + 2} stops)` : ''}`} className="route-card">
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Row gutter={[16, 16]}>
                <Col span={12}>
                  <div className="info-item">
                    <Text strong>Distance:</Text>
                    <br />
                    <Text className="info-value">{routeInfo.distance} km</Text>
                  </div>
                </Col>
                <Col span={12}>
                  <div className="info-item">
                    <Text strong>Duration:</Text>
                    <br />
                    <Text className="info-value">{routeInfo.duration} min</Text>
                  </div>
                </Col>
              </Row>
              
              <div className="weather-info">
                <Text strong><SunOutlined /> Weather:</Text>
                <br />
                {weatherLoading ? (
                  <Text style={{ color: '#666' }}>
                    Loading weather data...
                  </Text>
                ) : (
                  <Text>
                    {routeInfo.weather?.condition || 'Clear'}, {routeInfo.weather?.temperature || 28}°C
                    {routeInfo.weather?.description && (
                      <span style={{ color: '#666', fontSize: '12px', marginLeft: '8px' }}>
                        ({routeInfo.weather.description})
                      </span>
                    )}
                  </Text>
                )}
              </div>
              
              <div className="route-description">
                <div style={{ lineHeight: '1.6', fontSize: isMobile ? '13px' : '14px' }}>
                  {parseMarkdownText(routeInfo.description)}
                </div>
              </div>
            </Space>
          </Card>
        )}

        {/* Search Results */}
        {searchResults.length > 0 && (
          <Card title={`📍 Search Results (${searchResults.length} found)`} className="results-card">
            <List
              itemLayout="horizontal"
              dataSource={searchResults}
              renderItem={(item, index) => (
                <List.Item 
                  className={`poi-item enhanced-poi-item ${isPopularPOI(item.popularity) ? 'popular-poi' : ''} ${selectedPOIIndex === index ? 'poi-selected' : ''}`}
                  onClick={() => {
                    handlePOIClick(item, index);
                    if (isMobile) {
                      setActiveView('map');
                      setShowMobileSidebar(false);
                    }
                  }}
                  data-poi-index={index}
                  style={{ 
                    position: 'relative',
                    background: isPopularPOI(item.popularity) 
                      ? 'linear-gradient(145deg, #fffbf0, #ffffff)' 
                      : 'white',
                    cursor: 'pointer',
                    padding: isMobile ? '12px 16px' : '8px 12px'
                  }}
                >
                  {/* Star indicator for popular POIs */}
                  {isPopularPOI(item.popularity) && (
                    <div className="star-indicator" style={{
                      position: 'absolute',
                      top: isMobile ? '12px' : '8px',
                      right: isMobile ? '12px' : '8px',
                      zIndex: 10,
                      background: 'linear-gradient(135deg, #faad14, #ffc53d)',
                      borderRadius: '50%',
                      width: isMobile ? '28px' : '26px',
                      height: isMobile ? '28px' : '26px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      boxShadow: '0 2px 8px rgba(250, 173, 20, 0.4)',
                      border: '2px solid white'
                    }}>
                      <StarFilled style={{ color: 'white', fontSize: isMobile ? '14px' : '13px' }} />
                    </div>
                  )}
                  
                  <List.Item.Meta
                    avatar={
                      <Avatar 
                        size={isMobile ? "large" : "default"}
                        style={{ 
                          backgroundColor: '#ffffff', 
                          border: '2px solid #00b14f',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}
                      >
                        <PoiKindLucideIcon
                          kind={resolvePoiMarkerIconType(
                            item.businessType,
                            item.category,
                            lastPoiSearchQuery
                          )}
                          size={isMobile ? 20 : 18}
                          className="quick-search-cat-icon poi-result-avatar-icon"
                        />
                      </Avatar>
                    }
                    title={
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <Text strong style={{ fontSize: isMobile ? '15px' : '14px' }}>{item.name}</Text>
                        {selectedPOIIndex === index && (
                          <span style={{
                            background: '#00b14f',
                            color: 'white',
                            fontSize: isMobile ? '11px' : '10px',
                            padding: isMobile ? '3px 8px' : '2px 6px',
                            borderRadius: '10px',
                            fontWeight: '600'
                          }}>
                            SELECTED
                          </span>
                        )}
                      </div>
                    }
                    description={
                      <Space direction="vertical" size="small" style={{ width: '100%' }}>
                        <Text style={{ fontSize: isMobile ? '13px' : '12px' }}><EnvironmentFilled /> {item.address}</Text>
                        {item.phone && <Text style={{ fontSize: isMobile ? '13px' : '12px' }}><PhoneFilled /> {item.phone}</Text>}
                        
                        {/* Popularity Information */}
                        {item.popularity && formatPopularityText(item.popularity) && (
                          <Text 
                            className={isPopularPOI(item.popularity) ? 'popularity-text popular' : 'popularity-text'}
                            style={{ 
                              color: isPopularPOI(item.popularity) ? '#faad14' : '#666', 
                              fontSize: isMobile ? '12px' : '11px',
                              fontWeight: isPopularPOI(item.popularity) ? '600' : 'normal',
                              lineHeight: '1.3'
                            }}
                          >
                            📊 {formatPopularityText(item.popularity)}
                            {isPopularPOI(item.popularity) && ' ⭐ Popular'}
                          </Text>
                        )}
                        
                        {item.techFamilies && item.techFamilies.length > 0 && (
                          <Text style={{ color: '#00b14f', fontSize: isMobile ? '13px' : '12px' }}>
                            🚗 {item.techFamilies.map(tf => tf.replace('grab', 'Grab')).join(', ')}
                          </Text>
                        )}
                      </Space>
                    }
                  />
                </List.Item>
              )}
            />
          </Card>
        )}
      </Space>
    </div>
  );

  return (
    <Layout className="map-view-layout" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header className={`app-header ${isMobile ? 'mobile-header' : 'map-header-desktop'}`}>
        <div className="header-content">
          <div className="header-toolbar-left">
            <Button
              icon={<ArrowLeftOutlined />}
              onClick={() => {
                navigate('/', {
                  state: {
                    pickupLocation,
                    dropoffLocation,
                    routeData,
                    weatherData,
                    selectedCountry
                  }
                });
              }}
              className="back-button"
              size={isMobile ? 'middle' : 'default'}
            >
              {isMobile ? '' : 'Back to Planning'}
            </Button>
          </div>

          <div className="header-toolbar-center">
            <div className="app-title">
              <div className="brand-title-container">
                <div className="app-brand-icon">
                  <Image
                    src={publicAssetUrl('/icon.png')}
                    alt="JourneyGenie"
                    preview={false}
                    className="brand-icon-image"
                  />
                </div>
                <div className="app-title-text">
                  <Title level={isMobile ? 3 : 2} style={{ margin: 0, color: 'white' }}>
                    JourneyGenie
                  </Title>
                </div>
              </div>
            </div>
          </div>

          <div className="header-toolbar-right">
            {isMobile ? (
              <div className="mobile-view-controls">
                <Button
                  icon={<SearchOutlined />}
                  onClick={() => {
                    setActiveView('sidebar');
                    setShowMobileSidebar(true);
                  }}
                  size="middle"
                  className="mobile-view-btn"
                />
              </div>
            ) : null}
          </div>
        </div>
      </Header>

      <Content className="app-content">
        {isMobile ? (
          <>
            {/* Mobile: Full-screen content with drawer for sidebar */}
            <div className="mobile-map-container" style={{ height: '100%', position: 'relative' }}>
              <div className="map-wrapper map-wrapper--route-playback-host" style={{ height: '100%', position: 'relative' }}>
                <div
                  id="journeygenie-grab-map"
                  style={{ width: '100%', height: '100%' }}
                />
                {renderRoutePlaybackOverlays()}
              </div>
            </div>

            {/* Mobile Sidebar Drawer */}
            <Drawer
              title="Search & Planning"
              placement="bottom"
              height="72%"
              open={showMobileSidebar}
              onClose={() => {
                setShowMobileSidebar(false);
                setActiveView('map');
              }}
              rootClassName="mobile-sidebar-drawer"
              styles={{
                wrapper: {
                  borderRadius: '28px 28px 0 0',
                  overflow: 'hidden',
                  left: 12,
                  right: 12,
                  width: 'auto',
                  boxShadow:
                    '0 -20px 56px rgba(0, 0, 0, 0.14), 0 -8px 24px rgba(0, 0, 0, 0.08), 0 -1px 0 rgba(255, 255, 255, 0.5) inset'
                },
                content: {
                  borderRadius: '28px 28px 0 0',
                  overflow: 'hidden',
                  background: '#f0f2f5'
                },
                body: { background: 'transparent' }
              }}
            >
              {renderSidebarContent()}
            </Drawer>
          </>
        ) : (
          /* Desktop: Side-by-side layout */
          <Row className="main-container">
                         <Col xs={0} sm={0} md={10} lg={8} xl={7} className="sidebar">
               {renderSidebarContent()}
             </Col>
             
                           <Col xs={0} sm={0} md={14} lg={16} xl={17} className="map-container">
                <div className="map-wrapper map-wrapper--route-playback-host" style={{ position: 'relative' }}>
                  <div
                    id="journeygenie-grab-map"
                    style={{ width: '100%', height: '100%' }}
                  />
                  {renderRoutePlaybackOverlays()}
                </div>
              </Col>
            </Row>
          )}
        </Content>

        {/* Add Point Instructions Modal */}
        <Modal
          title="How to Add Route Points"
          open={showAddPointModal}
          onOk={() => setShowAddPointModal(false)}
          onCancel={() => setShowAddPointModal(false)}
          footer={[
            <Button key="ok" type="primary" onClick={() => setShowAddPointModal(false)}>
              Got it!
            </Button>
          ]}
          width={isMobile ? '90%' : 480}
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <div style={{ textAlign: 'center', marginBottom: '16px' }}>
              <div style={{ marginBottom: '12px' }}>
                <Image
                  src={publicAssetUrl('/icon.png')}
                  alt="JourneyGenie"
                  preview={false}
                  style={{ 
                    width: '64px', 
                    height: '64px',
                    borderRadius: '16px',
                    boxShadow: '0 4px 16px rgba(0, 177, 79, 0.2)'
                  }}
                />
              </div>
              <Text style={{ fontSize: '16px', color: '#666' }}>
                Follow these simple steps to add points to your route:
              </Text>
            </div>

            <div style={{ background: '#f9f9f9', borderRadius: '8px', padding: '16px' }}>
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                  <div style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    background: '#1890ff',
                    color: 'white',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 'bold',
                    fontSize: '16px',
                    flexShrink: 0
                  }}>
                    1
                  </div>
                  <div>
                    <Text strong style={{ fontSize: '14px' }}>Search for places</Text>
                    <br />
                    <Text style={{ fontSize: '13px', color: '#666' }}>
                      Use the search bar above to find restaurants, hotels, attractions, or any location
                    </Text>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                  <div style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    background: '#52c41a',
                    color: 'white',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 'bold',
                    fontSize: '16px',
                    flexShrink: 0
                  }}>
                    2
                  </div>
                  <div>
                    <Text strong style={{ fontSize: '14px' }}>Click on a map marker</Text>
                    <br />
                    <Text style={{ fontSize: '13px', color: '#666' }}>
                      Click any green marker on the map to open the location details popup
                    </Text>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                  <div style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    background: '#f5222d',
                    color: 'white',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 'bold',
                    fontSize: '16px',
                    flexShrink: 0
                  }}>
                    3
                  </div>
                  <div>
                    <Text strong style={{ fontSize: '14px' }}>Select "Add as Waypoint"</Text>
                    <br />
                    <Text style={{ fontSize: '13px', color: '#666' }}>
                      In the popup, click the blue "➕ Add as Waypoint" button to add it to your route
                    </Text>
                  </div>
                </div>
              </Space>
            </div>

            <Alert
              message="Pro Tip"
              description="You can reorder waypoints using the ↑↓ arrows and remove them with the ✕ button in the route planning section."
              type="info"
              showIcon
              style={{ marginTop: '8px' }}
            />
          </Space>
        </Modal>
      </Layout>
    );
  }

export default MapView;