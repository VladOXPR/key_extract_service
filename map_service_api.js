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
  console.log('🔌 Map Service: Using Cloud SQL Unix socket connection');
} else {
  poolConfig.host = process.env.DB_HOST || 'localhost';
  poolConfig.port = process.env.DB_PORT || 5432;
  console.log('🔌 Map Service: Using TCP connection');
}

const pool = new Pool(poolConfig);

// Log connection configuration (without password)
console.log('🔌 Map Service: Database connection config:', {
  host: poolConfig.host,
  user: poolConfig.user,
  database: poolConfig.database,
  port: poolConfig.port || 'N/A (Unix socket)'
});

// Test database connection
pool.on('connect', () => {
  console.log('✅ Map Service: Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('❌ Map Service: Unexpected error on idle client', err);
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
 * Helper function to fetch battery availability from Relink API
 * @param {string} stationId - The station ID
 * @param {string} token - The authorization token
 * @param {boolean} isRetry - Whether this is a retry after token refresh
 * @returns {Promise<{filled_slots: number, open_slots: number}>}
 */
async function getBatteryAvailability(stationId, token, isRetry = false) {
  try {
    const url = `https://backend.energo.vip/api/cabinet?cabinetId=${stationId}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Referer': 'https://backend.energo.vip/device/list',
        'oid': '3526'
      }
    });

    // If request fails and we haven't retried yet, refresh token and retry
    if (!response.ok && !isRetry) {
      console.log(`⚠️ Relink API error for station ${stationId}: ${response.status} ${response.statusText}. Attempting token refresh...`);
      
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
        return getBatteryAvailability(stationId, newToken, true);
      } else {
        console.error(`Failed to refresh token for station ${stationId}`);
        return { filled_slots: null, open_slots: null };
      }
    }

    if (!response.ok) {
      console.error(`Relink API error for station ${stationId} (after retry): ${response.status} ${response.statusText}`);
      return { filled_slots: null, open_slots: null };
    }

    const data = await response.json();
    
    // Extract data from the response
    if (data.content && data.content.length > 0 && data.content[0].positionInfo) {
      const positionInfo = data.content[0].positionInfo;
      return {
        filled_slots: positionInfo.borrowNum || 0,  // borrowNum = slots with batteries
        open_slots: positionInfo.returnNum || 0      // returnNum = empty slots
      };
    }
    
    return { filled_slots: null, open_slots: null };
  } catch (error) {
    // If it's a network/API error and we haven't retried, try refreshing token
    if (!isRetry && (error.message?.includes('fetch') || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT')) {
      console.log(`⚠️ Network error for station ${stationId}. Attempting token refresh...`);
      
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
        return getBatteryAvailability(stationId, newToken, true);
      }
    }
    
    console.error(`Error fetching battery availability for station ${stationId}:`, error);
    return { filled_slots: null, open_slots: null };
  }
}

/**
 * GET /stations
 * Fetch a list of all stations
 */
router.get('/stations', async (req, res) => {
  console.log('GET /stations endpoint called');
  let client;
  try {
    // Get token from database
    const token = await getTokenFromDatabase();
    if (!token) {
      console.warn('⚠️ No token found in database for Relink API calls');
    }
    
    client = await pool.connect();
    const result = await client.query(
      'SELECT id, title, latitude, longitude, updated_at, address, screen_id, sim_id FROM stations ORDER BY updated_at DESC'
    );
    
    // Enrich each station with battery availability data
    const stationsWithBatteryInfo = await Promise.all(
      result.rows.map(async (station) => {
        if (token) {
          const batteryInfo = await getBatteryAvailability(station.id, token);
          return {
            ...station,
            filled_slots: batteryInfo.filled_slots,
            open_slots: batteryInfo.open_slots
          };
        } else {
          return {
            ...station,
            filled_slots: null,
            open_slots: null
          };
        }
      })
    );
    
    res.json({
      success: true,
      data: stationsWithBatteryInfo,
      count: stationsWithBatteryInfo.length
    });
  } catch (error) {
    console.error('Error fetching stations:', error);
    
    // Provide helpful error messages for common connection issues
    let errorMessage = error.message || 'Failed to fetch stations';
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

/**
 * GET /stations/:id
 * Fetch single station data by id
 */
router.get('/stations/:id', async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    
    // Validate id is provided and not empty
    if (!id || id.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Station ID is required'
      });
    }
    
    // Get token from database
    const token = await getTokenFromDatabase();
    
    client = await pool.connect();
    const result = await client.query(
      'SELECT id, title, latitude, longitude, updated_at, address, screen_id, sim_id FROM stations WHERE id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Station not found'
      });
    }
    
    // Enrich station with battery availability data
    let station = result.rows[0];
    if (token) {
      const batteryInfo = await getBatteryAvailability(id, token);
      station = {
        ...station,
        filled_slots: batteryInfo.filled_slots,
        open_slots: batteryInfo.open_slots
      };
    } else {
      station = {
        ...station,
        filled_slots: null,
        open_slots: null
      };
    }
    
    res.json({
      success: true,
      data: station
    });
  } catch (error) {
    console.error('Error fetching station:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch station'
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

/**
 * Helper function to convert array of objects to CSV string
 */
function arrayToCSV(data, headers) {
  if (!data || data.length === 0) {
    return headers.join(',') + '\n';
  }

  // Create CSV header row
  const csvRows = [headers.join(',')];

  // Create CSV data rows
  for (const row of data) {
    const values = headers.map(header => {
      const value = row[header];
      // Handle null/undefined values
      if (value === null || value === undefined) {
        return '';
      }
      // Escape commas and quotes in string values
      const stringValue = String(value);
      if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
        return `"${stringValue.replace(/"/g, '""')}"`;
      }
      return stringValue;
    });
    csvRows.push(values.join(','));
  }

  return csvRows.join('\n');
}

