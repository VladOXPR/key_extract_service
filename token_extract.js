// Use puppeteer-core for Vercel compatibility (doesn't bundle Chromium)
// On Vercel, we'll use @sparticuz/chromium
// Check if we're on Vercel/serverless environment
const isVercel = process.env.VERCEL === '1' || process.env.VERCEL_ENV;
let puppeteer;

// Cache for Chromium executable path to avoid repeated extraction
let cachedChromiumPath = null;

if (isVercel) {
  // On Vercel, use puppeteer-core with @sparticuz/chromium
  try {
    puppeteer = require('puppeteer-core');
  } catch (e) {
    // Fallback to regular puppeteer if puppeteer-core not available
    console.warn('⚠️  puppeteer-core not available, using puppeteer:', e.message);
    puppeteer = require('puppeteer');
  }
} else {
  // Local development, use regular puppeteer
  puppeteer = require('puppeteer');
}

const path = require('path');

// Load environment variables for local development
// This ensures OPENAI_API_KEY, ENERGO_USERNAME, and ENERGO_PASSWORD are available when running locally
try {
    // Try loading .env from current directory first
    require('dotenv').config({ path: path.join(__dirname, '.env') });
    // Also try .env.local if it exists (for backwards compatibility)
    require('dotenv').config({ path: path.join(__dirname, '.env.local') });
} catch (error) {
    // dotenv might not be available or .env files don't exist, that's okay
    // Environment variables will come from process.env (set by parent module or system)
}

// Add fetch for Node.js
let fetch;
if (typeof globalThis.fetch === 'undefined') {
    fetch = require('node-fetch');
} else {
    fetch = globalThis.fetch;
}

// ========================================
// CONFIGURATION
// ========================================
// OpenAI API key is loaded from OPENAI_API_KEY environment variable
// Set it in Vercel dashboard or .env.local for local development

// Browser preview mode
// Set to false to see the browser window, true to run in headless mode (no browser window)
const SHOW_BROWSER_PREVIEW = true;

/**
 * Helper function to wait/sleep (replacement for deprecated page.waitForTimeout)
 * @param {number} milliseconds - Time to wait in milliseconds
 * @returns {Promise<void>}
 */
function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/**
 * Solve captcha using OpenAI Vision API
 * The captcha is a simple math problem in format: number operator number = ?
 * @param {string} imageBase64 - Base64 encoded image data (with or without data URL prefix)
 * @param {string} openaiApiKey - OpenAI API key
 * @returns {Promise<string>} - The numeric answer to the math problem
 */
async function solveCaptchaWithOpenAI(imageBase64, openaiApiKey) {
    try {
        // Remove data URL prefix if present
        const base64Data = imageBase64.includes(',') 
            ? imageBase64.split(',')[1] 
            : imageBase64;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${openaiApiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-4o', // or 'gpt-4o-mini' for faster/cheaper
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: 'This is a captcha image showing a simple math problem. The format is: number operator number = ? (where operator can be +, -, *, or /). Solve the math problem and respond with ONLY the numeric answer (the number that should replace the ?). Do not include any explanation, spaces, or additional characters - just the number.'
                            },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: `data:image/png;base64,${base64Data}`
                                }
                            }
                        ]
                    }
                ],
                max_tokens: 10 // Math answers are usually short
            })
        });

        if (!response.ok) {
            const errorData = await response.text();
            throw new Error(`OpenAI API error: ${response.status} ${response.statusText} - ${errorData}`);
        }

        const data = await response.json();
        const captchaCode = data.choices[0].message.content.trim();
        
        console.log(`OpenAI solved captcha: ${captchaCode}`);
        return captchaCode;
    } catch (error) {
        console.error('Error solving captcha with OpenAI:', error);
        throw error;
    }
}

/**
 * Extract captcha image from the page
 * @param {Object} page - Puppeteer page object
 * @returns {Promise<string>} - Base64 image data URL
 */
