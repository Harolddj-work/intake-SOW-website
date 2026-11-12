
require('dotenv').config();

const openai = require('./openai-client');

async function testConnection() {
    try {
        const response = await openai.responses.create({
            model: process.env.OPENAI_MODEL,
            input: 'Reply with only the word READY.'
        });

        console.log('AI Response:', response.output_text);

    } catch (error) {
        console.error('AI Connection Failed:', error.message);
        process.exitCode = 1;
    }
}

testConnection();
