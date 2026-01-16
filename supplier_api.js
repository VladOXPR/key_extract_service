const { Pool } = require('pg');
const { loginToEnergo, closeBrowser } = require('./energoLogin');
const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '.env.local') });

// Database configuration (reusing same connection config)
const CLOUD_SQL_CONNECTION_NAME = process.env.CLOUD_SQL_CONNECTION_NAME || 'keyextract-482721:us-central1:cuub-db';
const DB_USER = process.env.DB_USER || 'postgres';
const DB_PASS = process.env.DB_PASS || '1Cuubllc!';
const DB_NAME = process.env.DB_NAME || 'postgres';

// Create connection pool for token operations
const poolConfig = {
  user: DB_USER,
  password: DB_PASS,
  database: DB_NAME,
};

const useCloudSql = process.env.CLOUD_SQL_CONNECTION_NAME || CLOUD_SQL_CONNECTION_NAME.includes(':');
if (useCloudSql) {
  poolConfig.host = `/cloudsql/${CLOUD_SQL_CONNECTION_NAME}`;
} else {
  poolConfig.host = process.env.DB_HOST || 'localhost';
  poolConfig.port = process.env.DB_PORT || 5432;
}

const pool = new Pool(poolConfig);

// Add fetch for Node.js if not available
let fetch;
if (typeof globalThis.fetch === 'undefined') {
  fetch = require('node-fetch');
} else {
  fetch = globalThis.fetch;
}

/**
 * Get token from the token table in database
 * @returns {Promise<string|null>} The token or null if not found
 */
async function getTokenFromDatabase() {
  let client;
  try {
    client = await pool.connect();
    const result = await client.query('SELECT value FROM token LIMIT 1');
    
    if (result.rows.length > 0 && result.rows[0].value) {
      return result.rows[0].value.trim();
    }
    return null;
  } catch (error) {
    console.error('Error getting token from database:', error);
    return null;
  } finally {
    if (client) {
      client.release();
    }
  }
}

/**
 * Update token in the token table
 * @param {string} newToken - The new token to store
 * @returns {Promise<boolean>} True if successful, false otherwise
 */
async function updateTokenInDatabase(newToken) {
  let client;
  try {
    client = await pool.connect();
    
    // Check if a row exists
    const checkResult = await client.query('SELECT COUNT(*) FROM token');
    const rowCount = parseInt(checkResult.rows[0].count);
    
    if (rowCount > 0) {
      // Update existing row
      await client.query('UPDATE token SET value = $1', [newToken]);
    } else {
      // Insert new row
      await client.query('INSERT INTO token (value) VALUES ($1)', [newToken]);
    }
    
    console.log('✅ Token updated in database');
    return true;
  } catch (error) {
    console.error('Error updating token in database:', error);
    return false;
  } finally {
    if (client) {
      client.release();
    }
  }
}

/**
 * Get a new token by running the energoLogin script
 * @returns {Promise<string|null>} The new token or null if failed
 */
async function refreshToken() {
  try {
    console.log('🔄 Refreshing token via energoLogin...');
    
    // Get credentials from environment variables
    const username = process.env.ENERGO_USERNAME;
    const password = process.env.ENERGO_PASSWORD;
    const openaiApiKey = process.env.OPENAI_API_KEY;
    
    if (!username || !password) {
      console.error('❌ ENERGO_USERNAME and ENERGO_PASSWORD environment variables are required');
      return null;
    }
    
    if (!openaiApiKey) {
      console.error('❌ OPENAI_API_KEY environment variable is required');
      return null;
    }
    
    // Perform login to get the token
    let loginResult;
    try {
      loginResult = await loginToEnergo({
        username: username,
        password: password,
        captcha: undefined, // Will be solved using OpenAI
        openaiApiKey: openaiApiKey,
        headless: true, // Run in headless mode for server
        timeout: 30000
      });
    } catch (loginError) {
      console.error('❌ Error during energoLogin:', loginError.message);
      console.error('❌ Login error stack:', loginError.stack);
      return null;
    } finally {
      // Always try to close browser, even if there was an error
      if (loginResult && loginResult.browser) {
        try {
          await closeBrowser(loginResult);
        } catch (closeError) {
          console.warn('⚠️ Error closing browser:', closeError.message);
        }
      }
    }
    
    if (!loginResult || !loginResult.success || !loginResult.token) {
      console.error('❌ Failed to get token from energoLogin');
      if (loginResult) {
        console.error('Login result:', { success: loginResult.success, hasToken: !!loginResult.token });
      }
      return null;
    }
    
    console.log('✅ Successfully obtained new token');
    
    // Update token in database
    const updateSuccess = await updateTokenInDatabase(loginResult.token);
    if (!updateSuccess) {
      console.error('❌ Failed to update token in database, but token was obtained');
    }
    
    return loginResult.token;
  } catch (error) {
    console.error('❌ Error refreshing token:', error.message);
    console.error('❌ Error stack:', error.stack);
    return null;
  }
}

