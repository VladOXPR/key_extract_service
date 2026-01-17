const express = require('express');
const { Pool } = require('pg');
const path = require('path');

// Add fetch for HTTP requests
let fetch;
if (typeof globalThis.fetch === 'undefined') {
  fetch = require('node-fetch');
} else {
  fetch = globalThis.fetch;
}

const router = express.Router();
router.use(express.json());

// Database configuration
const CLOUD_SQL_CONNECTION_NAME = process.env.CLOUD_SQL_CONNECTION_NAME || 'keyextract-482721:us-central1:cuub-db';
const DB_USER = process.env.DB_USER || 'postgres';
const DB_PASS = process.env.DB_PASS || '1Cuubllc!';
const DB_NAME = process.env.DB_NAME || 'postgres';

// Create connection pool
// For Cloud SQL, use Unix socket when running on Cloud Run
const poolConfig = {
  user: DB_USER,
  password: DB_PASS,
  database: DB_NAME,
};

const useCloudSql = process.env.CLOUD_SQL_CONNECTION_NAME || CLOUD_SQL_CONNECTION_NAME.includes(':');
if (useCloudSql) {
  poolConfig.host = `/cloudsql/${CLOUD_SQL_CONNECTION_NAME}`;
  console.log('🔌 Scan Service: Using Cloud SQL Unix socket connection');
} else {
  poolConfig.host = process.env.DB_HOST || 'localhost';
  poolConfig.port = process.env.DB_PORT || 5432;
  console.log('🔌 Scan Service: Using TCP connection');
}

const pool = new Pool(poolConfig);

// Log connection configuration (without password)
console.log('🔌 Scan Service: Database connection config:', {
  host: poolConfig.host,
  user: poolConfig.user,
  database: poolConfig.database,
  port: poolConfig.port || 'N/A (Unix socket)'
});

// Test database connection
pool.on('connect', () => {
  console.log('✅ Scan Service: Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('❌ Scan Service: Unexpected error on idle client', err);
});

// Token refresh lock to prevent concurrent token refresh requests
let tokenRefreshPromise = null;

/**
 * Helper function to get token from database
 */
async function getTokenFromDatabase() {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query('SELECT value FROM token LIMIT 1');
    if (result.rows.length === 0) {
      return null;
    }
    return result.rows[0].value;
  } catch (error) {
    console.error('Error fetching token from database:', error);
    return null;
  } finally {
    if (client) {
      client.release();
    }
  }
}

/**
 * Helper function to refresh token by calling the token endpoint
 * Uses promise-based locking to prevent concurrent refresh requests
 * @returns {Promise<string|null>} - Returns the new token or null if refresh failed
 */
async function refreshToken() {
  // If a token refresh is already in progress, wait for it and return the result
  if (tokenRefreshPromise) {
    console.log('⏳ Token refresh already in progress, waiting for existing refresh...');
    try {
      return await tokenRefreshPromise;
    } catch (error) {
      console.error('Error waiting for token refresh:', error);
      return null;
    }
  }
  
  // Create new refresh promise
  tokenRefreshPromise = (async () => {
    try {
      console.log('🔄 Token expired, refreshing token...');
      const response = await fetch('https://api.cuub.tech/token', {
        method: 'GET'
      });

      if (!response.ok) {
        console.error(`Token refresh failed: ${response.status} ${response.statusText}`);
        return null;
      }

      const data = await response.json();
      if (data.success && data.token) {
        console.log('✅ Token refreshed successfully');
        return data.token;
      }
      
      console.error('Token refresh response missing token:', data);
      return null;
    } catch (error) {
      console.error('Error refreshing token:', error);
      return null;
    } finally {
      // Clear the promise after a short delay to allow concurrent calls to see the result
      setTimeout(() => {
        tokenRefreshPromise = null;
      }, 2000);
    }
  })();
  
  const result = await tokenRefreshPromise;
  return result;
}

/**
 * Helper function to fetch order data from Relink API
 * @param {string} manufactureId - The manufacture ID (deviceid)
 * @param {string} token - The authorization token
 * @param {boolean} isRetry - Whether this is a retry after token refresh
 * @returns {Promise<{starttime: number|null, returnTime: number|null}>}
 */
