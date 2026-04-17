import React, { useState, useEffect } from 'react';
import { Layout, Typography, Input, Button, Card, Space, Row, Col, Avatar, Spin, Select, List } from 'antd';
import {
  SearchOutlined,
  EnvironmentFilled,
  CarOutlined,
  SunOutlined,
  RightCircleFilled,
  ThunderboltOutlined,
  PushpinOutlined,
  HeatMapOutlined,
  CompassOutlined,
} from '@ant-design/icons';
import { useNavigate, useLocation } from 'react-router-dom';
import axios from 'axios';
import { getGrabNavigationRoute } from '../services/grabNavigationApi';
import { extractPlacePhotoUrl, searchGrabPois, searchGrabNearbyPlaces } from '../services/grabPoiSearchApi';
import { getRouteTrafficJourneyInsights } from '../services/grabTrafficApi';
import {
  DESTINATION_DINING_DISPLAY_MAX_METERS,
  DESTINATION_DINING_SEARCH_RADIUS_METERS,
  fetchTopRestaurantsNearDropoff,
  getLocalTravelTip
} from '../utils/travelTips';
import {
  filterLandmarksNearRoute,
  sortLandmarksByPolylineDistance
} from '../utils/landmarkRouteProximity';
import { locationToLngLatArray } from '../utils/routeCoordinates';
import {
  isWeatherFetchConfigured,
  buildOpenWeatherClientUrl,
  USE_API_PROXY
} from '../config/apiProxy';
import './LandingPage.css';

const { Content } = Layout;
const { Title, Text, Paragraph } = Typography;

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

