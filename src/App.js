import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { ConfigProvider, theme } from 'antd';
import LandingPage from './components/LandingPage';
import MapView from './components/MapView';
import CookiesModal from './components/CookiesModal';
import './App.css';

const grabTheme = {
  algorithm: theme.defaultAlgorithm,
  token: {
    colorPrimary: '#00b14f',
    colorSuccess: '#00b14f',
    colorInfo: '#136fd8',
    colorLink: '#0b54a8',
    colorWarning: '#f09800',
    colorError: '#d42e1c',
    borderRadius: 10,
    borderRadiusLG: 14,
    fontFamily:
      "'Plus Jakarta Sans', 'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  },
  components: {
    Layout: {
      headerBg: 'transparent',
      bodyBg: '#f5f5f5',
    },
    Button: {
      primaryShadow: '0 4px 14px rgba(0, 177, 79, 0.28)',
    },
    Card: {
      borderRadiusLG: 14,
    },
  },
};

function App() {
  return (
    <ConfigProvider theme={grabTheme}>
      <Router>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/map" element={<MapView />} />
        </Routes>
        <CookiesModal />
      </Router>
    </ConfigProvider>
  );
}

export default App;
