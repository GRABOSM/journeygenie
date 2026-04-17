/**
 * Cookie Consent Utility Functions
 * Provides easy access to user's cookie consent status across the application
 */

// Check if user has accepted cookies
export const hasCookieConsent = () => {
  try {
    const consentData = localStorage.getItem('journeyGenie_cookieConsent');
    if (!consentData) return false;
    
    const { accepted, timestamp } = JSON.parse(consentData);
    const threeMonthsAgo = Date.now() - (90 * 24 * 60 * 60 * 1000); // 3 months in milliseconds
    
    // Return true if user accepted and consent is still valid (less than 3 months old)
    return accepted && timestamp >= threeMonthsAgo;
  } catch (error) {
    console.warn('Error checking cookie consent:', error);
    return false;
  }
};

// Get the full consent data
export const getCookieConsentData = () => {
  try {
    const consentData = localStorage.getItem('journeyGenie_cookieConsent');
    if (!consentData) return null;
    
    return JSON.parse(consentData);
  } catch (error) {
    console.warn('Error getting cookie consent data:', error);
    return null;
  }
};

// Check if we should enable analytics based on consent
export const canUseAnalytics = () => {
  return hasCookieConsent();
};

// Check if we can use performance optimizations
export const canUsePerformanceOptimizations = () => {
  return hasCookieConsent();
};

// Check if we can store location preferences
export const canStoreLocationData = () => {
  return hasCookieConsent();
};

// Utility to conditionally execute code based on consent
export const withCookieConsent = (callback) => {
  if (hasCookieConsent()) {
    callback();
  } else {
    console.log('🍪 Cookie consent required for this feature');
  }
};

// Log analytics event only if consent is given
export const logAnalyticsEvent = (eventName, eventData = {}) => {
  withCookieConsent(() => {
    console.log(`�� Analytics Event: ${eventName}`, eventData);
    // Here you would integrate with your analytics service
    // Example: gtag('event', eventName, eventData);
  });
};

// Store user preferences only if consent is given
export const storeUserPreference = (key, value) => {
  withCookieConsent(() => {
    try {
      localStorage.setItem(`journeyGenie_pref_${key}`, JSON.stringify(value));
      console.log(`💾 Preference stored: ${key}`);
    } catch (error) {
      console.warn('Error storing user preference:', error);
    }
  });
};

// Get user preferences only if consent is given
export const getUserPreference = (key, defaultValue = null) => {
  if (!hasCookieConsent()) {
    return defaultValue;
  }
  
  try {
    const value = localStorage.getItem(`journeyGenie_pref_${key}`);
    return value ? JSON.parse(value) : defaultValue;
  } catch (error) {
    console.warn('Error getting user preference:', error);
    return defaultValue;
  }
};

export default {
  hasCookieConsent,
  getCookieConsentData,
  canUseAnalytics,
  canUsePerformanceOptimizations,
  canStoreLocationData,
  withCookieConsent,
  logAnalyticsEvent,
  storeUserPreference,
  getUserPreference
};
