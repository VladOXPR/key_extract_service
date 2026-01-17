const express = require('express');
const path = require('path');

// Log startup
console.log('🚀 Starting server...');
console.log('📋 Node version:', process.version);
console.log('📋 NODE_ENV:', process.env.NODE_ENV || 'not set');
console.log('📋 PORT:', process.env.PORT || '8080 (default)');

// Load environment variables FIRST (before loading routes that need them)
try {
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '.env.local') });
  console.log('✅ Environment variables loaded');
} catch (error) {
  console.warn('⚠️ Error loading .env files (may not exist):', error.message);
}

// Load user routes with error handling
let userRoutes;
try {
  userRoutes = require('./user_service_api');
  console.log('✅ User service API routes loaded successfully');
} catch (error) {
  console.error('❌ Error loading user service API routes:', error);
  console.error('Error stack:', error.stack);
  // Create a dummy router to prevent app crash
  userRoutes = express.Router();
  userRoutes.get('*', (req, res) => {
    res.status(500).json({
      success: false,
      error: 'User service API not available: ' + error.message
    });
  });
}

// Load map routes with error handling
let mapRoutes;
try {
  mapRoutes = require('./map_service_api');
  console.log('✅ Map service API routes loaded successfully');
} catch (error) {
  console.error('❌ Error loading map service API routes:', error);
  console.error('Error stack:', error.stack);
  // Create a dummy router to prevent app crash
  mapRoutes = express.Router();
  mapRoutes.get('*', (req, res) => {
    res.status(500).json({
      success: false,
      error: 'Map service API not available: ' + error.message
    });
  });
}

// Load token routes with error handling
let tokenRoutes;
try {
  const tokenExtract = require('./token_extract');
  if (!tokenExtract || !tokenExtract.router) {
    throw new Error('token_extract module did not export router');
  }
  tokenRoutes = tokenExtract.router;
  console.log('✅ Token service API routes loaded successfully');
} catch (error) {
  console.error('❌ Error loading token service API routes:', error);
  console.error('Error stack:', error.stack);
  // Create a dummy router to prevent app crash
  tokenRoutes = express.Router();
  tokenRoutes.get('*', (req, res) => {
    res.status(500).json({
      success: false,
      error: 'Token service API not available: ' + error.message
    });
  });
}

const app = express();
const PORT = process.env.PORT || 8080;

/**
 * Health check endpoint - define early for Cloud Run startup probe
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'energo-token-extractor',
        timestamp: new Date().toISOString()
    });
});

// Middleware
app.use(express.json());

// Mount user routes
app.use('/', userRoutes);
console.log('🔗 User routes mounted at root path');

// Mount map routes
app.use('/', mapRoutes);
console.log('🔗 Map routes mounted at root path');

// Mount token routes
app.use('/', tokenRoutes);
console.log('🔗 Token routes mounted at root path');

// Debug: Log all registered routes (development only)
if (process.env.NODE_ENV !== 'production') {
  app._router.stack.forEach((middleware) => {
    if (middleware.route) {
      console.log(`   ${Object.keys(middleware.route.methods).join(', ').toUpperCase()} ${middleware.route.path}`);
    } else if (middleware.name === 'router') {
      console.log(`   Router mounted at: ${middleware.regexp}`);
    }
  });
}

// Start the server with error handling
// Bind to 0.0.0.0 to listen on all network interfaces (required for Cloud Run)
try {
    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server is running on http://0.0.0.0:${PORT}`);
        console.log(`📡 GET endpoint available at: http://0.0.0.0:${PORT}/token`);
        console.log(`❤️  Health check available at: http://0.0.0.0:${PORT}/health`);
        console.log(`✅ Server is ready to accept connections`);
    });
        
    // Handle server errors
    server.on('error', (error) => {
        console.error('❌ Server listen error:', error);
        if (error.code === 'EADDRINUSE') {
            console.error(`❌ Port ${PORT} is already in use`);
        }
        process.exit(1);
    });

        // Handle process errors
    process.on('uncaughtException', (error) => {
        console.error('❌ Uncaught Exception:', error);
        process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
        // Don't exit on unhandled rejection, just log it
    });
} catch (error) {
    console.error('❌ Failed to start server:', error);
    console.error('Error stack:', error.stack);
    process.exit(1);
}

// ========================================
// AUTOMATIC TOKEN REFRESH SCHEDULER
// ========================================

// Add fetch for HTTP requests
let fetch;
if (typeof globalThis.fetch === 'undefined') {
  fetch = require('node-fetch');
} else {
  fetch = globalThis.fetch;
}

/**
 * Call the token endpoint to refresh the token
 */
async function refreshTokenAutomatically() {
  try {
    console.log('🔄 Automatic token refresh triggered...');
    const response = await fetch('https://api.cuub.tech/token', {
      method: 'GET'
    });

    if (!response.ok) {
      console.error(`⚠️ Automatic token refresh failed: ${response.status} ${response.statusText}`);
      return false;
    }

    const data = await response.json();
    if (data.success && data.token) {
      console.log('✅ Automatic token refresh successful');
      return true;
        }
        
    console.error('⚠️ Automatic token refresh response missing token:', data);
    return false;
    } catch (error) {
    console.error('❌ Error during automatic token refresh:', error.message);
    return false;
  }
}

/**
 * Schedule the next automatic token refresh
 * Uses random interval between 30 minutes and 2 hours
 */
function scheduleNextTokenRefresh() {
  // Random interval between 30 minutes (1,800,000 ms) and 2 hours (7,200,000 ms)
  const minInterval = 30 * 60 * 1000; // 30 minutes in milliseconds
  const maxInterval = 2 * 60 * 60 * 1000; // 2 hours in milliseconds
  const randomInterval = Math.floor(Math.random() * (maxInterval - minInterval + 1)) + minInterval;
  
  const hours = Math.floor(randomInterval / (60 * 60 * 1000));
  const minutes = Math.floor((randomInterval % (60 * 60 * 1000)) / (60 * 1000));
  
  console.log(`⏰ Next automatic token refresh scheduled in ${hours}h ${minutes}m (${Math.round(randomInterval / 1000 / 60)} minutes)`);
  
  setTimeout(async () => {
    await refreshTokenAutomatically();
    scheduleNextTokenRefresh(); // Schedule the next one
  }, randomInterval);
}

// Start the automatic token refresh scheduler
// Wait a bit after server starts before the first refresh
setTimeout(() => {
  console.log('🚀 Starting automatic token refresh scheduler...');
  refreshTokenAutomatically().then(() => {
    scheduleNextTokenRefresh();
  });
}, 60000); // Wait 1 minute after server starts

// ========================================
// TELEGRAM BOT SCHEDULERS
// ========================================

// Load telegram bot module
let telegramBot;
try {
  telegramBot = require('./telegram_bot');
  console.log('✅ Telegram bot module loaded successfully');
} catch (error) {
  console.error('❌ Error loading telegram bot module:', error);
  console.error('Telegram features will not be available');
}

// Start the daily Telegram report scheduler
// Wait a bit after server starts before initializing
if (telegramBot) {
  setTimeout(() => {
    telegramBot.scheduleDailyTelegramReport();
  }, 30000); // Wait 30 seconds after server starts

  // Start Telegram command polling
  setTimeout(() => {
    telegramBot.startTelegramCommandPolling();
  }, 35000); // Wait 35 seconds after server starts (after daily scheduler)
}

module.exports = app;
