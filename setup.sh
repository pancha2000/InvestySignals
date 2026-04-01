#!/bin/bash
echo "🚀 InvestySignals - VPS Setup Script"

# Logs folder create කිරීම
mkdir -p logs

# Dependencies install
echo "📦 npm install running..."
npm install

# PM2 globally install වෙලා නැත්නම්
if ! command -v pm2 &> /dev/null; then
    echo "📦 Installing PM2..."
    npm install -g pm2
fi

# Existing process stop කිරීම (error නොදෙන්නට 2>/dev/null)
pm2 stop InvestySignals 2>/dev/null
pm2 delete InvestySignals 2>/dev/null

# PM2 start
echo "▶️  Starting with PM2..."
pm2 start ecosystem.config.js

# Startup script save (reboot වෙලත් start වෙන්න)
pm2 save
pm2 startup

echo ""
echo "✅ Done! Server running on port 2000"
echo "📋 pm2 logs InvestySignals   → logs බලන්න"
echo "📋 pm2 status                → status බලන්න"
