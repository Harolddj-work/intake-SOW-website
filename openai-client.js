
const OpenAI = require('openai');

// Make sure the API key exists before initializing.
if (!process.env.OPENAI_API_KEY) {
    throw new Error('Missing OPENAI_API_KEY in .env');
}

// Initialize the OpenAI client.
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

module.exports = openai;