async function extractCaptchaImage(page) {
    console.log('Waiting for captcha image to load...');
    // Wait longer for the captcha image to load
    await delay(2000);

    // First, check all img elements for base64 data URLs (most reliable)
    try {
        const allImageData = await page.evaluate(() => {
            const images = Array.from(document.querySelectorAll('img'));
            return images.map(img => ({
                src: img.src,
                id: img.id,
                className: img.className,
                alt: img.alt
            })).filter(imgData => imgData.src && imgData.src.startsWith('data:image'));
        });
        
        if (allImageData.length > 0) {
            // Get the last one (most recent, as user mentioned it's the last GET request)
            const lastImage = allImageData[allImageData.length - 1];
            console.log(`Found captcha image from page (last base64 image): ${lastImage.src.substring(0, 50)}...`);
            return lastImage.src;
        }
        console.log(`Found ${allImageData.length} base64 images, checking all images...`);
    } catch (e) {
        console.log('Error evaluating page for base64 images:', e.message);
    }

    // Try to find captcha image element with various selectors
    const imageSelectors = [
        'img[src*="captcha" i]',
        'img[id*="captcha" i]',
        'img[class*="captcha" i]',
        'img[alt*="captcha" i]',
        'img[src*="data:image"]',
        'img'
    ];

    let captchaImage = null;
    let imageSrc = null;

    for (const selector of imageSelectors) {
        try {
            const images = await page.$$(selector);
            console.log(`Checking ${images.length} images with selector: ${selector}`);
            for (const img of images) {
                const src = await page.evaluate(el => el.src, img);
                // Check if it's a base64 data URL or contains captcha
                if (src && (src.startsWith('data:image') || src.toLowerCase().includes('captcha'))) {
                    captchaImage = img;
                    imageSrc = src;
                    console.log(`Found captcha image element with selector: ${selector}`);
                    if (imageSrc.startsWith('data:image')) {
                        return imageSrc;
                    }
                    break;
                }
            }
            if (captchaImage && imageSrc && imageSrc.startsWith('data:image')) break;
        } catch (e) {
            console.log(`Error with selector ${selector}:`, e.message);
        }
    }

    // If we found an image with data URL, use it directly
    if (imageSrc && imageSrc.startsWith('data:image')) {
        return imageSrc;
    }

    // Otherwise, try to get the image as base64 by taking a screenshot of it
    if (captchaImage) {
        try {
            console.log('Attempting to screenshot captcha image element...');
            const base64 = await captchaImage.screenshot({ encoding: 'base64' });
            return `data:image/png;base64,${base64}`;
        } catch (e) {
            console.log('Could not screenshot captcha image element:', e.message);
        }
    }

    // Debug: Log all images on the page
    try {
        const allImages = await page.evaluate(() => {
            const images = Array.from(document.querySelectorAll('img'));
            return images.map(img => ({
                src: img.src ? img.src.substring(0, 100) : 'no src',
                id: img.id || 'no id',
                className: img.className || 'no class'
            }));
        });
        console.log('All images on page:', JSON.stringify(allImages, null, 2));
    } catch (e) {
        console.log('Error logging all images:', e.message);
    }

    throw new Error('Could not find captcha image on the page');
}

/**
 * Login to Energo dashboard using Puppeteer
 * @param {Object} options - Login options
 * @param {string} options.username - Username for login
 * @param {string} options.password - Password for login
 * @param {string} [options.captcha] - Optional captcha code. If not provided, will be solved using OpenAI API
 * @param {string} [options.openaiApiKey] - OpenAI API key for captcha solving (uses OPENAI_API_KEY env var if not provided)
 * @param {boolean} [options.headless=true] - Run browser in headless mode
 * @param {number} [options.timeout=30000] - Timeout in milliseconds
 * @returns {Promise<Object>} - Returns session info including cookies and browser instance
 */
