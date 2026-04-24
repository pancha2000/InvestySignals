#!/bin/bash
# ═══════════════════════════════════════════════════
#  InvestySignals — Auto Deploy Script
#  Usage: bash deploy.sh
# ═══════════════════════════════════════════════════

set -e

# ── Colours ──
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✅ $1${NC}"; }
info() { echo -e "${CYAN}➤  $1${NC}"; }
warn() { echo -e "${YELLOW}⚠  $1${NC}"; }
err()  { echo -e "${RED}❌ $1${NC}"; exit 1; }
hr()   { echo -e "${CYAN}═══════════════════════════════════════${NC}"; }

hr
echo -e "${CYAN}  InvestySignals — Auto Deploy${NC}"
hr

# ════════════════════════════════
# 0. COLLECT CONFIG FROM USER
# ════════════════════════════════
info "Setup configuration..."
echo ""

read -p "📁 Project zip file path (e.g. /home/ubuntu/investysignals.zip): " ZIP_PATH
read -p "🌐 Your domain name (e.g. investysignals.store): " DOMAIN
read -p "🍃 MongoDB URI (paste full connection string): " MONGO_URI
read -p "📂 Install directory [/home/ubuntu/investysignals]: " INSTALL_DIR
INSTALL_DIR="${INSTALL_DIR:-/home/ubuntu/investysignals}"

echo ""
hr
echo -e "  Domain    : ${CYAN}$DOMAIN${NC}"
echo -e "  Install   : ${CYAN}$INSTALL_DIR${NC}"
echo -e "  Zip file  : ${CYAN}$ZIP_PATH${NC}"
hr
read -p "Continue? (y/n): " CONFIRM
[[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]] && err "Aborted."

# ════════════════════════════════
# 1. SYSTEM UPDATE
# ════════════════════════════════
hr; info "Step 1/8 — System update"
sudo apt-get update -qq && sudo apt-get upgrade -y -qq
ok "System updated"

# ════════════════════════════════
# 2. INSTALL NODE.JS 20
# ════════════════════════════════
hr; info "Step 2/8 — Installing Node.js 20"
if node --version 2>/dev/null | grep -q "v20"; then
  ok "Node.js 20 already installed: $(node -v)"
else
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - -qq
  sudo apt-get install -y -qq nodejs
  ok "Node.js installed: $(node -v)"
fi

# PM2
if ! command -v pm2 &>/dev/null; then
  sudo npm install -g pm2 --silent
  ok "PM2 installed"
else
  ok "PM2 already installed: $(pm2 -v)"
fi

# ════════════════════════════════
# 3. INSTALL NGINX
# ════════════════════════════════
hr; info "Step 3/8 — Installing Nginx"
if ! command -v nginx &>/dev/null; then
  sudo apt-get install -y -qq nginx
fi
sudo systemctl enable nginx --quiet
sudo systemctl start nginx
ok "Nginx ready"

# ════════════════════════════════
# 4. EXTRACT PROJECT
# ════════════════════════════════
hr; info "Step 4/8 — Extracting project"

[[ ! -f "$ZIP_PATH" ]] && err "Zip file not found: $ZIP_PATH"

# Backup if exists
if [[ -d "$INSTALL_DIR" ]]; then
  BACKUP="${INSTALL_DIR}_backup_$(date +%Y%m%d_%H%M%S)"
  warn "Existing install found — backing up to $BACKUP"
  mv "$INSTALL_DIR" "$BACKUP"
fi

mkdir -p "$(dirname $INSTALL_DIR)"
cd "$(dirname $INSTALL_DIR)"
unzip -q "$ZIP_PATH" -d /tmp/is_extract

# Find the inner folder (zip might have a subfolder)
INNER=$(ls /tmp/is_extract/ | head -1)
if [[ -d "/tmp/is_extract/$INNER" && "$INNER" != "package.json" ]]; then
  mv "/tmp/is_extract/$INNER" "$INSTALL_DIR"
else
  mv /tmp/is_extract "$INSTALL_DIR"
fi
rm -rf /tmp/is_extract
ok "Project extracted to $INSTALL_DIR"

# ════════════════════════════════
# 5. NPM INSTALL + .env
# ════════════════════════════════
hr; info "Step 5/8 — Installing dependencies & creating .env"
cd "$INSTALL_DIR"

