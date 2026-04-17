/**
 * Configuration utilities for secure API key management
 * Handles environment variables and provides fallback behavior
 */

import { USE_API_PROXY, buildOpenWeatherClientUrl, isWeatherFetchConfigured } from '../config/apiProxy';

// Validate and get environment variables
export const getEnvironmentConfig = () => {
  const config = {
    openWeatherApiKey: process.env.REACT_APP_OPENWEATHER_API_KEY,
    environment: process.env.REACT_APP_ENVIRONMENT || 'development',
    isWeatherApiAvailable: isWeatherFetchConfigured()
  };

  // Log configuration status (without exposing sensitive data)
  console.log('🔧 Environment Configuration:');
  console.log(`   Environment: ${config.environment}`);
  console.log(`   Weather API: ${config.isWeatherApiAvailable ? '✅ Configured' : '❌ Not configured'}`);
  
  if (!config.isWeatherApiAvailable) {
    console.warn('⚠️ Weather API key not found. Weather features will use fallback data.');
    console.info('💡 To enable weather features:');
    console.info('   1. Get API key from https://openweathermap.org/api');
    console.info('   2. Add REACT_APP_OPENWEATHER_API_KEY to your .env file, or REACT_APP_API_PROXY_URL for server-side keys');
  }

  return config;
};

// Weather API configuration
export const weatherConfig = {
  apiKey: process.env.REACT_APP_OPENWEATHER_API_KEY,
  baseUrl: 'https://api.openweathermap.org/data/2.5/weather',
  isConfigured: isWeatherFetchConfigured(),
  
  // Build API URL with secure key handling
  buildWeatherUrl: (lat, lon) => {
    if (!weatherConfig.isConfigured) {
      throw new Error('Weather API key not configured');
    }
    if (USE_API_PROXY) {
      return buildOpenWeatherClientUrl(lat, lon);
    }
    return `${weatherConfig.baseUrl}?lat=${lat}&lon=${lon}&appid=${weatherConfig.apiKey}&units=metric`;
  },

  // Fallback weather data for when API is not available
  getFallbackWeather: () => ({
    temperature: 28,
    condition: 'Clear',
    description: 'API key not configured',
    humidity: 70,
    icon: '01d'
  })
};

// Initialize configuration on module load
const config = getEnvironmentConfig();
export default config; 