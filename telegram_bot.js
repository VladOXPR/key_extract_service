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
 * Format station status message
 * @param {Array} stations - Array of station objects
 * @returns {string} - Formatted message text
 */
function formatStationStatus(stations) {
  if (!stations || stations.length === 0) {
    return 'No stations found.';
  }
  
  let message = `📊 Station Status Report (${stations.length} stations)\n\n`;
  
  stations.forEach((station, index) => {
    const title = station.title || 'Unknown';
    const filledSlots = station.filled_slots !== null && station.filled_slots !== undefined 
      ? station.filled_slots 
      : 'N/A';
    const openSlots = station.open_slots !== null && station.open_slots !== undefined 
      ? station.open_slots 
      : 'N/A';
    
    // Determine color square based on filled slots
    // Convert to number if it's a string
    let colorSquare = '';
    if (filledSlots !== 'N/A' && filledSlots !== null && filledSlots !== undefined) {
      const filledSlotsNum = typeof filledSlots === 'string' ? parseInt(filledSlots, 10) : filledSlots;
      
      if (!isNaN(filledSlotsNum)) {
        if (filledSlotsNum >= 4) {
          colorSquare = '🟢'; // Green for 4 or 5 filled slots
        } else if (filledSlotsNum === 3) {
          colorSquare = '🟡'; // Yellow for 3 filled slots
        } else if (filledSlotsNum <= 2) {
          colorSquare = '🔴'; // Red for 0, 1, or 2 filled slots
        }
      }
    }
    
    // Generate Apple Maps link with directions
    const latitude = station.latitude;
    const longitude = station.longitude;
    const mapLink = latitude && longitude 
      ? `http://maps.apple.com/?daddr=${latitude},${longitude}`
      : 'Location unavailable';
    
    message += `${colorSquare} ${index + 1}. ${title}\n`;
    message += `   🔋 Filled Slots: ${filledSlots}\n`;
    message += `   📦 Open Slots: ${openSlots}\n`;
    message += `   🗺️  Directions: ${mapLink}\n\n`;
  });
  
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

// Export functions
module.exports = {
  sendMessage,
  sendHelloWorld,
  sendStationStatus,
  fetchStations,
  formatStationStatus,
  getUpdates,
  getChatId
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

