#!/bin/bash
# Dashboard Service Startup Script with Auto-Restart
# Ensures https://oclaw.mochencloud.cn:1443/onboard/ is accessible

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_SCRIPT="$SCRIPT_DIR/server.js"
PID_FILE="$SCRIPT_DIR/.dashboard.pid"
LOG_FILE="$SCRIPT_DIR/dashboard.log"
PORT=19000
MAX_RETRIES=10
RETRY_DELAY=3

start_server() {
    echo "[$(date)] Starting Dashboard service..." >> "$LOG_FILE"
    node "$SERVER_SCRIPT" >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    SERVER_PID=$(cat "$PID_FILE")
    echo "[$(date)] Server started with PID $SERVER_PID" >> "$LOG_FILE"
}

stop_server() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            kill "$PID" 2>/dev/null
            echo "[$(date)] Server stopped" >> "$LOG_FILE"
        fi
        rm -f "$PID_FILE"
    fi
}

check_health() {
    curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/health" 2>/dev/null
}

check_external() {
    curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "https://oclaw.mochencloud.cn:1443/onboard/" 2>/dev/null
}

# Parse arguments
case "${1:-start}" in
    start)
        stop_server 2>/dev/null
        start_server
        sleep 2
        
        # Wait for server to be ready
        for i in $(seq 1 $MAX_RETRIES); do
            HEALTH=$(check_health)
            if [ "$HEALTH" = "200" ]; then
                echo "✓ Dashboard service ready on port $PORT"
                
                # Check external access
                EXTERNAL=$(check_external)
                if [ "$EXTERNAL" = "200" ]; then
                    echo "✓ External access OK: https://oclaw.mochencloud.cn:1443/onboard/"
                else
                    echo "⚠ External access issue: https returned $EXTERNAL"
                fi
                exit 0
            fi
            echo "Waiting for service... ($i/$MAX_RETRIES)"
            sleep $RETRY_DELAY
        done
        
        echo "✗ Service failed to start. Check $LOG_FILE"
        exit 1
        ;;
    stop)
        stop_server
        echo "Dashboard service stopped"
        ;;
    restart)
        stop_server
        sleep 1
        start_server
        ;;
    status)
        if [ -f "$PID_FILE" ]; then
            PID=$(cat "$PID_FILE")
            if kill -0 "$PID" 2>/dev/null; then
                HEALTH=$(check_health)
                EXTERNAL=$(check_external)
                echo "Dashboard service: RUNNING (PID $PID)"
                echo "  Local health: $HEALTH"
                echo "  External access: $EXTERNAL"
            else
                echo "Dashboard service: NOT RUNNING (stale PID file)"
            fi
        else
            echo "Dashboard service: NOT RUNNING"
        fi
        ;;
    log)
        if [ -f "$LOG_FILE" ]; then
            tail -50 "$LOG_FILE"
        else
            echo "No log file found"
        fi
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|log}"
        exit 1
        ;;
esac
