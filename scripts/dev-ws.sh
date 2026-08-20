#!/bin/bash
set -e

if ! command -v nats-server > /dev/null 2>&1; then
    echo "nats-server not found on PATH." >&2
    echo "  macOS:  brew install nats-server" >&2
    echo "  other:  https://github.com/nats-io/nats-server/releases" >&2
    exit 1
fi

# Create a temporary NATS config with JetStream and WebSocket support
TMPDIR=$(mktemp -d)
CONFIG_FILE="${TMPDIR}/nats.conf"

# Registered before the server starts, not after: nats-server blocks until
# Ctrl-C, so a trap set below it would never be installed in time to run.
trap 'rm -rf "$TMPDIR"' EXIT

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
echo "Then open: http://localhost:5173/?ws=ws://127.0.0.1:9222"
echo "To stop, press Ctrl+C"
echo ""

nats-server -c "$CONFIG_FILE"