async function loginToEnergo({ username, password, captcha, openaiApiKey, headless = true, timeout = 30000 }) {
    let browser = null;
    
    try {
        // Configure browser launch options
        const launchOptions = {
            headless: headless,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--single-process', '--disable-gpu']
        };
        
        // On Vercel, use @sparticuz/chromium
        if (isVercel) {
            try {
                const chromium = require('@sparticuz/chromium');
                // Use cached path if available, otherwise get it (cache to avoid repeated extraction)
                if (!cachedChromiumPath) {
                    const executablePath = chromium.executablePath();
                    if (executablePath instanceof Promise) {
                        cachedChromiumPath = await executablePath;
                    } else {
                        cachedChromiumPath = executablePath;
                    }
                }
                launchOptions.executablePath = cachedChromiumPath;
                // Add additional args for serverless
                launchOptions.args = [
                    ...launchOptions.args,
                    ...(chromium.args || []),
                    '--disable-web-security',
                    '--disable-features=IsolateOrigins,site-per-process'
                ];
                console.log('✅ Using @sparticuz/chromium for Vercel environment');
            } catch (chromiumError) {
                console.warn('⚠️  @sparticuz/chromium not available, trying default puppeteer:', chromiumError.message);
                // Continue with default puppeteer (might fail on Vercel)
            }
        } else if (process.env.PUPPETEER_EXECUTABLE_PATH) {
            // Cloud Run or other container: use system Chromium from Dockerfile
            launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
            console.log('✅ Using system Chromium from PUPPETEER_EXECUTABLE_PATH');
        }
        
        // Launch browser with retry logic for ETXTBSY errors
        let retries = 3;
        let launchError = null;
        
        while (retries > 0) {
            try {
                browser = await puppeteer.launch(launchOptions);
                break; // Success, exit retry loop
            } catch (error) {
                launchError = error;
                const errorMsg = error.message || '';
                
                // Check if it's an ETXTBSY error (file busy) or similar spawn errors
                if ((errorMsg.includes('ETXTBSY') || errorMsg.includes('spawn') || errorMsg.includes('EAGAIN')) && retries > 1) {
                    retries--;
                    const waitTime = (4 - retries) * 1000; // Exponential backoff: 1s, 2s, 3s
                    console.warn(`⚠️  Browser launch error (${errorMsg}), retrying in ${waitTime}ms... (${retries} retries left)`);
                    await delay(waitTime);
                    continue;
                }
                
                // If it's not a retryable error or we're out of retries, throw
                throw error;
            }
        }
        
        // If we exhausted retries, throw the last error
        if (!browser && launchError) {
            throw launchError;
        }

        const page = await browser.newPage();
        
        // Set viewport
        await page.setViewport({ width: 1280, height: 720 });
        
        // Set up network monitoring to capture authorization token
        let capturedToken = null;
        let tokenPromiseResolve = null;
        const tokenPromise = new Promise((resolve) => {
            tokenPromiseResolve = resolve;
        });
        
        page.on('request', (request) => {
            const url = request.url();
            // Check if this is the cabinet API endpoint
            if (url.includes('/api/cabinet') && url.includes('sort=isOnline')) {
                const headers = request.headers();
                const authHeader = headers['authorization'] || headers['Authorization'];
                if (authHeader && authHeader.startsWith('Bearer ')) {
                    capturedToken = authHeader.replace('Bearer ', '');
                    console.log('\n=== AUTHORIZATION TOKEN CAPTURED ===');
                    console.log('Token:', capturedToken);
                    console.log('=====================================\n');
                    if (tokenPromiseResolve) {
                        tokenPromiseResolve(capturedToken);
                    }
                }
            }
        });
        
        // Navigate to login page
        console.log('Navigating to login page...');
        await page.goto('https://backend.energo.vip/login', {
            waitUntil: 'networkidle2',
            timeout: timeout
        });

        // Wait for the login form to be visible
        await page.waitForSelector('input[type="text"], input[type="email"], input[name*="username"], input[name*="user"], input[id*="username"], input[id*="user"]', { timeout: timeout });
        
        // Wait a bit more for captcha image to load (it might load dynamically)
        console.log('Waiting for page to fully load (including captcha image)...');
        await delay(2000);
        
        // Find and fill username field
        console.log('Filling username...');
        const usernameField = await page.$('input[type="text"], input[type="email"], input[name*="username"], input[name*="user"], input[id*="username"], input[id*="user"], input[placeholder*="username" i], input[placeholder*="user" i]');
        if (usernameField) {
            await usernameField.click({ clickCount: 3 }); // Select all if there's existing text
            await usernameField.type(username, { delay: 50 });
        } else {
            throw new Error('Username field not found');
        }

        // Find and fill password field
        console.log('Filling password...');
        const passwordField = await page.$('input[type="password"], input[name*="password"], input[name*="pass"], input[id*="password"], input[id*="pass"]');
        if (passwordField) {
            await passwordField.click({ clickCount: 3 }); // Select all if there's existing text
            await passwordField.type(password, { delay: 50 });
        } else {
            throw new Error('Password field not found');
        }

        // Handle captcha
        console.log('Handling captcha...');
        let captchaField = null;
        
        // Try to find captcha input field with various selectors
        const captchaSelectors = [
            'input[name*="captcha" i]',
            'input[id*="captcha" i]',
            'input[placeholder*="captcha" i]',
            'input[type="text"][name*="code" i]',
            'input[type="text"][id*="code" i]',
            'input[type="text"][placeholder*="code" i]',
            'input[type="text"][placeholder*="verify" i]'
        ];

        for (const selector of captchaSelectors) {
            captchaField = await page.$(selector);
            if (captchaField) {
                console.log(`Found captcha field with selector: ${selector}`);
                break;
            }
        }

        if (captchaField) {
            let captchaCode = captcha;
            
            if (!captchaCode) {
                // Try to solve captcha using OpenAI
                try {
                    const apiKey = openaiApiKey || process.env.OPENAI_API_KEY;
                    if (apiKey) {
                        console.log('Extracting captcha image...');
                        const captchaImage = await extractCaptchaImage(page);
                        
                        console.log('Solving captcha with OpenAI...');
                        captchaCode = await solveCaptchaWithOpenAI(captchaImage, apiKey);
                    } else {
                        throw new Error('OpenAI API key not provided. Set OPENAI_API_KEY environment variable or pass openaiApiKey parameter.');
                    }
                } catch (error) {
                    console.error('Failed to solve captcha automatically:', error.message);
                    console.error('Error stack:', error.stack);
                    // Fallback: wait for manual captcha input
                    console.log('Waiting for manual captcha input...');
                    console.log('Please enter the captcha code in the browser window');
                    
                    // Wait for the captcha field to have some value
                    try {
                        await page.waitForFunction(
                            () => {
                                const selectors = [
                                    'input[name*="captcha" i]',
                                    'input[id*="captcha" i]',
                                    'input[placeholder*="captcha" i]',
                                    'input[type="text"][name*="code" i]',
                                    'input[type="text"][id*="code" i]',
                                    'input[type="text"][placeholder*="code" i]',
                                    'input[type="text"][placeholder*="verify" i]'
                                ];
                                for (const selector of selectors) {
                                    const field = document.querySelector(selector);
                                    if (field && field.value && field.value.length > 0) {
                                        return true;
                                    }
                                }
                                return false;
                            },
                            { timeout: 120000 } // Wait up to 2 minutes for manual input
                        );
                        
                        // Get the entered captcha code
                        captchaCode = await page.evaluate(() => {
                            const selectors = [
                                'input[name*="captcha" i]',
                                'input[id*="captcha" i]',
                                'input[placeholder*="captcha" i]',
                                'input[type="text"][name*="code" i]',
                                'input[type="text"][id*="code" i]',
                                'input[type="text"][placeholder*="code" i]',
                                'input[type="text"][placeholder*="verify" i]'
                            ];
                            for (const selector of selectors) {
                                const field = document.querySelector(selector);
                                if (field && field.value) {
                                    return field.value;
                                }
                            }
                            return null;
                        });
                        
                        console.log('Captcha code detected from manual input');
                    } catch (waitError) {
                        throw new Error('Manual captcha input timeout or failed. Original error: ' + error.message);
                    }
                }
            }
            
            if (captchaCode) {
                // Fill in the captcha code
                await captchaField.click({ clickCount: 3 });
                await captchaField.type(captchaCode, { delay: 50 });
                console.log('Captcha code entered');
            }
        } else {
            console.log('Captcha field not found, proceeding without captcha input');
        }

        // Wait a bit for any animations or validations
        await delay(500);

        // Find and click submit button
        console.log('Submitting form...');
        const submitSelectors = [
            'button[type="submit"]',
            'input[type="submit"]',
            'button:has-text("Login")',
            'button:has-text("Sign in")',
            'button:has-text("Log in")',
            'button:has-text("Вход")', // Russian for "Login"
            '[onclick*="login" i]',
            '[onclick*="submit" i]'
        ];

        let submitButton = null;
        for (const selector of submitSelectors) {
            try {
                submitButton = await page.$(selector);
                if (submitButton) {
                    break;
                }
            } catch (e) {
                // Continue to next selector
            }
        }

        if (!submitButton) {
            // Try to find any button and click it, or press Enter
            const buttons = await page.$$('button');
            if (buttons.length > 0) {
                submitButton = buttons[0];
            }
        }

        if (submitButton) {
            await submitButton.click();
        } else {
            // If no submit button found, try pressing Enter on the password field
            await passwordField.press('Enter');
        }

        // Wait for navigation or error message
        console.log('Waiting for login to complete...');
        try {
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
        } catch (e) {
            // Navigation might not occur, or it might be a single-page app
            console.log('No navigation detected, checking for error messages...');
        }

        // Check if login was successful by looking for error messages or dashboard elements
        const errorSelectors = [
            '.error',
            '.alert-danger',
            '[class*="error" i]',
            '[id*="error" i]',
            'div:has-text("Invalid")',
            'div:has-text("incorrect")',
            'div:has-text("неверный" i)', // Russian for "incorrect"
            'div:has-text("ошибка" i)' // Russian for "error"
        ];

        let hasError = false;
        for (const selector of errorSelectors) {
            try {
                const errorElement = await page.$(selector);
                if (errorElement) {
                    const errorText = await page.evaluate(el => el.textContent, errorElement);
                    if (errorText && errorText.trim().length > 0) {
                        console.log(`Error detected: ${errorText}`);
                        hasError = true;
                        break;
                    }
                }
            } catch (e) {
                // Page may be closed (e.g. on Cloud Run); skip error check
                const isSessionClosed = e.name === 'TargetCloseError' ||
                    (e.message && (e.message.includes('Session closed') || e.message.includes('Protocol error')));
                if (isSessionClosed) {
                    console.log('Page session closed during error check, continuing...');
                    break;
                }
            }
        }

        // Get cookies and session info (optional - session may be closed on some environments e.g. Cloud Run)
        let cookies = [];
        let currentUrl = '';
        let pageTitle = '';
        try {
            cookies = await page.cookies();
            currentUrl = page.url();
            pageTitle = await page.title();
        } catch (e) {
            const isSessionClosed = e.name === 'TargetCloseError' ||
                (e.message && (e.message.includes('Session closed') || e.message.includes('Protocol error')));
            if (isSessionClosed) {
                console.log('Page session closed before reading cookies/url/title (common on Cloud Run). Token may still be captured.');
            } else {
                throw e;
            }
        }

        // Wait for the cabinet API request to be made (if it hasn't been captured yet)
        if (!capturedToken) {
            console.log('Waiting for cabinet API request to capture token...');
            try {
                await Promise.race([
                    tokenPromise.then(() => true),
                    delay(10000).then(() => false) // Wait up to 10 seconds for the request
                ]);
            } catch (e) {
                console.log('Error waiting for token capture:', e.message);
            }
        }

        return {
            success: !hasError && currentUrl !== 'https://backend.energo.vip/login',
            cookies: cookies,
            url: currentUrl,
            title: pageTitle,
            token: capturedToken,
            browser: browser,
            page: page
        };

    } catch (error) {
        console.error('Login error:', error);
        if (browser) {
            await browser.close();
        }
        throw error;
    }
}

