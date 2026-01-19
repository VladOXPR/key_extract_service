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
  console.log('🔌 Using Cloud SQL Unix socket connection');
} else {
  poolConfig.host = process.env.DB_HOST || 'localhost';
  poolConfig.port = process.env.DB_PORT || 5432;
  console.log('🔌 Using TCP connection');
}

const pool = new Pool(poolConfig);

// Log connection configuration (without password)
console.log('🔌 Database connection config:', {
  host: poolConfig.host,
  user: poolConfig.user,
  database: poolConfig.database,
  port: poolConfig.port || 'N/A (Unix socket)'
});

// Test database connection
pool.on('connect', () => {
  console.log('✅ Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('❌ Unexpected error on idle client', err);
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
 * Helper function to send pop command to Relink API for a specific slot
 * @param {string} stationId - The station ID
 * @param {number} slot - The slot number (1-6)
 * @param {string} token - The authorization token
 * @param {boolean} isRetry - Whether this is a retry after token refresh
 * @returns {Promise<Object|null>} - Returns the response data or null if failed
 */
async function sendPopCommand(stationId, slot, token, isRetry = false) {
  try {
    const url = 'https://backend.energo.vip/api/command/sendCommandBySign';
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Referer': 'https://backend.energo.vip/device/list',
        'oid': '3526',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        cabinetId: stationId,
        rlSeq: 1,
        rlSlot: slot,
        commandSign: 'SendCompulsoryBorrowDevice'
      })
    });

    // If request fails and we haven't retried yet, refresh token and retry
    if (!response.ok && !isRetry) {
      console.log(`⚠️ Relink API error for pop command (station ${stationId}, slot ${slot}): ${response.status} ${response.statusText}. Attempting token refresh...`);
      
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
        return sendPopCommand(stationId, slot, newToken, true);
      } else {
        console.error(`Failed to refresh token for pop command (station ${stationId}, slot ${slot})`);
        return null;
      }
    }

    if (!response.ok) {
      console.error(`Relink API error for pop command (station ${stationId}, slot ${slot}) after retry: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json();
    return data;
  } catch (error) {
    // If it's a network/API error and we haven't retried, try refreshing token
    if (!isRetry && (error.message?.includes('fetch') || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT')) {
      console.log(`⚠️ Network error for pop command (station ${stationId}, slot ${slot}). Attempting token refresh...`);
      
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
        return sendPopCommand(stationId, slot, newToken, true);
      }
    }
    
    console.error(`Error sending pop command for station ${stationId}, slot ${slot}:`, error);
    return null;
  }
}

/**
 * GET /users
 * Fetch a list of all users
 */
router.get('/users', async (req, res) => {
  console.log('GET /users endpoint called');
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      'SELECT id, name, username, email, type, created_at, updated_at FROM users ORDER BY created_at DESC'
    );
    
    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    
    // Provide helpful error messages for common connection issues
    let errorMessage = error.message || 'Failed to fetch users';
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
 * GET /users/:id
 * Fetch single user data by id
 */
router.get('/users/:id', async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    
    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid UUID format'
      });
    }
    
    client = await pool.connect();
    const result = await client.query(
      'SELECT id, name, username, email, type, created_at, updated_at FROM users WHERE id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch user'
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

/**
 * POST /users
 * Create a new user
 */
router.post('/users', async (req, res) => {
  let client;
  try {
    const { name, username, email, password, type } = req.body;
    
    // Validate required fields
    if (!name || !username || !email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: name, username, email, and password are required'
      });
    }
    
    // Validate type if provided
    if (type && !['HOST', 'DISTRIBUTOR', 'ADMIN'].includes(type)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid type. Must be one of: HOST, DISTRIBUTOR, ADMIN'
      });
    }
    
    client = await pool.connect();
    
    // Insert new user (UUID will be generated by PostgreSQL if using uuid_generate_v4())
    const result = await client.query(
      `INSERT INTO users (name, username, email, password, type, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       RETURNING id, name, username, email, type, created_at, updated_at`,
      [name, username, email, password, type || 'HOST']
    );
    
    res.status(201).json({
      success: true,
      data: result.rows[0],
      message: 'User created successfully'
    });
  } catch (error) {
    console.error('Error creating user:', error);
    
    // Handle unique constraint violations
    if (error.code === '23505') { // PostgreSQL unique violation
      const field = error.constraint.includes('username') ? 'username' : 'email';
      return res.status(409).json({
        success: false,
        error: `${field.charAt(0).toUpperCase() + field.slice(1)} already exists`
      });
    }
    
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create user'
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

/**
 * DELETE /users/:id
 * Delete a user by id
 */
router.delete('/users/:id', async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    
    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid UUID format'
      });
    }
    
    client = await pool.connect();
    const result = await client.query(
      'DELETE FROM users WHERE id = $1 RETURNING id, name, username, email',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }
    
    res.json({
      success: true,
      message: 'User deleted successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete user'
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

/**
 * PATCH /users/:id
 * Update data for existing user
 */
router.patch('/users/:id', async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    const { name, username, email, password, type } = req.body;
    
    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid UUID format'
      });
    }
    
    // Check if at least one field is being updated
    if (!name && !username && !email && !password && !type) {
      return res.status(400).json({
        success: false,
        error: 'At least one field (name, username, email, password, type) must be provided'
      });
    }
    
    // Validate type if provided
    if (type && !['HOST', 'DISTRIBUTOR', 'ADMIN'].includes(type)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid type. Must be one of: HOST, DISTRIBUTOR, ADMIN'
      });
    }
    
    client = await pool.connect();
    
    // Build dynamic UPDATE query
    const updates = [];
    const values = [];
    let paramIndex = 1;
    
    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }
    if (username !== undefined) {
      updates.push(`username = $${paramIndex++}`);
      values.push(username);
    }
    if (email !== undefined) {
      updates.push(`email = $${paramIndex++}`);
      values.push(email);
    }
    if (password !== undefined) {
      updates.push(`password = $${paramIndex++}`);
      values.push(password);
    }
    if (type !== undefined) {
      updates.push(`type = $${paramIndex++}`);
      values.push(type);
    }
    
    // Always update updated_at
    updates.push(`updated_at = NOW()`);
    
    // Add id as the last parameter
    values.push(id);
    
    const query = `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING id, name, username, email, type, created_at, updated_at`;
    
    const result = await client.query(query, values);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0],
      message: 'User updated successfully'
    });
  } catch (error) {
    console.error('Error updating user:', error);
    
    // Handle unique constraint violations
    if (error.code === '23505') { // PostgreSQL unique violation
      const field = error.constraint.includes('username') ? 'username' : 'email';
      return res.status(409).json({
        success: false,
        error: `${field.charAt(0).toUpperCase() + field.slice(1)} already exists`
      });
    }
    
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update user'
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

/**
 * POST /pop/:station_id/all - Pop out all batteries from all slots (1-6)
 */
router.post('/pop/:station_id/all', async (req, res) => {
  console.log(`POST /pop/${req.params.station_id}/all endpoint called`);
  try {
    const { station_id } = req.params;
    
    // Get token from database
    const token = await getTokenFromDatabase();
    if (!token) {
      return res.status(503).json({
        success: false,
        error: 'Token not available. Please ensure token is set in database.'
      });
    }
    
    // Send pop commands for all 6 slots
    const data = [];
    
    for (let slot = 1; slot <= 6; slot++) {
      const result = await sendPopCommand(station_id, slot, token);
      if (result && result.borrowstatus) {
        data.push({
          slot: result.lockid || slot,
          manufacture_id: result.batteryid || ''
        });
      }
    }
    
    res.json({
      success: true,
      data: data,
      count: data.length
    });
  } catch (error) {
    console.error('Error popping all batteries:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to pop all batteries'
    });
  }
});

/**
 * POST /pop/:station_id/:slot - Pop out a battery from a specific slot
 */
router.post('/pop/:station_id/:slot', async (req, res) => {
  console.log(`POST /pop/${req.params.station_id}/${req.params.slot} endpoint called`);
  try {
    const { station_id, slot } = req.params;
    
    // Validate slot number (1-6)
    const slotNum = parseInt(slot);
    if (isNaN(slotNum) || slotNum < 1 || slotNum > 6) {
      return res.status(400).json({
        success: false,
        error: 'Invalid slot number. Must be between 1 and 6'
      });
    }
    
    // Get token from database
    const token = await getTokenFromDatabase();
    if (!token) {
      return res.status(503).json({
        success: false,
        error: 'Token not available. Please ensure token is set in database.'
      });
    }
    
    // Send pop command to Relink API
    const result = await sendPopCommand(station_id, slotNum, token);
    
    if (!result || !result.borrowstatus) {
      return res.status(500).json({
        success: false,
        error: 'Failed to send pop command to Relink API'
      });
    }
    
    res.json({
      success: true,
      data: [
        {
          slot: result.lockid || slotNum,
          manufacture_id: result.batteryid || ''
        }
      ],
      count: 1
    });
  } catch (error) {
    console.error('Error popping battery:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to pop battery'
    });
  }
});

// Log when router is loaded
console.log('📦 User service API router initialized with routes: GET, POST, PATCH, DELETE /users, POST /pop/:station_id/:slot, POST /pop/:station_id/all');

module.exports = router;