function formatTrafficIncidentType(type) {
  if (!type) return 'Incident';
  return String(type)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatRouteTrafficSection({ trafficSummary, incidents }) {
  let block = '\n\n🚦 **Live traffic & route alerts**\n';
  if (trafficSummary) {
    block += `• **Road conditions:** ${trafficSummary}\n`;
  } else {
    block +=
      '• **Road conditions:** Live congestion data was not available for this preview—leave a small buffer just in case.\n';
  }
  if (incidents.length > 0) {
    block += `• **Up to ${incidents.length} notable incident${incidents.length > 1 ? 's' : ''} near your path:**\n`;
    incidents.forEach((inc) => {
      const label = formatTrafficIncidentType(inc.type);
      const sev = inc.severity ? ` (${String(inc.severity)})` : '';
      const desc = (inc.description || 'No description provided').replace(/\s+/g, ' ').trim();
      let near = '';
      if (inc.distanceFromRouteMeters != null && inc.distanceFromRouteMeters < 2000) {
        const m = Math.round(inc.distanceFromRouteMeters / 25) * 25;
        near = ` — ~${m}m from the driven line`;
      }
      block += `  • **${label}**${sev}: ${desc}${near}\n`;
    });
  } else {
    block +=
      '• **Incidents:** No major incidents stood out in the top scan for your corridor—routing should be straightforward, barring sudden changes.\n';
  }
  return block;
}

function toLandmarkPayload(lm) {
  const lat = lm.location?.latitude ?? lm.location?.lat;
  const lng = lm.location?.longitude ?? lm.location?.lng;
  return {
    id: lm.id || lm.poi_id,
    name: lm.name,
    address: lm.address || lm.formatted_address || lm.formattedAddress || 'No address available',
    location: lat != null && lng != null ? { latitude: lat, longitude: lng } : null,
    businessType: lm.businessType || lm.business_type,
    category: lm.category,
    photoUrl: lm.photoUrl || extractPlacePhotoUrl(lm),
    side: lm.side,
    distance: lm.distance
  };
}

const LandingPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  
  // Initialize state with data from navigation (when returning from MapView) or defaults
  const previousData = location.state;
  
  // State for location selection
  const [pickupLocation, setPickupLocation] = useState(previousData?.pickupLocation || null);
  const [dropoffLocation, setDropoffLocation] = useState(previousData?.dropoffLocation || null);
  const [pickupQuery, setPickupQuery] = useState(previousData?.pickupLocation?.name || '');
  const [dropoffQuery, setDropoffQuery] = useState(previousData?.dropoffLocation?.name || '');
  const [pickupSuggestions, setPickupSuggestions] = useState([]);
  const [dropoffSuggestions, setDropoffSuggestions] = useState([]);
  
  // Add country selection state
  const [selectedCountry, setSelectedCountry] = useState(previousData?.selectedCountry || 'singapore');
  
  // State for route planning
  const [routeData, setRouteData] = useState(previousData?.routeData || null);
  const [weatherData, setWeatherData] = useState(previousData?.weatherData || null);
  const [loading, setLoading] = useState(false);
  const [planningRoute, setPlanningRoute] = useState(false);
  const [weatherLoading, setWeatherLoading] = useState(false);
  
  // State for user location
  const [userLocation, setUserLocation] = useState(null);
  const [, setUserWeather] = useState(null);
  const [locationLoading, setLocationLoading] = useState(true);
  const [, setLocationError] = useState(null);
  const [, setUserWeatherLoading] = useState(false);

  const OPENWEATHER_API_KEY = process.env.REACT_APP_OPENWEATHER_API_KEY;
  const DEMO_MODE = false; // Using real weather data

  if (!isWeatherFetchConfigured()) {
    console.warn('⚠️ OpenWeather API key not configured. Weather features will use fallback data.');
  }

  // Get user's current location (non-blocking for search functionality)
  function getUserLocation() {
    setLocationLoading(true);
    setLocationError(null);

    if (!navigator.geolocation) {
      setLocationError('Geolocation is not supported by this browser');
      setLocationLoading(false);
      console.log('🌏 No geolocation support - using tourist mode (Singapore)');
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        const location = { latitude, longitude };
        
        console.log('📍 User location obtained:', location);
        setUserLocation(location);
        setLocationLoading(false);
        
        // Check if user is in Southeast Asia
        if (isInSoutheastAsia(latitude, longitude)) {
          console.log('✅ User is in Southeast Asia - location-based search enabled');
          
          // Get weather for user's current location
          setUserWeatherLoading(true);
          try {
            const weather = await getWeatherData([longitude, latitude]);
            setUserWeather(weather);
            console.log('🌤️ User weather data:', weather);
          } catch (error) {
            console.error('Error fetching user weather:', error);
          } finally {
            setUserWeatherLoading(false);
          }
        } else {
          console.log('🌏 User is outside Southeast Asia - using tourist mode (Singapore-based search)');
          
          // Get weather for Singapore (tourist planning destination)
          setUserWeatherLoading(true);
          try {
            const weather = await getWeatherData([103.8198, 1.3521]); // Singapore
            setUserWeather(weather);
            console.log('🌤️ Singapore weather data for tourist planning:', weather);
          } catch (error) {
            console.error('Error fetching Singapore weather:', error);
          } finally {
            setUserWeatherLoading(false);
          }
        }
      },
      (error) => {
        console.error('Error getting user location:', error);
        let errorMessage = 'Unable to retrieve your location';
        
        switch (error.code) {
          case error.PERMISSION_DENIED:
            errorMessage = 'Location access denied - using Singapore for search';
            console.log('🌏 Location denied - enabling tourist mode (Singapore)');
            break;
          case error.POSITION_UNAVAILABLE:
            errorMessage = 'Location unavailable - using Singapore for search';
            console.log('🌏 Location unavailable - enabling tourist mode (Singapore)');
            break;
          case error.TIMEOUT:
            errorMessage = 'Location timeout - using Singapore for search';
            console.log('🌏 Location timeout - enabling tourist mode (Singapore)');
            break;
          default:
            errorMessage = 'Location error - using Singapore for search';
            console.log('🌏 Location error - enabling tourist mode (Singapore)');
            break;
        }
        
        setLocationError(errorMessage);
        setLocationLoading(false);
        
        // Still get Singapore weather for tourists
        setUserWeatherLoading(true);
        getWeatherData([103.8198, 1.3521]).then(weather => {
          setUserWeather(weather);
          console.log('🌤️ Singapore weather data for tourists:', weather);
        }).catch(error => {
          console.error('Error fetching Singapore weather:', error);
        }).finally(() => {
          setUserWeatherLoading(false);
        });
      },
      {
        enableHighAccuracy: true,
        timeout: 8000, // Reduced timeout to not block UX
        maximumAge: 300000 // 5 minutes
      }
    );
  }

  // Use effect to get user location on component mount (non-blocking)
  useEffect(() => {
    getUserLocation();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Check if coordinates are in Southeast Asia region
  function isInSoutheastAsia(lat, lng) {
    // Southeast Asia approximate bounds
    // North: 28°N (Myanmar/China border)
    // South: 11°S (Indonesia)  
    // West: 92°E (Myanmar/India border)
    // East: 141°E (Papua New Guinea)
    return lat >= -11 && lat <= 28 && lng >= 92 && lng <= 141;
  }

  // Southeast Asian countries with their coordinates for POI search
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

  // Get search location based on selected country or user location
  function getSearchLocation() {
    // If user selected a specific country, use that country's coordinates
    if (selectedCountry && SOUTHEAST_ASIAN_COUNTRIES[selectedCountry]) {
      const countryData = SOUTHEAST_ASIAN_COUNTRIES[selectedCountry];
      console.log(`🌍 Using ${countryData.name} coordinates for search:`, countryData.coordinates);
      return countryData.coordinates;
    }

    // Fallback to original logic if no country selected
    if (userLocation && isInSoutheastAsia(userLocation.latitude, userLocation.longitude)) {
      // User is in Southeast Asia - use their location
      console.log('📍 Using user location (in Southeast Asia):', userLocation);
      return `${userLocation.latitude},${userLocation.longitude}`;
    } else {
      // User is outside Southeast Asia or location unavailable - use Singapore for tourists
      console.log('🌏 Using Singapore default location (tourist mode or outside SEA)');
      return '1.3521,103.8198'; // Singapore default for tourists
    }
  }

  // Search locations — Grab Maps POI v1 search (same as MapView; one API key)
  async function searchLocations(query, setSuggestions) {
    if (!query.trim() || query.trim().length < 3) {
      setSuggestions([]);
      return;
    }

    console.log('🔍 POI search (Grab maps/poi/v1/search):', query);
    setLoading(true);

    try {
      const searchLocation = getSearchLocation();
      const [latStr, lngStr] = String(searchLocation).split(',').map((s) => s.trim());
      const lat = parseFloat(latStr);
      const lng = parseFloat(lngStr);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        setSuggestions([]);
        return;
      }

      const list = await searchGrabPois({
        keyword: query.trim(),
        lat,
        lng,
        country: selectedCountry,
        limit: 20,
        userLocation:
          userLocation && userLocation.latitude != null && userLocation.longitude != null
            ? { latitude: userLocation.latitude, longitude: userLocation.longitude }
            : null,
        calculateDistance
      });

      const transformedPOIs = list.map((poi) => ({
        ...poi,
        coordinates: [poi.location.longitude, poi.location.latitude]
      }));

      setSuggestions(transformedPOIs);
    } catch (error) {
      console.error('POI search failed:', error);
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  }

  // Calculate straight-line distance using Haversine formula (for MCP POI data)
  function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in kilometers
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c; // Distance in kilometers
  }

  // Get weather data with secure API handling
  async function getWeatherData(coordinates) {
    // Check if we have API key configured
    if (!isWeatherFetchConfigured()) {
      console.warn('🌤️ Using fallback weather data - API key not configured');
      // Return fallback weather data when API key is not available
      const fallbackWeather = [
        { temperature: 28, condition: 'Clear', description: 'clear sky', humidity: 70, icon: '01d' },
        { temperature: 32, condition: 'Sunny', description: 'sunny', humidity: 65, icon: '01d' },
        { temperature: 26, condition: 'Cloudy', description: 'partly cloudy', humidity: 80, icon: '02d' },
        { temperature: 24, condition: 'Rain', description: 'light rain', humidity: 85, icon: '10d' }
      ];
      return fallbackWeather[Math.floor(Math.random() * fallbackWeather.length)];
    }

    if (DEMO_MODE) {
      // Return mock weather data for demo
      const mockWeather = [
        { temperature: 28, condition: 'Clear', description: 'clear sky', humidity: 70, icon: '01d' },
        { temperature: 32, condition: 'Sunny', description: 'sunny', humidity: 65, icon: '01d' },
        { temperature: 26, condition: 'Cloudy', description: 'partly cloudy', humidity: 80, icon: '02d' },
        { temperature: 24, condition: 'Rain', description: 'light rain', humidity: 85, icon: '10d' }
      ];
      return mockWeather[Math.floor(Math.random() * mockWeather.length)];
    }

    try {
      // Using real OpenWeather API with secure key handling
      const apiUrl = USE_API_PROXY
        ? buildOpenWeatherClientUrl(coordinates[1], coordinates[0])
        : `https://api.openweathermap.org/data/2.5/weather?lat=${coordinates[1]}&lon=${coordinates[0]}&appid=${OPENWEATHER_API_KEY}&units=metric`;
      console.log('🌤️ Fetching weather data from OpenWeather API');
      
      const response = await axios.get(apiUrl);
      
      const weatherData = {
        temperature: Math.round(response.data.main.temp),
        condition: response.data.weather[0].main,
        description: response.data.weather[0].description,
        humidity: response.data.main.humidity,
        icon: response.data.weather[0].icon
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
  }

  /** GeoJSON [lng, lat] for getGrabNavigationRoute (same rules as MapView). */
  function coordinatesAsLngLat(loc) {
    return locationToLngLatArray(loc);
  }

  // Plan route using Grab Maps ETA direction API
  async function planRoute() {
    if (!pickupLocation || !dropoffLocation) {
      alert('Please select both pickup and dropoff locations');
      return;
    }

    setPlanningRoute(true);
    setRouteData(null);
    setWeatherData(null);

    try {
      const pickupPair = coordinatesAsLngLat(pickupLocation);
      const dropoffPair = coordinatesAsLngLat(dropoffLocation);
      if (!pickupPair || !dropoffPair) {
        alert('Pickup or drop-off is missing valid coordinates. Please pick a place again.');
        return;
      }
      const coordinates = [pickupPair, dropoffPair];
      const routeJson = await getGrabNavigationRoute(coordinates, 'driving');

      if (routeJson.routes && routeJson.routes.length > 0) {
        const route = routeJson.routes[0];
        
        // Get weather data for the destination
        setWeatherLoading(true);
        const weather = await getWeatherData(dropoffPair || dropoffLocation.coordinates);
        setWeatherLoading(false);
        
        // Create human-like description with landmarks
        const { description, landmarks, rankedDining } = await generateHumanLikeDescription(
          route,
          pickupLocation,
          dropoffLocation
        );
        const destinationDiningEndpointKey = dropoffPair
          ? `${dropoffPair[0].toFixed(5)},${dropoffPair[1].toFixed(5)}`
          : '';

        setRouteData({
          distance: (route.distance / 1000).toFixed(1), // Convert to km
          duration: Math.round(route.duration / 60), // Convert to minutes
          geometry: route.geometry,
          steps: route.legs?.[0]?.steps || [],
          humanDescription: description,
          landmarks: dedupeLandmarks(landmarks).map(toLandmarkPayload),
          destinationDining: Array.isArray(rankedDining) ? rankedDining : [],
          destinationDiningEndpointKey
        });
        
        setWeatherData(weather);
      }
    } catch (error) {
      console.error('Error planning route:', error);
      alert('Unable to plan route. Please try again with different locations.');
    } finally {
      setPlanningRoute(false);
      setWeatherLoading(false);
    }
  }

  // Generate human-like route description with landmarks
  async function generateHumanLikeDescription(route, pickup, dropoff) {
    const distance = (route.distance / 1000).toFixed(1);
    const duration = Math.round(route.duration / 60);
    const steps = route.legs[0].steps;
    
    const routeCoords = route.geometry?.coordinates || [];
    const [landmarks, routeTraffic, rankedDining] = await Promise.all([
      getLandmarksAlongRoute(route, pickup, dropoff),
      getRouteTrafficJourneyInsights(pickup, dropoff, routeCoords, { maxIncidents: 5 }),
      fetchTopRestaurantsNearDropoff(dropoff, selectedCountry)
    ]);
    
    // Create inspiring opening
    const timeOfDay = new Date().getHours();
    let timeGreeting = '';
    if (timeOfDay < 12) timeGreeting = 'morning';
    else if (timeOfDay < 17) timeGreeting = 'afternoon';
    else timeGreeting = 'evening';
    
    let description = `✨ **Embark on Your ${distance}km Adventure!**

🚗 Your ${timeGreeting} journey from **${pickup.name}** --> **${dropoff.name}** promises to be spectacular! In just **${duration} minutes**, you'll experience the vibrant heart of Southeast Asia.

🏙️ **Your Scenic Route:**`;

    // Add landmark highlights if found (markers on map after you open Journey)
    if (landmarks.length > 0) {
      description += `\n\n🎯 **Iconic Sights Along Your Way**\nOn the map, tap the flagged sight markers (name labels) for photos and details.`;
      description += `\n\n💫 **Pro Tip:** Keep your camera ready for these stunning landmarks!`;
    } else {
      // Fallback when no landmarks found
      description += `\n\n🌆 **Urban Adventure Awaits:**\nWhile we search for specific landmarks, you'll experience the vibrant streetscape of Southeast Asia with its unique architecture, bustling markets, and local life unfolding around every corner.`;
    }

    // Add route highlights (Grab navigation step structure)
    const keyInstructions = (steps || [])
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

    description += formatRouteTrafficSection(routeTraffic);
    const localTip = await getLocalTravelTip(pickup, dropoff, selectedCountry, {
      durationMinutes: duration,
      rankedRestaurants: rankedDining
    });

    description += `\n\n📍 **Your Destination Awaits:** ${dropoff.address}

🌟 **Make This Journey Memorable:**
• ${getWeatherAdvice(duration)}
• **Photo Opportunity:** ${landmarks.length > 0 ? `Don't miss ${landmarks[0]?.name || 'the scenic views'}!` : 'Capture the urban landscape!'}
• **Local Tip:** ${localTip}
• **Journey Time:** ${duration} minutes (${distance}km of discovery)

Ready for an unforgettable Southeast Asian adventure? 🌏✨`;

    return { description, landmarks: dedupeLandmarks(landmarks), rankedDining };
  }

  // Get landmarks along the route
  async function getLandmarksAlongRoute(route, pickup, dropoff) {
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
            photoUrl: place.photoUrl || extractPlacePhotoUrl(place),
            routeIndex: index,
            side: determineSide(routeCoordinates, point, [
              place.location.longitude,
              place.location.latitude
            ]),
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
  }

  // Determine if landmark is on left or right side of route
  function determineSide(routeCoordinates, currentPoint, landmarkPoint) {
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
  }

  // Get weather-based advice
  function getWeatherAdvice(duration) {
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
  }

  // Clear all planning data to start fresh
  function clearPlanning() {
    setPickupLocation(null);
    setDropoffLocation(null);
    setPickupQuery('');
    setDropoffQuery('');
    setPickupSuggestions([]);
    setDropoffSuggestions([]);
    setRouteData(null);
    setWeatherData(null);
    setSelectedCountry('singapore'); // Reset to default country
    console.log('🧹 Planning data cleared - ready for new journey');
  }

  // Start journey - navigate to map view
  // Parse markdown-style bold text (**text**) to proper formatting (consistent with MapView.js)
  function parseMarkdownToJSX(text) {
    if (!text) return text;
    
    // Split by line breaks first to maintain formatting
    const lines = text.split('\n');
    
    return lines.map((line, lineIndex) => {
      const parts = line.split(/(\*\*.*?\*\*)/g);
      
      const parsedLine = parts.map((part, partIndex) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          // Remove ** and make bold
          const boldText = part.slice(2, -2);
          return <Text key={`${lineIndex}-${partIndex}`} strong style={{ fontWeight: 600, color: '#262626' }}>{boldText}</Text>;
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
  }

  function startJourney() {
    if (!routeData) {
      alert('Please plan your route first');
      return;
    }

    // Pass route data to map view including selected country
    navigate('/map', { 
      state: { 
        pickupLocation, 
        dropoffLocation, 
        routeData, 
        weatherData,
        selectedCountry 
      } 
    });
  }

  // Handle location selection
  function selectLocation(location, type) {
    if (type === 'pickup') {
      setPickupLocation(location);
      setPickupQuery(location.name);
      setPickupSuggestions([]);
    } else {
      setDropoffLocation(location);
      setDropoffQuery(location.name);
      setDropoffSuggestions([]);
    }
  }

  // Use current location as pickup
  function useCurrentLocation() {
    if (!userLocation) {
      alert('Location not available. Please allow location access.');
      return;
    }

    const currentLocationData = {
      id: 'current-location',
      name: 'My Current Location',
      address: `${userLocation.latitude.toFixed(4)}, ${userLocation.longitude.toFixed(4)}`,
      coordinates: [userLocation.longitude, userLocation.latitude]
    };

    selectLocation(currentLocationData, 'pickup');
  }

  return (
    <Layout style={{ minHeight: '100vh', background: 'var(--background-alt, #f5f5f5)' }}>
      <Content style={{ padding: '0' }}>
        {/* Hero Section */}
        <div className="hero-section">
          <div className="hero-ambient" aria-hidden="true" />
          <div className="hero-noise" aria-hidden="true" />
          <div className="hero-content">
            <div className="hero-visual">
              <div className="hero-visual-glow" aria-hidden="true" />
              <div className="hero-logo-frame">
                <img
                  src={`${process.env.PUBLIC_URL}/grabmaps.png`}
                  alt="GrabMaps"
                  className="hero-grabmaps-logo"
                  width={280}
                  height={280}
                />
              </div>
              <div className="hero-stat hero-stat--a">
                <span className="hero-stat-label">Live routing</span>
                <span className="hero-stat-value">Traffic-aware</span>
              </div>
              <div className="hero-stat hero-stat--b">
                <span className="hero-stat-label">Built for</span>
                <span className="hero-stat-value">SEA cities</span>
              </div>
            </div>

            <div className="hero-text hero-text--hud">
              <span className="hero-eyebrow">
                <span className="hero-eyebrow-dot" aria-hidden="true" />
                Powered by GrabMaps
              </span>
              <Title level={1} className="hero-title">
                JourneyGenie
              </Title>
              <Title level={3} className="hero-subtitle">
                Your GrabMaps-powered travel companion for Southeast Asia
              </Title>
              <Paragraph className="hero-lede">
                Plan your perfect journey with intelligent route planning, real-time weather updates,
                and human-like navigation that remembers landmarks, not just street names.
              </Paragraph>

              <div className="hero-action-button">
                <Space size="large" direction="vertical" align="start">
                  <Button
                    type="primary"
                    size="large"
                    className="hero-cta"
                    onClick={() => navigate('/map')}
                    icon={<SearchOutlined />}
                  >
                    Explore GrabMaps
                  </Button>
                  <Text className="hero-cta-hint">
                    or scroll down to plan a route
                  </Text>
                </Space>
              </div>
            </div>
          </div>

            {/* Current Weather Section */}
            <div className="current-weather-section hero-weather">
              {locationLoading && (
                <Card className="hero-weather-card" bordered={false}>
                  <Space align="center">
                    <Spin size="small" />
                    <Text className="hero-weather-card-text">Getting your location...</Text>
                  </Space>
                </Card>
              )}
            </div>
        </div>

        {/* Route Planning Section */}
        <div className="planning-section planning-section--sea-tech">
          <div className="planning-section-gridfx" aria-hidden="true" />
          <div className="planning-section-glow" aria-hidden="true" />

          {/* Section Header */}
          <div className="planning-section-header">
            <span className="planning-section-kicker">SEA routing mesh · live POI index</span>
            <Title level={2} className="planning-section-title">
              Plan Your Perfect Journey
            </Title>
            <Text className="planning-section-subtitle">
              Smart route planning with real-time insights for Southeast Asia
            </Text>
          </div>
          
          <Row gutter={[32, 32]} justify="center" className="planning-section-row">
            <Col xs={24} lg={12}>
              <Card className="location-card hud-panel" size="large">
                <Space direction="vertical" size="large" className="planner-stack">
                  <div className="card-header card-header--hud">
                    <div className="card-header-row">
                      <div>
                        <Title level={3} className="card-header-title">
                          🗺️ Plan Your Journey
                        </Title>
                        {previousData && (
                          <Text className="planner-restore-badge">
                            ✅ Previous planning restored
                          </Text>
                        )}
                      </div>
                      {(pickupLocation || dropoffLocation || routeData) && (
                        <Button
                          type="text"
                          size="small"
                          onClick={clearPlanning}
                          className="planner-clear-btn"
                        >
                          🧹 Clear & Start New
                        </Button>
                      )}
                    </div>
                    <Text className="card-header-desc">
                      Select your destination country and plan your journey
                    </Text>
                  </div>

                  {/* Country Selector */}
                  <div className="country-selector-section planner-block">
                    <Text strong className="planner-field-label planner-field-label--region">
                      🌏 Destination Country
                    </Text>
                    <Select
                      size="large"
                      placeholder="Select destination country"
                      value={selectedCountry}
                      onChange={(value) => {
                        setSelectedCountry(value);
                        console.log('🌍 Country changed to:', SOUTHEAST_ASIAN_COUNTRIES[value]?.name);
                        
                        // Clear existing suggestions when country changes
                        setPickupSuggestions([]);
                        setDropoffSuggestions([]);
                      }}
                      style={{ width: '100%' }}
                      options={Object.entries(SOUTHEAST_ASIAN_COUNTRIES).map(([key, country]) => ({
                        value: key,
                        label: country.name,
                        emoji: country.flag
                      }))}
                    />
                    <Text className="planner-field-hint">
                      POI search will focus on {SOUTHEAST_ASIAN_COUNTRIES[selectedCountry]?.name || 'the selected country'}
                    </Text>
                  </div>

                  {/* Pickup Location */}
                  <div className="location-input-section planner-block">
                    <Text strong className="planner-field-label planner-field-label--pickup">
                      📍 Pickup Location
                    </Text>
                    <Input
                      size="large"
                      placeholder="Enter pickup location (e.g., Marina Bay Sands)"
                      value={pickupQuery}
                      onChange={(e) => {
                        const value = e.target.value;
                        //console.log('🔍 Pickup input changed:', value);
                        setPickupQuery(value);
                        searchLocations(value, setPickupSuggestions);
                      }}
                      prefix={<EnvironmentFilled style={{ color: '#52c41a' }} />}
                      suffix={loading && pickupQuery ? <Spin size="small" /> : null}
                      className="location-input"
                    />
                    
                    {/* Use Current Location Button */}
                    {userLocation && !pickupLocation && (
                      <Button
                        type="dashed"
                        size="small"
                        onClick={useCurrentLocation}
                        className="planner-geo-btn"
                        icon={<EnvironmentFilled />}
                      >
                        Use My Current Location
                      </Button>
                    )}
                    
                    {pickupSuggestions.length > 0 && (
                      <Card className="suggestions-card" size="small">
                        {pickupSuggestions.map((location) => (
                          <div
                            key={location.id}
                            className="suggestion-item"
                            onClick={() => selectLocation(location, 'pickup')}
                          >
                            <Text strong>{location.name}</Text>
                            <br />
                            <Text style={{ fontSize: '12px', color: '#666' }}>
                              {location.address}
                            </Text>
                            {location.distance && (
                              <Text style={{ fontSize: '11px', color: '#52c41a', marginLeft: '8px' }}>
                                📏 {location.distance.toFixed(1)}km
                              </Text>
                            )}
                            {location.businessType && (
                              <br />
                            )}
                            {location.businessType && (
                              <Text style={{ fontSize: '11px', color: '#1890ff' }}>
                                🏢 {location.businessType.replace(/_/g, ' ')}
                              </Text>
                            )}
                            {location.techFamilies && location.techFamilies.length > 0 && (
                              <>
                                <br />
                                <Text style={{ fontSize: '11px', color: '#00b14f' }}>
                                  🚗 {location.techFamilies.map(tf => tf.replace('grab', 'Grab')).join(', ')}
                                </Text>
                              </>
                            )}
                          </div>
                        ))}
                      </Card>
                    )}
                  </div>

                  {/* Dropoff Location */}
                  <div className="location-input-section planner-block">
                    <Text strong className="planner-field-label planner-field-label--dropoff">
                      🎯 Destination
                    </Text>
                    <Input
                      size="large"
                      placeholder="Enter destination (e.g., Changi Airport)"
                      value={dropoffQuery}
                      onChange={(e) => {
                        const value = e.target.value;
                        //console.log('🎯 Dropoff input changed:', value);
                        setDropoffQuery(value);
                        searchLocations(value, setDropoffSuggestions);
                      }}
                      prefix={<EnvironmentFilled style={{ color: '#f5222d' }} />}
                      suffix={loading && dropoffQuery ? <Spin size="small" /> : null}
                      className="location-input"
                    />
                    {dropoffSuggestions.length > 0 && (
                      <Card className="suggestions-card" size="small">
                        {dropoffSuggestions.map((location) => (
                          <div
                            key={location.id}
                            className="suggestion-item"
                            onClick={() => selectLocation(location, 'dropoff')}
                          >
                            <Text strong>{location.name}</Text>
                            <br />
                            <Text style={{ fontSize: '12px', color: '#666' }}>
                              {location.address}
                            </Text>
                            {location.distance && (
                              <Text style={{ fontSize: '11px', color: '#52c41a', marginLeft: '8px' }}>
                                📏 {location.distance.toFixed(1)}km
                              </Text>
                            )}
                            {location.businessType && (
                              <br />
                            )}
                            {location.businessType && (
                              <Text style={{ fontSize: '11px', color: '#1890ff' }}>
                                🏢 {location.businessType.replace(/_/g, ' ')}
                              </Text>
                            )}
                            {location.techFamilies && location.techFamilies.length > 0 && (
                              <>
                                <br />
                                <Text style={{ fontSize: '11px', color: '#00b14f' }}>
                                  🚗 {location.techFamilies.map(tf => tf.replace('grab', 'Grab')).join(', ')}
                                </Text>
                              </>
                            )}
                          </div>
                        ))}
                      </Card>
                    )}
                  </div>

                  {/* Plan Route Button */}
                  <Button
                    type="primary"
                    size="large"
                    loading={planningRoute}
                    onClick={planRoute}
                    disabled={!pickupLocation || !dropoffLocation}
                    className="plan-route-cta"
                    icon={<SearchOutlined />}
                  >
                    {planningRoute ? 'Planning Your Route...' : 'Plan My Route'}
                  </Button>
                </Space>
              </Card>
            </Col>

            {/* Route Results */}
            <Col xs={24} lg={12}>
              {routeData && (
                <Space direction="vertical" size="large" style={{ width: '100%' }}>
                  {/* Route Summary */}
                  <Card className="route-summary-card hud-readout">
                    <Row gutter={[16, 16]}>
                      <Col span={8}>
                        <div className="route-stat">
                          <Text className="route-stat-label">Distance</Text>
                          <Title level={3} className="route-stat-value route-stat-value--dist">
                            {routeData.distance} km
                          </Title>
                        </div>
                      </Col>
                      <Col span={8}>
                        <div className="route-stat">
                          <Text className="route-stat-label">Duration</Text>
                          <Title level={3} className="route-stat-value route-stat-value--time">
                            {routeData.duration} min
                          </Title>
                        </div>
                      </Col>
                      <Col span={8}>
                        {weatherData && (
                          <div className="route-stat">
                            <Text className="route-stat-label">Weather</Text>
                            <Title level={3} className="route-stat-value route-stat-value--wx">
                              {weatherData.temperature}°C
                            </Title>
                          </div>
                        )}
                      </Col>
                    </Row>
                  </Card>

                  {Array.isArray(routeData.destinationDining) && routeData.destinationDining.length > 0 && (
                    <Card className="route-dining-card hud-readout" title="🍽 Dining near your destination">
                      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
                        Preferably within {DESTINATION_DINING_SEARCH_RADIUS_METERS} m of your drop-off (up to{' '}
                        {DESTINATION_DINING_DISPLAY_MAX_METERS} m straight-line when the nearest POIs sit just outside).
                        Shown on the map after Start My Journey.
                      </Text>
                      <List
                        size="small"
                        dataSource={routeData.destinationDining}
                        renderItem={(poi) => (
                          <List.Item style={{ padding: '8px 0' }}>
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
                    </Card>
                  )}

                  {/* Weather Info */}
                  {(weatherData || weatherLoading) && (
                    <Card className="weather-card hud-readout">
                      {weatherLoading ? (
                        <Space align="center">
                          <Spin size="small" />
                          <Text className="weather-card-loading">Fetching weather data...</Text>
                        </Space>
                      ) : (
                        <Space align="center">
                          <Avatar
                            size={48}
                            className="weather-card-avatar"
                            icon={<SunOutlined />}
                          />
                          <div>
                            <Text strong className="weather-card-headline">
                              {weatherData.condition} • {weatherData.temperature}°C
                            </Text>
                            <br />
                            <Text className="weather-card-meta">
                              {weatherData.description}, {weatherData.humidity}% humidity
                            </Text>
                          </div>
                        </Space>
                      )}
                    </Card>
                  )}

                  {/* Human-like Description */}
                  <Card className="route-description-card hud-readout">
                    <Title level={4} className="route-description-title">
                      <CompassOutlined className="route-description-icon" />
                      Your Journey Guide
                    </Title>
                    <div className="journey-markdown-body">
                      {parseMarkdownToJSX(routeData.humanDescription)}
                    </div>
                  </Card>

                  {/* Start Journey Button */}
                  <Button
                    type="primary"
                    size="large"
                    onClick={startJourney}
                    className="start-journey-cta"
                    icon={<RightCircleFilled />}
                  >
                    Start My Journey
                  </Button>
                </Space>
              )}

              {/* Empty State */}
              {!routeData && !planningRoute && (
                <Card className="empty-state-card empty-state-card--tech">
                  <div className="empty-state-radar" aria-hidden="true" />
                  <Space direction="vertical" align="center" size="large" className="empty-state-inner">
                    <CarOutlined className="empty-state-icon" />
                    <div className="empty-state-copy">
                      <span className="empty-state-tag">AWAITING COORDINATES</span>
                      <Title level={4} className="empty-state-title">
                        Your Travel Plan...
                      </Title>
                      <Text className="empty-state-text">
                        Select your pickup and destination locations to get started
                      </Text>
                    </div>
                  </Space>
                </Card>
              )}
            </Col>
          </Row>
        </div>

        {/* Features Section */}
        <div className="features-section">
          <div className="features-section-header">
            <Title level={2} className="features-section-title">
              Why Choose JourneyGenie?
            </Title>
            <Paragraph className="features-section-subtitle">
              Three reasons travelers and teams pick this stack—routing intelligence, human directions, and regional depth.
            </Paragraph>
          </div>
          <Row gutter={[32, 32]} justify="center">
            <Col xs={24} md={8}>
              <Card className="feature-card feature-card--accent-green">
                <div className="feature-icon feature-icon--delay-0" aria-hidden="true">
                  <ThunderboltOutlined className="feature-icon-svg" />
                </div>
                <Title level={4} className="feature-card-title">
                  AI-Powered Planning
                </Title>
                <Text className="feature-card-text">
                  Smart route optimization with real-time traffic and weather integration
                </Text>
              </Card>
            </Col>
            <Col xs={24} md={8}>
              <Card className="feature-card feature-card--accent-teal">
                <div className="feature-icon feature-icon--delay-1" aria-hidden="true">
                  <PushpinOutlined className="feature-icon-svg feature-icon-svg--teal" />
                </div>
                <Title level={4} className="feature-card-title">
                  Landmark Navigation
                </Title>
                <Text className="feature-card-text">
                  Human-friendly directions using landmarks instead of just street names
                </Text>
              </Card>
            </Col>
            <Col xs={24} md={8}>
              <Card className="feature-card feature-card--accent-deep">
                <div className="feature-icon feature-icon--delay-2" aria-hidden="true">
                  <HeatMapOutlined className="feature-icon-svg feature-icon-svg--deep" />
                </div>
                <Title level={4} className="feature-card-title">
                  Southeast Asia Expert
                </Title>
                <Text className="feature-card-text">
                  Specialized knowledge of local roads, traffic patterns, and landmarks
                </Text>
              </Card>
            </Col>
          </Row>
        </div>
      </Content>
    </Layout>
  );
};

export default LandingPage; 