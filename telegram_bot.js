// Telegram Bot API Integration
const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '.env.local') });

// Add fetch for HTTP requests
let fetch;
if (typeof globalThis.fetch === 'undefined') {
  fetch = require('node-fetch');
} else {
  fetch = globalThis.fetch;
}

// Telegram Bot Configuration
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8279022767:AAHPZ4IJE6Blcm3wuNW9L1-HEoY1QjNoQ8I';
const TELEGRAM_API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

/**
 * Send a message to a Telegram chat
 * @param {string|number} chatId - The chat ID to send the message to
 * @param {string} text - The message text to send
 * @returns {Promise<Object>} - The API response
 */
async function sendMessage(chatId, text) {
  try {
    const url = `${TELEGRAM_API_BASE}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: text
      })
    });

    const data = await response.json();
    
    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description}`);
    }
    
    return data;
  } catch (error) {
    console.error('Error sending Telegram message:', error);
    throw error;
  }
}

/**
 * Get bot updates (useful for finding your chat_id)
 * @returns {Promise<Object>} - The API response with updates
 */
async function getUpdates() {
  try {
    const url = `${TELEGRAM_API_BASE}/getUpdates`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description}`);
    }
    
    return data;
  } catch (error) {
    console.error('Error getting Telegram updates:', error);
    throw error;
  }
}

/**
 * Fetch station status from API
 * @returns {Promise<Array>} - Array of station objects
 */
async function fetchStations() {
  try {
    const response = await fetch('https://api.cuub.tech/stations');
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (!data.success || !data.data) {
      throw new Error('Invalid API response format');
    }
    
    return data.data;
  } catch (error) {
    console.error('Error fetching stations:', error);
    throw error;
  }
}

/**
 * Generate Apple Maps route link with red and yellow stations as stops
 * Red stations are those with 0, 1, or 2 filled slots
 * Yellow stations are those with 3 filled slots
 * @param {Array} stations - Array of station objects with latitude/longitude
 * @returns {string} - Apple Maps URL with red and yellow stations as route stops
 */
function generateRouteLink(stations) {
  if (!stations || stations.length === 0) {
    return null;
  }
  
  // Filter for red and yellow stations with valid coordinates
  const redYellowStations = stations.filter(station => {
    // Must have valid coordinates
    if (!station.latitude || !station.longitude) {
      return false;
    }
    
    // Check if it's a red or yellow station
    const filledSlots = station.filled_slots;
    if (filledSlots === null || filledSlots === undefined || filledSlots === 'N/A') {
      return false;
    }
    
    // Convert to number if it's a string
    const filledSlotsNum = typeof filledSlots === 'string' ? parseInt(filledSlots, 10) : filledSlots;
    
    // Red stations (0-2) and yellow stations (3)
    return !isNaN(filledSlotsNum) && filledSlotsNum <= 3;
  });
  
  if (redYellowStations.length === 0) {
    return null;
  }
  
  // Apple Maps supports multiple destinations by repeating daddr parameter
  // Format: http://maps.apple.com/?daddr=lat1,lon1&daddr=lat2,lon2&daddr=lat3,lon3
  const destinations = redYellowStations
    .map(station => `daddr=${station.latitude},${station.longitude}`)
    .join('&');
  
  return `http://maps.apple.com/?${destinations}`;
}

/**
 * Format station status message
 * @param {Array} stations - Array of station objects
 * @returns {string} - Formatted message text
 */
/**
 * Get station priority for sorting (lower number = higher priority)
 * Red (0,1,2 slots) = 1, Yellow (3 slots) = 2, Green (4,5 slots) = 3
 */
function getStationPriority(station) {
  const filledSlots = station.filled_slots;
  if (filledSlots === null || filledSlots === undefined || filledSlots === 'N/A') {
    return 4; // Unknown/N/A stations go last
  }
  
  const filledSlotsNum = typeof filledSlots === 'string' ? parseInt(filledSlots, 10) : filledSlots;
  
  if (isNaN(filledSlotsNum)) {
    return 4;
  }
  
  if (filledSlotsNum >= 4) {
    return 3; // Green - lowest priority
  } else if (filledSlotsNum === 3) {
    return 2; // Yellow - medium priority
  } else if (filledSlotsNum <= 2) {
    return 1; // Red - highest priority
  }
  
  return 4; // Default
}