/**
 * Close browser instance
 * @param {Object} result - Result object from loginToEnergo function
 */
async function closeBrowser(result) {
    if (result && result.browser) {
        await result.browser.close();
        console.log('Browser closed');
    }
}

/**
 * Example usage function
 * Run this directly to test the login
 */
async function testLogin() {
    // Get credentials from environment variables
    const username = process.env.ENERGO_USERNAME;
    const password = process.env.ENERGO_PASSWORD;
    const openaiApiKey = process.env.OPENAI_API_KEY;
    
    if (!username) {
        throw new Error('ENERGO_USERNAME environment variable is not set. Please set it in your .env file.');
    }
    
    if (!password) {
        throw new Error('ENERGO_PASSWORD environment variable is not set. Please set it in your .env file.');
    }
    
    if (!openaiApiKey) {
        throw new Error('OPENAI_API_KEY environment variable is not set. Please set it in your .env file for local development or in Vercel dashboard for production.');
    }
    
    try {
        // Use SHOW_BROWSER_PREVIEW config to toggle browser visibility
        const result = await loginToEnergo({
            username: username,
            password: password,
            captcha: undefined, // Leave undefined to solve with OpenAI, or provide the code
            openaiApiKey: openaiApiKey, // Required: Set via OPENAI_API_KEY environment variable
            headless: !SHOW_BROWSER_PREVIEW, // false = show browser, true = headless
            timeout: 30000
        });

        console.log('Login result:', {
            success: result.success,
            url: result.url,
            title: result.title,
            cookiesCount: result.cookies.length,
            token: result.token || 'Not captured yet'
        });
        
        if (result.token) {
            console.log('\n✅ Authorization token successfully captured!');
        } else {
            console.log('\n⚠️  Authorization token not captured. The cabinet API request may not have been made yet.');
        }

        // Keep browser open for inspection (comment out if you want it to close automatically)
        // await closeBrowser(result);

        return result;
    } catch (error) {
        console.error('Test login failed:', error);
        throw error;
    }
}