async function getOrderData(manufactureId, token, isRetry = false) {
  try {
    const url = `https://backend.energo.vip/api/order?size=0&sort=id%2Cdesc&deviceid=${manufactureId}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Referer': 'https://backend.energo.vip/order/lease-order',
        'oid': '3526'
      }
    });

    // If request fails and we haven't retried yet, refresh token and retry
    if (!response.ok && !isRetry) {
      console.log(`⚠️ Relink API error for device ${manufactureId}: ${response.status} ${response.statusText}. Attempting token refresh...`);
      
      // Refresh the token
      const newToken = await refreshToken();
      
      if (newToken) {
        // Update token in database
        let dbClient;
        try {
          dbClient = await pool.connect();
          await dbClient.query('DELETE FROM token');
          await dbClient.query('INSERT INTO token (value) VALUES ($1)', [newToken]);
          console.log('✅ Updated token in database');
        } catch (dbError) {
          console.error('Error updating token in database:', dbError);
        } finally {
          if (dbClient) {
            dbClient.release();
          }
        }
        
        // Retry the request with new token
        return getOrderData(manufactureId, newToken, true);
      } else {
        console.error(`Failed to refresh token for device ${manufactureId}`);
        return { starttime: null, returnTime: null };
      }
    }

    if (!response.ok) {
      console.error(`Relink API error for device ${manufactureId} (after retry): ${response.status} ${response.statusText}`);
      return { starttime: null, returnTime: null };
    }

    const data = await response.json();
    
    // Extract data from the response
    // Looking for the first order in the content array
    if (data.content && data.content.length > 0) {
      const order = data.content[0];
      // Use endtime as returnTime if returnTime is 0 or missing
      const returnTimeValue = (order.returnTime && order.returnTime !== 0) ? order.returnTime : order.endtime;
      
      return {
        starttime: order.starttime || null,
        returnTime: returnTimeValue || null
      };
    }
    
    return { starttime: null, returnTime: null };
  } catch (error) {
    // If it's a network/API error and we haven't retried, try refreshing token
    if (!isRetry && (error.message?.includes('fetch') || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT')) {
      console.log(`⚠️ Network error for device ${manufactureId}. Attempting token refresh...`);
      
      const newToken = await refreshToken();
      
      if (newToken) {
        // Update token in database
        let dbClient;
        try {
          dbClient = await pool.connect();
          await dbClient.query('DELETE FROM token');
          await dbClient.query('INSERT INTO token (value) VALUES ($1)', [newToken]);
          console.log('✅ Updated token in database');
        } catch (dbError) {
          console.error('Error updating token in database:', dbError);
        } finally {
          if (dbClient) {
            dbClient.release();
          }
        }
        
        // Retry the request with new token
        return getOrderData(manufactureId, newToken, true);
      }
    }
    
    console.error(`Error fetching order data for device ${manufactureId}:`, error);
    return { starttime: null, returnTime: null };
  }
}

/**
 * GET /battery/:sticker_id
 * Fetch battery information by sticker_id
 */
router.get('/battery/:sticker_id', async (req, res) => {
  console.log(`GET /battery/${req.params.sticker_id} endpoint called`);
  let client;
  try {
    const { sticker_id } = req.params;

    if (!sticker_id) {
      return res.status(400).json({
        success: false,
        error: 'sticker_id is required'
      });
    }

    // Get token from database
    const token = await getTokenFromDatabase();
    if (!token) {
      console.warn('⚠️ No token found in database for Relink API calls');
      return res.status(503).json({
        success: false,
        error: 'Token not available. Please ensure token is set in database.'
      });
    }

    // Fetch battery data from database
    client = await pool.connect();
    const batteryResult = await client.query(
      'SELECT sticker_id, manufacture_id FROM battery WHERE sticker_id = $1',
      [sticker_id]
    );

    if (batteryResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Battery with sticker_id "${sticker_id}" not found`
      });
    }

    const battery = batteryResult.rows[0];
    const { manufacture_id } = battery;

    // Fetch order data from Relink API
    const orderData = await getOrderData(manufacture_id, token);

    // Build response
    const responseData = {
      manufacture_id: manufacture_id,
      sticker_id: sticker_id,
      startTime: orderData.starttime ? String(orderData.starttime) : null,
      returnTime: orderData.returnTime ? String(orderData.returnTime) : null
    };

    res.json({
      success: true,
      data: responseData
    });
  } catch (error) {
    console.error('Error fetching battery data:', error);
    
    // Provide helpful error messages for common connection issues
    let errorMessage = error.message || 'Failed to fetch battery data';
    let statusCode = 500;
    
    if (error.code === 'ECONNREFUSED' || error.message?.includes('ECONNREFUSED')) {
      errorMessage = 'Database connection refused. Please ensure: 1) Cloud SQL instance is added to Cloud Run service connections, 2) Service account has Cloud SQL Client role, 3) Cloud SQL Admin API is enabled.';
      statusCode = 503;
    } else if (error.message?.includes('NOT_AUTHORIZED') || error.message?.includes('permission')) {
      errorMessage = 'Database permission denied. Please ensure the Cloud Run service account has the "Cloud SQL Client" IAM role.';
      statusCode = 503;
    }
    
    res.status(statusCode).json({
      success: false,
      error: errorMessage,
      details: process.env.NODE_ENV !== 'production' ? {
        code: error.code,
        connectionName: CLOUD_SQL_CONNECTION_NAME
      } : undefined
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

module.exports = router;
