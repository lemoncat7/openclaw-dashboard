# Dashboard Service Route Setup

## Current Status
- ✅ Dashboard service running on port 19000
- ✅ Service responding to http://localhost:19000/
- ⚠️ External route https://oclaw.mochencloud.cn:1443/onboard/ returns 502

## Problem
The external reverse proxy (nginx/openresty) is not configured to forward `/onboard/` requests to port 19000.

## Solution 1: Add Nginx Route
Add this to your nginx/openresty config:

```nginx
location /onboard/ {
    proxy_pass http://127.0.0.1:19000/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Then reload nginx:
```bash
sudo nginx -s reload
```

## Solution 2: Use OpenClaw Route (if available)
If OpenClaw supports route configuration:
```bash
openclaw config set gateway.routes.onboard.target http://localhost:19000
openclaw gateway restart
```

## Solution 3: Run as Gateway Plugin
The dashboard can be integrated as an OpenClaw plugin/endpoint if supported.

## Testing
After configuration:
```bash
curl -I https://oclaw.mochencloud.cn:1443/onboard/
# Should return HTTP/2 200
```