/**
 * Get station battery availability from Relink API
 * @param {string} stationId - The station ID (cabinetId)
 * @param {string} token - The authorization token
 * @returns {Promise<Object|null>} The API response or null if failed. Returns {error: 'unauthorized'} for 401/403
 */
async function getStationInfoFromRelink(stationId, token) {
  try {
    const url = `https://backend.energo.vip/api/cabinet?cabinetId=${encodeURIComponent(stationId)}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Referer': 'https://backend.energo.vip/device/list',
        'oid': '3526',
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      // Check if it's an authentication error
      if (response.status === 401 || response.status === 403) {
        console.error(`❌ Relink API unauthorized error (${response.status}): Token may be invalid for station ${stationId}`);
        return { error: 'unauthorized' };
      }
      const errorText = await response.text().catch(() => 'Unable to read error response');
      console.error(`❌ Relink API error for station ${stationId}: ${response.status} ${response.statusText} - ${errorText}`);
      return null;
    }
    
    const data = await response.json();
    console.log(`✅ Relink API call successful for station ${stationId}, response has ${data.content?.length || 0} items`);
    return data;
  } catch (error) {
    console.error('❌ Error calling Relink API:', error);
    return null;
  }
}

/**
 * Get station slot information (Open Slots and Filled Slots) from Relink API
 * Handles token refresh if API call fails
 * @param {string} stationId - The station ID (cabinetId)
 * @param {boolean} retryOnFailure - Whether to retry after token refresh if failed (default: true)
 * @returns {Promise<Object|null>} Object with openSlots and filledSlots, or null if failed
 */
async function getStationSlots(stationId, retryOnFailure = true) {
  try {
    // Get token from database
    let token = await getTokenFromDatabase();
    
    if (!token) {
      console.log(`⚠️ No token found in database for station ${stationId}, attempting to get new token...`);
      token = await refreshToken();
      if (!token) {
        console.error(`❌ Failed to get token for station ${stationId}, cannot fetch slot info`);
        // Return default values instead of null so the request can still complete
        return {
          openSlots: 0,
          filledSlots: 0
        };
      }
      console.log(`✅ New token obtained for station ${stationId}`);
    } else {
      console.log(`✅ Using existing token from database for station ${stationId}`);
    }
    
    // First attempt to get station info
    console.log(`🔍 Fetching slot info for station ${stationId}...`);
    let stationInfo = await getStationInfoFromRelink(stationId, token);
    
    // Only refresh token if the API call specifically failed due to authentication (401/403)
    // For other errors (network, 404, 500, etc.), don't refresh token
    if (stationInfo && stationInfo.error === 'unauthorized' && retryOnFailure) {
      console.log(`⚠️ Relink API returned unauthorized for ${stationId}, refreshing token and retrying...`);
      token = await refreshToken();
      
      if (token) {
        console.log(`✅ Token refreshed successfully, retrying API call for ${stationId}...`);
        // Retry with new token
        stationInfo = await getStationInfoFromRelink(stationId, token);
      } else {
        console.error(`❌ Failed to refresh token, cannot retry for ${stationId}`);
      }
    }
    
    // Log the response for debugging
    if (!stationInfo) {
      console.warn(`⚠️ Relink API returned null/undefined for station ${stationId}`);
    } else if (stationInfo.error) {
      console.warn(`⚠️ Relink API returned error for station ${stationId}: ${stationInfo.error}`);
    } else if (!stationInfo.content || stationInfo.content.length === 0) {
      console.warn(`⚠️ Relink API returned empty content for station ${stationId}`);
    }
    
    // Parse the response to get slot information
    if (stationInfo && stationInfo.content && stationInfo.content.length > 0) {
      const positionInfo = stationInfo.content[0].positionInfo;
      
      if (positionInfo) {
        const slots = {
          openSlots: positionInfo.returnNum || 0,
          filledSlots: positionInfo.borrowNum || 0
        };
        console.log(`✅ Successfully retrieved slots for ${stationId}: Open=${slots.openSlots}, Filled=${slots.filledSlots}`);
        return slots;
      } else {
        console.warn(`⚠️ No positionInfo found in response for station ${stationId}`);
      }
    }
    
    console.warn(`⚠️ No position info found for station ${stationId}, returning defaults (0, 0)`);
    return {
      openSlots: 0,
      filledSlots: 0
    };
  } catch (error) {
    console.error(`❌ Error getting station slots for ${stationId}:`, error);
    return null;
  }
}

module.exports = {
  getTokenFromDatabase,
  updateTokenInDatabase,
  refreshToken,
  getStationInfoFromRelink,
  getStationSlots
};