function formatStationStatus(stations) {
  if (!stations || stations.length === 0) {
    return 'No stations found.';
  }
  
  // Filter to only include red and yellow stations (exclude green stations)
  const redYellowStations = stations.filter(station => {
    const filledSlots = station.filled_slots;
    if (filledSlots === null || filledSlots === undefined || filledSlots === 'N/A') {
      return false; // Exclude stations with unknown status
    }
    
    const filledSlotsNum = typeof filledSlots === 'string' ? parseInt(filledSlots, 10) : filledSlots;
    
    if (isNaN(filledSlotsNum)) {
      return false; // Exclude stations with invalid numbers
    }
    
    // Only include red (0-2) and yellow (3) stations, exclude green (4-5)
    return filledSlotsNum <= 3;
  });
  
  if (redYellowStations.length === 0) {
    return 'Network is healthy!';
  }
  
  // Sort stations: Red first, then Yellow
  const sortedStations = [...redYellowStations].sort((a, b) => {
    return getStationPriority(a) - getStationPriority(b);
  });
  
  let message = '';
  
  sortedStations.forEach((station) => {
    const title = station.title || 'Unknown';
    const filledSlots = station.filled_slots !== null && station.filled_slots !== undefined 
      ? station.filled_slots 
      : 0;
    const openSlots = station.open_slots !== null && station.open_slots !== undefined 
      ? station.open_slots 
      : 0;
    
    // Calculate total slots (filled + open, default to 6 if not available)
    const totalSlots = (filledSlots !== null && openSlots !== null && filledSlots !== undefined && openSlots !== undefined)
      ? filledSlots + openSlots
      : 6;
    
    // Determine color square based on filled slots
    // Convert to number if it's a string
    let colorSquare = '';
    const filledSlotsNum = typeof filledSlots === 'string' ? parseInt(filledSlots, 10) : filledSlots;
    
    if (!isNaN(filledSlotsNum)) {
      if (filledSlotsNum >= 4) {
        colorSquare = '🟢'; // Green for 4 or 5 filled slots
      } else if (filledSlotsNum === 3) {
        colorSquare = '🟨'; // Yellow for 3 filled slots
      } else if (filledSlotsNum <= 2) {
        colorSquare = '🟥'; // Red for 0, 1, or 2 filled slots
      }
    }
    
    // Format: Station Name
    // Color Filled: X / 6 (or X/6 for red stations based on example)
    message += `${title}\n`;
    if (filledSlotsNum <= 2) {
      // Red stations: just show X/6
      message += `${colorSquare} ${filledSlotsNum}/${totalSlots}\n\n`;
    } else if (filledSlotsNum === 3) {
      // Yellow stations: show Filled: X / 6
      message += `${colorSquare} Filled: ${filledSlotsNum} / ${totalSlots}\n\n`;
    } else {
      // Green stations (shouldn't appear, but just in case)
      message += `${colorSquare} Filled: ${filledSlotsNum} / ${totalSlots}\n\n`;
    }
  });
  
  // Add route link with red and yellow stations
  const routeLink = generateRouteLink(stations);
  if (routeLink) {
    message += `Link\n${routeLink}`;
  }
  
  return message;
}

/**
 * Send station status report to Telegram
 * @param {string|number} chatId - The chat ID to send the message to
 */
async function sendStationStatus(chatId) {
  try {
    console.log(`Fetching station status for chat ID: ${chatId}`);
    
    // Fetch stations from API
    const stations = await fetchStations();
    console.log(`✅ Fetched ${stations.length} stations`);
    
    // Format the status message
    const message = formatStationStatus(stations);
    
    // Send the message
    console.log(`Sending station status report...`);
    const result = await sendMessage(chatId, message);
    console.log('✅ Station status report sent successfully!', result);
    return result;
  } catch (error) {
    console.error('❌ Failed to send station status:', error.message);
    // Send error message to chat instead of crashing
    try {
      await sendMessage(chatId, `❌ Error fetching station status: ${error.message}`);
    } catch (sendError) {
      console.error('Failed to send error message:', sendError);
    }
    throw error;
  }
}

/**
 * Main function to send "hello world" message (kept for backward compatibility)
 * Note: You need to get your chat_id first by:
 * 1. Sending a message to the bot: https://t.me/cuub_chicago_bot
 * 2. Running: node -e "require('./telegram_bot.js').getChatId()"
 * 3. Or check the getUpdates response to find your chat_id
 */
async function sendHelloWorld(chatId) {
  try {
    console.log(`Sending "hello world" to chat ID: ${chatId}`);
    const result = await sendMessage(chatId, 'hello world');
    console.log('✅ Message sent successfully!', result);
    return result;
  } catch (error) {
    console.error('❌ Failed to send message:', error.message);
    throw error;
  }
}

