#!/bin/bash
set -e

# Create a temporary NATS config with JetStream and WebSocket support
TMPDIR=$(mktemp -d)
CONFIG_FILE="${TMPDIR}/nats.conf"

cat > "$CONFIG_FILE" << 'EOF'
# Development NATS server config with JetStream and WebSocket
jetstream {}

websocket {
    port: 9222
    no_tls: true
}

# Standard client port (alternative to default 4222)
port: 4348
EOF

echo "NATS config written to: $CONFIG_FILE"
echo ""
echo "Starting NATS server with JetStream and WebSocket support..."
echo "  - Client port: 4348"
echo "  - WebSocket port: 9222 (no TLS)"
echo ""
echo "To stop, press Ctrl+C"
echo ""

# Start nats-server with the temp config
/opt/homebrew/bin/nats-server -c "$CONFIG_FILE"

# Cleanup on exit
trap "rm -rf '$TMPDIR'" EXIT
