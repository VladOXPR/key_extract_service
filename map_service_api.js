const express = require('express');
const { Pool } = require('pg');
const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '.env.local') });

const router = express.Router();
router.use(express.json());

// Database configuration (reusing same connection config as user service)
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

/**
 * GET /stations
 * Fetch a list of all stations
 */
router.get('/stations', async (req, res) => {
  console.log('GET /stations endpoint called');
  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      'SELECT id, title, latitude, longitude, updated_at FROM stations ORDER BY updated_at DESC'
    );
    
    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length
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
    
    client = await pool.connect();
    const result = await client.query(
      'SELECT id, title, latitude, longitude, updated_at FROM stations WHERE id = $1',
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
      data: result.rows[0]
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

