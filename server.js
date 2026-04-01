const express = require('express');
const path = require('path');
const axios = require('axios');
const app = express();
const PORT = 2000;
const HOST = '0.0.0.0';

// 1. Static files (images, css) පාවිච්චි කරන්න public folder එක සෙට් කිරීම
app.use(express.static(path.join(__dirname, 'public')));

// 2. Binance එකෙන් Live Prices ගන්න API එක
app.get('/api/prices', async (req, res) => {
    try {
        const response = await axios.get('https://api.binance.com/api/v3/ticker/price?symbols=["BTCUSDT","ETHUSDT","SOLUSDT"]');
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: "Data fetch failed" });
    }
});

// 3. මුල් පිටුවට index.html යැවීම
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 4. වැදගත්ම දේ: 0.0.0.0 දමා Listen කිරීම
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 InvestySignals Live: http://213.35.98.214:${PORT}`);
});