/**
 * GET /stations/export
 * Export stations list as CSV file
 */
router.get('/stations/export', async (req, res) => {
  console.log('GET /stations/export endpoint called');
  let client;
  try {
    // Get token from database
    const token = await getTokenFromDatabase();
    if (!token) {
      console.warn('⚠️ No token found in database for Relink API calls');
    }
    
    client = await pool.connect();
    const result = await client.query(
      'SELECT id, title, latitude, longitude, updated_at, address, screen_id, sim_id FROM stations ORDER BY updated_at DESC'
    );
    
    // Enrich each station with battery availability data
    const stationsWithBatteryInfo = await Promise.all(
      result.rows.map(async (station) => {
        if (token) {
          const batteryInfo = await getBatteryAvailability(station.id, token);
          return {
            ...station,
            filled_slots: batteryInfo.filled_slots,
            open_slots: batteryInfo.open_slots
          };
        } else {
          return {
            ...station,
            filled_slots: null,
            open_slots: null
          };
        }
      })
    );
    
    // Generate filename with current date (YYYY-MM-DD format for filename safety)
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const filename = `stations_${year}-${month}-${day}.csv`;
    
    // Define CSV headers
    const csvHeaders = [
      'id',
      'title',
      'latitude',
      'longitude',
      'updated_at',
      'address',
      'screen_id',
      'sim_id',
      'filled_slots',
      'open_slots'
    ];
    
    // Convert data to CSV
    const csvContent = arrayToCSV(stationsWithBatteryInfo, csvHeaders);
    
    // Set headers for CSV download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', Buffer.byteLength(csvContent, 'utf8'));
    
    // Send CSV file
    res.send(csvContent);
    
    console.log(`✅ Exported ${stationsWithBatteryInfo.length} stations to ${filename}`);
  } catch (error) {
    console.error('Error exporting stations:', error);
    
    // Provide helpful error messages for common connection issues
    let errorMessage = error.message || 'Failed to export stations';
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

/**
 * POST /stations
 * Create a new station
 */
router.post('/stations', async (req, res) => {
  let client;
  try {
    const { id, title, latitude, longitude } = req.body;
    
    // Validate required fields
    if (!id || id.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Station ID is required'
      });
    }
    
    if (!title || title.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Title is required'
      });
    }
    
    if (latitude === undefined || latitude === null) {
      return res.status(400).json({
        success: false,
        error: 'Latitude is required'
      });
    }
    
    if (longitude === undefined || longitude === null) {
      return res.status(400).json({
        success: false,
        error: 'Longitude is required'
      });
    }
    
    // Validate latitude range (-90 to 90)
    const latNum = parseFloat(latitude);
    if (isNaN(latNum) || latNum < -90 || latNum > 90) {
      return res.status(400).json({
        success: false,
        error: 'Latitude must be a number between -90 and 90'
      });
    }
    
    // Validate longitude range (-180 to 180)
    const lngNum = parseFloat(longitude);
    if (isNaN(lngNum) || lngNum < -180 || lngNum > 180) {
      return res.status(400).json({
        success: false,
        error: 'Longitude must be a number between -180 and 180'
      });
    }
    
    client = await pool.connect();
    
    // Insert new station
    const result = await client.query(
      `INSERT INTO stations (id, title, latitude, longitude, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id, title, latitude, longitude, updated_at`,
      [id, title, latNum, lngNum]
    );
    
    res.status(201).json({
      success: true,
      data: result.rows[0],
      message: 'Station created successfully'
    });
  } catch (error) {
    console.error('Error creating station:', error);
    
    // Handle unique constraint violations
    if (error.code === '23505') { // PostgreSQL unique violation
      return res.status(409).json({
        success: false,
        error: 'Station with this ID already exists'
      });
    }
    
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create station'
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

/**
 * DELETE /stations/:id
 * Delete a station by id
 */
router.delete('/stations/:id', async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    
    // Validate id is provided and not empty
    if (!id || id.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Station ID is required'
      });
    }
    
    client = await pool.connect();
    const result = await client.query(
      'DELETE FROM stations WHERE id = $1 RETURNING id, title, latitude, longitude',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Station not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Station deleted successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error deleting station:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete station'
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

/**
 * PATCH /stations/:id
 * Update data for existing station
 */
router.patch('/stations/:id', async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    const { title, latitude, longitude } = req.body;
    
    // Validate id is provided and not empty
    if (!id || id.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Station ID is required'
      });
    }
    
    // Check if at least one field is being updated
    if (title === undefined && latitude === undefined && longitude === undefined) {
      return res.status(400).json({
        success: false,
        error: 'At least one field (title, latitude, longitude) must be provided'
      });
    }
    
    // Validate latitude if provided
    if (latitude !== undefined && latitude !== null) {
      const latNum = parseFloat(latitude);
      if (isNaN(latNum) || latNum < -90 || latNum > 90) {
        return res.status(400).json({
          success: false,
          error: 'Latitude must be a number between -90 and 90'
        });
      }
    }
    
    // Validate longitude if provided
    if (longitude !== undefined && longitude !== null) {
      const lngNum = parseFloat(longitude);
      if (isNaN(lngNum) || lngNum < -180 || lngNum > 180) {
        return res.status(400).json({
          success: false,
          error: 'Longitude must be a number between -180 and 180'
        });
      }
    }
    
    client = await pool.connect();
    
    // Build dynamic UPDATE query
    const updates = [];
    const values = [];
    let paramIndex = 1;
    
    if (title !== undefined) {
      if (title.trim() === '') {
        return res.status(400).json({
          success: false,
          error: 'Title cannot be empty'
        });
      }
      updates.push(`title = $${paramIndex++}`);
      values.push(title);
    }
    if (latitude !== undefined && latitude !== null) {
      updates.push(`latitude = $${paramIndex++}`);
      values.push(parseFloat(latitude));
    }
    if (longitude !== undefined && longitude !== null) {
      updates.push(`longitude = $${paramIndex++}`);
      values.push(parseFloat(longitude));
    }
    
    // Always update updated_at
    updates.push(`updated_at = NOW()`);
    
    // Add id as the last parameter
    values.push(id);
    
    const query = `UPDATE stations SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING id, title, latitude, longitude, updated_at`;
    
    const result = await client.query(query, values);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Station not found'
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0],
      message: 'Station updated successfully'
    });
  } catch (error) {
    console.error('Error updating station:', error);
    
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update station'
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Log when router is loaded
console.log('📦 Map service API router initialized with routes: GET, POST, PATCH, DELETE /stations');

module.exports = router;