npm install --silent
ok "npm install done"

# Create .env
cat > .env << ENVEOF
PORT=3000
MONGODB_URI=${MONGO_URI}
FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json
NODE_ENV=production
ENVEOF
ok ".env created"

# Check firebase service account
if [[ ! -f "./firebase-service-account.json" ]]; then
  warn "firebase-service-account.json not found in project!"
  warn "Upload it manually: scp firebase-service-account.json ubuntu@SERVER:${INSTALL_DIR}/"
fi

# ════════════════════════════════
# 6. PM2 START
# ════════════════════════════════
hr; info "Step 6/8 — Starting app with PM2"
cd "$INSTALL_DIR"

# Stop existing if running
pm2 stop investysignals 2>/dev/null || true
pm2 delete investysignals 2>/dev/null || true

# Start via ecosystem or direct
if [[ -f "ecosystem.config.js" ]]; then
  pm2 start ecosystem.config.js
else
  pm2 start server.js --name investysignals --max-memory-restart 400M
fi

pm2 save

# Setup startup
PM2_STARTUP=$(pm2 startup | grep "sudo" | tail -1)
if [[ -n "$PM2_STARTUP" ]]; then
  eval "$PM2_STARTUP" 2>/dev/null || warn "Run manually: $PM2_STARTUP"
fi

ok "PM2 running"
pm2 status

# ════════════════════════════════
# 7. NGINX CONFIG
# ════════════════════════════════
hr; info "Step 7/8 — Configuring Nginx"

sudo tee /etc/nginx/sites-available/investysignals > /dev/null << NGINXEOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} www.${DOMAIN};

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header X-Content-Type-Options "nosniff" always;

    # Gzip
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/javascript;
    gzip_min_length 1024;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 86400;
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
    }

    # Cache static files
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff2)$ {
        proxy_pass http://127.0.0.1:3000;
        proxy_cache_bypass \$http_upgrade;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }
}
NGINXEOF

# Remove default if exists
sudo rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

# Enable site
sudo ln -sf /etc/nginx/sites-available/investysignals /etc/nginx/sites-enabled/investysignals

# Test & reload
sudo nginx -t && sudo systemctl reload nginx
ok "Nginx configured for $DOMAIN"

# ════════════════════════════════
# 8. SSL (CERTBOT)
# ════════════════════════════════
hr; info "Step 8/8 — SSL Certificate (Let's Encrypt)"

# Install certbot
if ! command -v certbot &>/dev/null; then
  sudo apt-get install -y -qq certbot python3-certbot-nginx
fi

echo ""
warn "DNS check: Make sure $DOMAIN points to this server's IP first!"
read -p "Get SSL certificate now? (y/n): " DO_SSL

if [[ "$DO_SSL" == "y" || "$DO_SSL" == "Y" ]]; then
  sudo certbot --nginx \
    -d "$DOMAIN" \
    -d "www.$DOMAIN" \
    --non-interactive \
    --agree-tos \
    --email "admin@${DOMAIN}" \
    --redirect
  ok "SSL installed — HTTPS active"
else
  warn "SSL skipped. Run later: sudo certbot --nginx -d $DOMAIN -d www.$DOMAIN"
fi

# ════════════════════════════════
# FIREWALL
# ════════════════════════════════
hr; info "Firewall setup"
sudo ufw allow OpenSSH  --quiet
sudo ufw allow 'Nginx Full' --quiet
echo "y" | sudo ufw enable --quiet 2>/dev/null || true
ok "Firewall enabled"

# ════════════════════════════════
# DONE
# ════════════════════════════════
hr
echo -e "${GREEN}"
echo "  ✅  DEPLOY COMPLETE!"
echo ""
echo "  🌐  http://${DOMAIN}"
[[ "$DO_SSL" == "y" || "$DO_SSL" == "Y" ]] && echo "  🔒  https://${DOMAIN}"
echo ""
echo "  📋  Useful commands:"
echo "      pm2 status"
echo "      pm2 logs investysignals"
echo "      pm2 restart investysignals"
echo -e "${NC}"
hr

# App health check
sleep 2
if curl -s http://localhost:3000 > /dev/null; then
  ok "App is responding on port 3000"
else
  warn "App may still be starting. Check: pm2 logs investysignals"
fi