/**
 * Helper function to get your chat_id from updates
 * Run this first to find your chat_id after messaging the bot
 */
async function getChatId() {
  try {
    console.log('Getting updates to find your chat_id...');
    console.log('(Make sure you\'ve sent a message to the bot first: https://t.me/cuub_chicago_bot)');
    
    const updates = await getUpdates();
    
    if (updates.result && updates.result.length > 0) {
      const lastUpdate = updates.result[updates.result.length - 1];
      const chatId = lastUpdate.message?.chat?.id;
      
      if (chatId) {
        console.log(`\n✅ Found your chat_id: ${chatId}`);
        console.log(`You can now use: sendHelloWorld(${chatId})`);
        return chatId;
      }
    }
    
    console.log('❌ No messages found. Please send a message to the bot first: https://t.me/cuub_chicago_bot');
    return null;
  } catch (error) {
    console.error('Error getting chat_id:', error);
    return null;
  }
}

// ========================================
// DAILY TELEGRAM STATUS REPORT SCHEDULER
// ========================================

/**
 * Calculate milliseconds until next 6 AM
 * @param {Date} now - Current date/time
 * @returns {number} - Milliseconds until next 6 AM
 */
function getMillisecondsUntil6AM(now = new Date()) {
  const next6AM = new Date(now);
  next6AM.setHours(6, 0, 0, 0); // Set to 6:00:00 AM
  
  // If it's already past 6 AM today, schedule for tomorrow
  if (now >= next6AM) {
    next6AM.setDate(next6AM.getDate() + 1);
  }
  
  return next6AM.getTime() - now.getTime();
}

/**
 * Schedule daily Telegram status report at 6 AM
 */
function scheduleDailyTelegramReport() {
  const DEFAULT_CHAT_ID = '-5202000799'; // CUUB_Alert group
  const chatId = process.env.TELEGRAM_CHAT_ID || DEFAULT_CHAT_ID;
  
  const sendDailyReport = async () => {
    try {
      console.log('📨 Sending daily Telegram status report...');
      await sendStationStatus(chatId);
      console.log('✅ Daily Telegram status report sent successfully');
    } catch (error) {
      console.error('❌ Error sending daily Telegram report:', error.message);
    }
    
    // Schedule next report for tomorrow at 6 AM
    scheduleNextDailyReport();
  };
  
  const scheduleNextDailyReport = () => {
    const msUntil6AM = getMillisecondsUntil6AM();
    const hoursUntil6AM = Math.floor(msUntil6AM / (1000 * 60 * 60));
    const minutesUntil6AM = Math.floor((msUntil6AM % (1000 * 60 * 60)) / (1000 * 60));
    
    console.log(`⏰ Next daily Telegram report scheduled in ${hoursUntil6AM}h ${minutesUntil6AM}m (at 6:00 AM)`);
    
    setTimeout(sendDailyReport, msUntil6AM);
  };
  
  // Calculate time until next 6 AM and schedule
  const msUntil6AM = getMillisecondsUntil6AM();
  const hoursUntil6AM = Math.floor(msUntil6AM / (1000 * 60 * 60));
  const minutesUntil6AM = Math.floor((msUntil6AM % (1000 * 60 * 60)) / (1000 * 60));
  
  console.log(`📅 Daily Telegram status report scheduler initialized`);
  console.log(`   First report will be sent in ${hoursUntil6AM}h ${minutesUntil6AM}m (at 6:00 AM)`);
  
  // Schedule the first report
  setTimeout(sendDailyReport, msUntil6AM);
}

// ========================================
// TELEGRAM BOT COMMAND HANDLER
// ========================================

/**
 * Start polling for Telegram messages and handle /status command
 */