// ========================================
// EXPRESS ROUTER FOR TOKEN ENDPOINT
// ========================================
const express = require('express');
const { Pool } = require('pg');
const router = express.Router();

// Database configuration (reusing same connection config as other services)
const CLOUD_SQL_CONNECTION_NAME = process.env.CLOUD_SQL_CONNECTION_NAME || 'keyextract-482721:us-central1:cuub-db';
const DB_USER = process.env.DB_USER || 'postgres';
const DB_PASS = process.env.DB_PASS || '1Cuubllc!';
const DB_NAME = process.env.DB_NAME || 'postgres';

// Create connection pool for token storage
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

// Create pool with error handling to prevent module load failures
let tokenPool;
try {
  tokenPool = new Pool(poolConfig);
  
  // Test database connection
  tokenPool.on('connect', () => {
    console.log('✅ Token Service: Connected to PostgreSQL database');
  });
  
  tokenPool.on('error', (err) => {
    console.error('❌ Token Service: Unexpected error on idle client', err);
    // Don't exit process - let it continue
  });
} catch (error) {
  console.error('❌ Token Service: Error creating database pool:', error);
  // Set tokenPool to null so the endpoint can handle it gracefully
  tokenPool = null;
}

/**
 * GET /token
 * Retrieve the Energo API token
 * Returns a JSON response with the token
 */
router.get('/token', async (req, res) => {
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
        
        // Save token to PostgreSQL database
        if (tokenPool) {
            let dbClient;
            try {
                dbClient = await tokenPool.connect();
                // Delete existing tokens and insert the new one
                // This ensures only one token is stored at a time
                await dbClient.query('DELETE FROM token');
                await dbClient.query('INSERT INTO token (value) VALUES ($1)', [loginResult.token]);
                console.log('✅ Token saved to database successfully');
            } catch (dbError) {
                console.error('❌ Error saving token to database:', dbError);
                // Don't fail the request if database save fails - still return the token
                // This allows the API to work even if there's a temporary database issue
            } finally {
                if (dbClient) {
                    dbClient.release();
                }
            }
        } else {
            console.warn('⚠️ Token pool not available, skipping database save');
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

// Log when router is loaded
console.log('📦 Token service API router initialized with route: GET /token');

// Export functions and router
module.exports = {
    loginToEnergo,
    closeBrowser,
    testLogin,
    solveCaptchaWithOpenAI,
    extractCaptchaImage,
    router
};

// If running directly, execute test
if (require.main === module) {
    testLogin().catch(console.error);
}
