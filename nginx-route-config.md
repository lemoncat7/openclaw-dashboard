# Dashboard Service - Nginx Route Configuration

## Problem
The dashboard service is running on port 19000 inside the container, but the external nginx (openresty) is returning 502 for the `/onboard/` route.

## Solution
The nginx configuration needs to include a route that proxies `/onboard/` to the dashboard service.

## Nginx Configuration Required

Add this location block to your nginx/openresty configuration:

```nginx
location /onboard/ {
    proxy_pass http://localhost:19000/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Optional: Enable buffering for better performance
    proxy_buffering on;
    proxy_buffer_size 4k;
    proxy_buffers 8 4k;
}
```

## Alternative: Using Gateway Routes

The route should be configured through the OpenClaw Gateway configuration. Add this to `~/.openclaw/openclaw.json`:

```json
{
  "gateway": {
    "routes": {
      "/onboard": {
        "target": "http://localhost:19000",
        "methods": ["GET", "POST"]
      }
    }
  }
}
```

Then restart the gateway:
```bash
openclaw gateway restart
```

## Current Status

- ✅ Dashboard service running on port 19000
- ✅ Service responding to http://localhost:19000/health
- ✅ API responding with real data (status: working, skills: 23)
- ⚠️ External route depends on host nginx configuration
- ⚠️ Gateway route configuration not present

## Quick Fix Commands (Run on Host)

### Check if nginx config exists:
```bash
cat /etc/nginx/conf.d/oclaw.mochencloud.cn.conf
# or
cat /etc/nginx/sites-enabled/oclaw.mochencloud.cn
```

### Add the route:
```bash
# Add this to the server block:
location /onboard/ {
    proxy_pass http://127.0.0.1:19000/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

# Then restart nginx:
sudo systemctl restart nginx
# or
sudo nginx -s reload
```

### Alternative: Use openclaw onboard command
```bash
openclaw onboard
```

## Testing

After configuration, test with:
```bash
curl -I https://oclaw.mochencloud.cn:1443/onboard/
```

Expected response: HTTP/2 200

## Dashboard Service v18.0 Updates

The dashboard has been updated with modern UI enhancements:
- 3D Card Tilt Effect
- Enhanced Glassmorphism
- Spring Animations
- Ripple Click Effects
- FPS Counter
- Scroll Progress Bar
- Version updated to v18.0