function startTelegramCommandPolling() {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8279022767:AAHPZ4IJE6Blcm3wuNW9L1-HEoY1QjNoQ8I';
  const TELEGRAM_API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
  let lastUpdateId = 0;
  
  // Get fetch for HTTP requests
  let fetch;
  if (typeof globalThis.fetch === 'undefined') {
    fetch = require('node-fetch');
  } else {
    fetch = globalThis.fetch;
  }
  
  const pollForMessages = async () => {
    try {
      // Get updates from Telegram
      // Use timeout=0 to get only new updates, not pending ones
      const url = lastUpdateId > 0 
        ? `${TELEGRAM_API_BASE}/getUpdates?offset=${lastUpdateId + 1}&timeout=1`
        : `${TELEGRAM_API_BASE}/getUpdates?timeout=1`;
      
      const response = await fetch(url);
      
      if (!response.ok) {
        console.error(`❌ Telegram API HTTP error: ${response.status} ${response.statusText}`);
        setTimeout(pollForMessages, 5000);
        return;
      }
      
      const data = await response.json();
      
      if (!data.ok) {
        console.error('❌ Telegram API error:', data.description);
        setTimeout(pollForMessages, 5000);
        return;
      }
      
      if (data.result && data.result.length > 0) {
        console.log(`📥 Received ${data.result.length} update(s) from Telegram`);
        
        for (const update of data.result) {
          lastUpdateId = Math.max(lastUpdateId, update.update_id);
          
          // Handle messages
          if (update.message && update.message.text) {
            const messageText = update.message.text.trim();
            const chatId = update.message.chat.id;
            const chatTitle = update.message.chat.title || update.message.chat.first_name || 'Unknown';
            const username = update.message.from?.username || update.message.from?.first_name || 'Unknown';
            
            console.log(`💬 Message received: "${messageText}" from ${username} in ${chatTitle} (chatId: ${chatId})`);
            
            // Handle /status command (can be /status or /status@botname)
            if (messageText === '/status' || messageText.startsWith('/status@') || messageText.startsWith('/status ')) {
              console.log(`📨 /status command detected from chat: ${chatTitle} (${chatId})`);
              try {
                await sendStationStatus(chatId.toString());
                console.log(`✅ Status report sent to chat ${chatId}`);
              } catch (error) {
                console.error(`❌ Error sending status report to chat ${chatId}:`, error.message);
                console.error('Error stack:', error.stack);
                try {
                  await sendMessage(chatId.toString(), '❌ Error fetching station status. Please try again later.');
                } catch (sendError) {
                  console.error('Failed to send error message:', sendError);
                }
              }
            }
            // Handle /gay command
            else if (messageText === '/gay' || messageText.startsWith('/gay@') || messageText.startsWith('/gay ')) {
              console.log(`📨 /gay command detected from chat: ${chatTitle} (${chatId})`);
              try {
                await sendMessage(chatId.toString(), 'Yes');
                console.log(`✅ /gay response sent to chat ${chatId}`);
              } catch (error) {
                console.error(`❌ Error sending /gay response to chat ${chatId}:`, error.message);
                console.error('Error stack:', error.stack);
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('❌ Error polling Telegram messages:', error.message);
      console.error('Error stack:', error.stack);
    }
    
    // Poll again after a short delay
    setTimeout(pollForMessages, 3000); // Poll every 3 seconds (reduced from 5)
  };
  
  console.log('🤖 Starting Telegram bot command polling...');
  console.log(`   Bot token: ${BOT_TOKEN.substring(0, 10)}...${BOT_TOKEN.substring(BOT_TOKEN.length - 5)}`);
  console.log('   Listening for /status and /gay commands');
  console.log('   Starting in 10 seconds...');
  
  // Start polling after a short delay
  setTimeout(pollForMessages, 10000); // Wait 10 seconds after server starts
}

// Export functions
module.exports = {
  sendMessage,
  sendHelloWorld,
  sendStationStatus,
  fetchStations,
  formatStationStatus,
  generateRouteLink,
  getUpdates,
  getChatId,
  scheduleDailyTelegramReport,
  startTelegramCommandPolling
};

// If running directly, try to get chat_id and send station status
if (require.main === module) {
  (async () => {
    // Default chat ID (CUUB_Alert group)
    const DEFAULT_CHAT_ID = '-5202000799';
    
    // First, try to get chat_id from environment variable or command line
    const chatId = process.env.TELEGRAM_CHAT_ID || process.argv[2] || DEFAULT_CHAT_ID;
    
    try {
      if (chatId) {
        // Send station status report
        await sendStationStatus(chatId);
      } else {
        // Otherwise, try to find chat_id from updates
        console.log('No chat_id provided. Attempting to find it from recent messages...');
        const foundChatId = await getChatId();
        
        if (foundChatId) {
          console.log('\nSending station status report...');
          await sendStationStatus(foundChatId);
        } else {
          console.log('\nUsage:');
          console.log('  node telegram_bot.js [chat_id]');
          console.log('  or set TELEGRAM_CHAT_ID environment variable');
          console.log('\nTo find your chat_id:');
          console.log('  1. Send a message to https://t.me/cuub_chicago_bot');
          console.log('  2. Run: node -e "require(\'./telegram_bot.js\').getChatId()"');
        }
      }
    } catch (error) {
      console.error('❌ Fatal error:', error.message);
      process.exit(1);
    }
  })();
}

