const express = require('express');
const { loginToEnergo, closeBrowser } = require('./energoLogin');
const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '.env.local') });

const app = express();
const PORT = process.env.PORT || 8080;

/**
 * GET endpoint to retrieve the Energo API token
 * Returns a JSON response with the token
 */
app.get('/token', async (req, res) => {
    let loginResult = null;
    
    try {
        // Get credentials from environment variables
        const username = process.env.ENERGO_USERNAME;
        const password = process.env.ENERGO_PASSWORD;
        const openaiApiKey = process.env.OPENAI_API_KEY;
        
        // Validate required environment variables
        if (!username || !password) {
            return res.status(500).json({
                success: false,
                error: 'ENERGO_USERNAME and ENERGO_PASSWORD environment variables are required'
            });
        }
        
        if (!openaiApiKey) {
            return res.status(500).json({
                success: false,
                error: 'OPENAI_API_KEY environment variable is required'
            });
        }
        
        // Perform login to get the token
        loginResult = await loginToEnergo({
            username: username,
            password: password,
            captcha: undefined, // Will be solved using OpenAI
            openaiApiKey: openaiApiKey,
            headless: true, // Run in headless mode for server
            timeout: 30000
        });
        
        // Check if login was successful
        if (!loginResult.success) {
            return res.status(401).json({
                success: false,
                error: 'Login failed. Please check credentials.',
                url: loginResult.url,
                title: loginResult.title
            });
        }
        
        // Check if token was captured
        if (!loginResult.token) {
            return res.status(500).json({
                success: false,
                error: 'Token was not captured. The login may have succeeded but the API token was not found.',
                url: loginResult.url
            });
        }
        
        // Return the token as JSON
        return res.json({
            success: true,
            token: loginResult.token
        });
        
    } catch (error) {
        console.error('Error in /token endpoint:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'An error occurred while retrieving the token'
        });
    } finally {
        // Always close the browser to free up resources
        if (loginResult) {
            try {
                await closeBrowser(loginResult);
            } catch (closeError) {
                console.error('Error closing browser:', closeError);
            }
        }
    }
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'energo-token-extractor'
    });
});

// Start the server
app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
    console.log(`📡 GET endpoint available at: http://localhost:${PORT}/token`);
    console.log(`❤️  Health check available at: http://localhost:${PORT}/health`);
});

module.exports = app;
