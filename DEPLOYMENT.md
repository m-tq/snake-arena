# Deployment Guide

## Quick Start (Development)

```bash
# Install dependencies
npm install

# Start server
npm start
```

Server will run on `http://localhost:3000`

## Production Deployment

### 1. Prerequisites

- Node.js 16+ installed
- PM2 for process management
- Nginx for reverse proxy (recommended)
- Firewall configured

### 2. Install Dependencies

```bash
npm install --production
```

### 3. Environment Variables

Create a `.env` file or set environment variables:

```bash
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
```

### 4. Start with PM2

```bash
# Install PM2 globally
npm install -g pm2

# Start the server
pm2 start server/index.js --name snake-arena

# Save PM2 configuration
pm2 save

# Setup PM2 to start on system boot
pm2 startup
```

### 5. Configure Nginx (Recommended)

Create `/etc/nginx/sites-available/snake-arena`:

```nginx
upstream snake_backend {
    server 127.0.0.1:3000;
}

# Rate limiting zones
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=ws:10m rate=5r/s;
limit_req_zone $binary_remote_addr zone=static:10m rate=50r/s;

server {
    listen 80;
    server_name your-domain.com;

    # Security headers
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # WebSocket endpoint
    location /ws {
        limit_req zone=ws burst=10 nodelay;
        
        proxy_pass http://snake_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Timeouts
        proxy_connect_timeout 7d;
        proxy_send_timeout 7d;
        proxy_read_timeout 7d;
    }

    # API endpoints
    location /api/ {
        limit_req zone=api burst=20 nodelay;
        
        proxy_pass http://snake_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Disable caching for API
        add_header Cache-Control "no-store, no-cache, must-revalidate";
    }

    # Static files
    location / {
        limit_req zone=static burst=100 nodelay;
        
        proxy_pass http://snake_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        
        # Cache static files
        proxy_cache_valid 200 1h;
        add_header Cache-Control "public, max-age=3600";
    }

    # Deny access to sensitive files
    location ~ /\. {
        deny all;
        access_log off;
        log_not_found off;
    }
}
```

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/snake-arena /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 6. SSL/TLS with Let's Encrypt (Recommended)

```bash
# Install certbot
sudo apt install certbot python3-certbot-nginx

# Obtain certificate
sudo certbot --nginx -d your-domain.com

# Auto-renewal is configured automatically
```

### 7. Firewall Configuration

```bash
# Allow SSH, HTTP, HTTPS
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Enable firewall
sudo ufw enable

# Check status
sudo ufw status
```

### 8. Monitoring

#### PM2 Monitoring

```bash
# View logs
pm2 logs snake-arena

# Monitor resources
pm2 monit

# View status
pm2 status
```

#### Health Check

```bash
# Check server health
curl http://localhost:3000/api/health
```

#### Nginx Logs

```bash
# Access logs
sudo tail -f /var/log/nginx/access.log

# Error logs
sudo tail -f /var/log/nginx/error.log
```

## Maintenance

### Update Application

```bash
# Pull latest changes
git pull

# Install dependencies
npm install --production

# Restart server
pm2 restart snake-arena
```

### Database Backup

```bash
# Backup database
cp data/snake_arena.db data/snake_arena.db.backup.$(date +%Y%m%d)

# Restore from backup
cp data/snake_arena.db.backup.YYYYMMDD data/snake_arena.db
pm2 restart snake-arena
```

### Clear Old Logs

```bash
# PM2 logs
pm2 flush

# Nginx logs (rotate)
sudo logrotate -f /etc/logrotate.d/nginx
```

## Troubleshooting

### Server Won't Start

```bash
# Check logs
pm2 logs snake-arena --lines 100

# Check if port is in use
sudo lsof -i :3000

# Check Node.js version
node --version  # Should be 16+
```

### WebSocket Connection Issues

1. Check Nginx WebSocket configuration
2. Verify firewall allows WebSocket connections
3. Check browser console for errors
4. Test direct connection: `ws://your-domain.com/ws`

### High Memory Usage

```bash
# Check memory usage
pm2 monit

# Restart server
pm2 restart snake-arena

# Check for memory leaks in logs
pm2 logs snake-arena | grep -i "memory"
```

### Rate Limiting Too Strict

Adjust rate limits in `server/index.js`:

```javascript
const RATE_LIMITS = {
  create_room: { max: 5, window: 60000 }, // Increase from 3 to 5
  // ... other limits
};
```

## Performance Tuning

### PM2 Cluster Mode

For better performance on multi-core systems:

```bash
pm2 start server/index.js --name snake-arena -i max
```

### Database Optimization

The database auto-optimizes on startup, but you can manually optimize:

```bash
sqlite3 data/snake_arena.db "VACUUM;"
sqlite3 data/snake_arena.db "ANALYZE;"
```

## Security Checklist

- [ ] Firewall configured and enabled
- [ ] SSL/TLS certificate installed
- [ ] Nginx rate limiting configured
- [ ] PM2 running as non-root user
- [ ] Database file permissions restricted (600)
- [ ] Regular backups scheduled
- [ ] Monitoring and alerting set up
- [ ] Security headers configured
- [ ] Server and dependencies up to date

## Support

For issues or questions:
- Check logs: `pm2 logs snake-arena`
- Review SECURITY.md for security features
- Check CHANGELOG_SECURITY.md for recent changes
