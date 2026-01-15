const express = require('express');
const { Pool } = require('pg');
const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '.env.local') });

const router = express.Router();
router.use(express.json());

// Database configuration
const CLOUD_SQL_CONNECTION_NAME = process.env.CLOUD_SQL_CONNECTION_NAME || 'keyextract-482721:us-central1:cuub-db';
const DB_USER = process.env.DB_USER || 'postgres';
const DB_PASS = process.env.DB_PASS || '1Cuubllc!';
const DB_NAME = process.env.DB_NAME || 'cuub-db';

// Create connection pool
// For Cloud SQL, use Unix socket when running on Cloud Run
const poolConfig = {
  user: DB_USER,
  password: DB_PASS,
  database: DB_NAME,
};

// Check if we're running on Cloud Run (has Cloud SQL connection)
// NOTE: For Cloud Run to connect to Cloud SQL, you must:
// 1. Add Cloud SQL instance to Cloud Run service: Edit service -> Connections -> Add Cloud SQL connection
// 2. Grant service account the "Cloud SQL Client" role (roles/cloudsql.client)
// 3. Ensure Cloud SQL Admin API is enabled
if (process.env.CLOUD_SQL_CONNECTION_NAME || CLOUD_SQL_CONNECTION_NAME.includes(':')) {
  // Use Unix socket for Cloud SQL on Cloud Run
  // pg library automatically appends .s.PGSQL.5432 for PostgreSQL
  poolConfig.host = `/cloudsql/${CLOUD_SQL_CONNECTION_NAME}`;
} else {
  // For local development, use standard connection
  // You may need to set DB_HOST and DB_PORT environment variables
  poolConfig.host = process.env.DB_HOST || 'localhost';
  poolConfig.port = process.env.DB_PORT || 5432;
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
  // Don't exit process - let it continue and log the error
  // The routes will handle connection errors gracefully
});

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
      statusCode = 503; // Service Unavailable
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

// Log when router is loaded
console.log('📦 User service API router initialized with routes: GET, POST, PATCH, DELETE /users');

module.exports = router;

