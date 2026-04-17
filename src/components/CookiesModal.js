import React, { useState, useEffect } from 'react';
import { Modal, Button, Typography, Space, Row, Col, Image } from 'antd';
import { CloseOutlined, CheckOutlined } from '@ant-design/icons';

const { Title, Text, Paragraph } = Typography;

const CookiesModal = () => {
  const [isVisible, setIsVisible] = useState(false);

  // Check if user has already accepted cookies in the last 3 months
  useEffect(() => {
    const checkCookieConsent = () => {
      const consentData = localStorage.getItem('journeyGenie_cookieConsent');
      
      if (consentData) {
        try {
          const { accepted, timestamp } = JSON.parse(consentData);
          const threeMonthsAgo = Date.now() - (90 * 24 * 60 * 60 * 1000); // 3 months in milliseconds
          
          // Show modal if user hasn't accepted or if consent is older than 3 months
          if (!accepted || timestamp < threeMonthsAgo) {
            setIsVisible(true);
          }
        } catch (error) {
          console.warn('Error parsing cookie consent data:', error);
          setIsVisible(true);
        }
      } else {
        // No consent data found, show modal
        setIsVisible(true);
      }
    };

    // Show modal after a short delay for better UX
    const timer = setTimeout(checkCookieConsent, 2000);
    return () => clearTimeout(timer);
  }, []);

  const handleAccept = () => {
    const consentData = {
      accepted: true,
      timestamp: Date.now(),
      version: '1.0'
    };
    
    localStorage.setItem('journeyGenie_cookieConsent', JSON.stringify(consentData));
    setIsVisible(false);
    
    console.log('✅ Cookies accepted. Consent stored for 3 months.');
  };

  const handleDecline = () => {
    const consentData = {
      accepted: false,
      timestamp: Date.now(),
      version: '1.0'
    };
    
    localStorage.setItem('journeyGenie_cookieConsent', JSON.stringify(consentData));
    setIsVisible(false);
    
    console.log('❌ Cookies declined. Basic functionality only.');
  };

  return (
    <Modal
      open={isVisible}
      onCancel={handleDecline}
      footer={null}
      closable={true}
      closeIcon={<CloseOutlined style={{ color: '#666', fontSize: 16 }} />}
      centered
      width={520}
      className="cookies-modal"
      maskStyle={{
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        backdropFilter: 'blur(4px)'
      }}
      style={{
        borderRadius: '20px',
        overflow: 'hidden'
      }}
    >
      <div className="cookies-modal-content">
        {/* Header with Brand Icon */}
        <div className="cookies-header">
          <Row align="middle" gutter={[16, 0]}>
            <Col>
              <div className="brand-icon-container">
                <Image
                  src="/icon.png"
                  alt="JourneyGenie"
                  width={48}
                  height={48}
                  preview={false}
                  style={{
                    borderRadius: '12px',
                    boxShadow: '0 4px 12px rgba(0, 177, 79, 0.2)'
                  }}
                />
              </div>
            </Col>
            <Col flex={1}>
              <Title level={3} style={{ margin: 0, color: '#1a1a1a', fontWeight: 700 }}>
                🍪 We value your privacy
              </Title>
              <Text style={{ color: '#666', fontSize: '14px' }}>
                JourneyGenie by Grab
              </Text>
            </Col>
          </Row>
        </div>

        {/* Content */}
        <div className="cookies-content">
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <Paragraph style={{ fontSize: '15px', lineHeight: '1.6', color: '#333', margin: 0 }}>
              We use cookies and similar technologies to enhance your experience with 
              <Text strong style={{ color: '#00b14f' }}> JourneyGenie</Text>. This helps us:
            </Paragraph>

            <div className="cookies-benefits">
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <div className="benefit-item">
                  <Text style={{ fontSize: '14px', color: '#333' }}>
                    🗺️ <Text strong>Improve route planning:</Text> We collect location data anonymously to optimize journey suggestions and traffic predictions
                  </Text>
                </div>
                <div className="benefit-item">
                  <Text style={{ fontSize: '14px', color: '#333' }}>
                    ⚡ <Text strong>Enhance performance:</Text> Cookies help us load maps faster and remember your preferences for a smoother experience
                  </Text>
                </div>
                <div className="benefit-item">
                  <Text style={{ fontSize: '14px', color: '#333' }}>
                    🎯 <Text strong>Personalize features:</Text> Remember your favorite locations and provide relevant POI recommendations
                  </Text>
                </div>
                <div className="benefit-item">
                  <Text style={{ fontSize: '14px', color: '#333' }}>
                    📊 <Text strong>Analytics:</Text> Understand how our service is used to continuously improve the platform
                  </Text>
                </div>
              </Space>
            </div>

            <div className="privacy-note">
              <Text style={{ 
                fontSize: '13px', 
                color: '#666', 
                fontStyle: 'italic',
                display: 'block',
                padding: '12px',
                backgroundColor: '#f8f9fa',
                borderRadius: '8px',
                border: '1px solid #e8e8e8'
              }}>
                🔒 <Text strong>Privacy commitment:</Text> All location data is processed anonymously and in accordance with Grab's Privacy Policy. 
                We never share personal information with third parties without your explicit consent.
              </Text>
            </div>

            <Text style={{ fontSize: '13px', color: '#999' }}>
              By accepting, you agree to our use of cookies. You can change your preferences anytime in settings. 
              This consent will be remembered for 3 months as per standard privacy practices.
            </Text>
          </Space>
        </div>

        {/* Action Buttons */}
        <div className="cookies-actions">
          <Row gutter={[12, 12]}>
            <Col xs={24} sm={12}>
              <Button
                onClick={handleDecline}
                size="large"
                style={{ 
                  width: '100%',
                  height: '48px',
                  borderRadius: '12px',
                  border: '2px solid #d9d9d9',
                  color: '#666',
                  fontWeight: 600
                }}
              >
                Decline
              </Button>
            </Col>
            <Col xs={24} sm={12}>
              <Button
                type="primary"
                onClick={handleAccept}
                size="large"
                icon={<CheckOutlined />}
                style={{ 
                  width: '100%',
                  height: '48px',
                  borderRadius: '12px',
                  background: 'linear-gradient(135deg, #00b14f 0%, #00804a 50%, #17b5a6 100%)',
                  border: 'none',
                  fontWeight: 600,
                  boxShadow: '0 4px 12px rgba(0, 177, 79, 0.3)'
                }}
              >
                Accept All Cookies
              </Button>
            </Col>
          </Row>
        </div>
      </div>
    </Modal>
  );
};

export default CookiesModal; 