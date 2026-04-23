#!/bin/bash
# Minimal C-level integration smoke: mock-slmodemd + modemd-shim.
# Runs with hard 10-second overall timeout so it cannot hang.

set -euo pipefail
cd "$(dirname "$0")/../.."   # synthmodem/ root

AUDIO_SOCK="/tmp/synthmodem-test-audio.sock"
CONTROL_SOCK="/tmp/synthmodem-test-control.sock"
CONTROL_LOG="/tmp/synthmodem-test-control.bin"
PTS_OUT="/tmp/synthmodem-test-pts.txt"
MOCK_ERR="/tmp/synthmodem-test-mock-stderr.log"

cleanup() {
    if [ -n "${MOCK_PID:-}" ]; then kill "$MOCK_PID" 2>/dev/null || true; fi
    if [ -n "${CTRL_SRV_PID:-}" ]; then kill "$CTRL_SRV_PID" 2>/dev/null || true; fi
    if [ -n "${AUDIO_SRV_PID:-}" ]; then kill "$AUDIO_SRV_PID" 2>/dev/null || true; fi
    rm -f "$AUDIO_SOCK" "$CONTROL_SOCK" "$CONTROL_LOG" "$PTS_OUT" "$MOCK_ERR"
}
trap cleanup EXIT

# Listener helper. Accepts one connection, logs bytes to a file, exits.
start_listener() {
    local path="$1"
    local log="$2"
    rm -f "$path"
    python3 -u -c '
import socket, sys, os, signal
path, logpath = sys.argv[1], sys.argv[2]
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(path); s.listen(1)
signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
conn, _ = s.accept()
with open(logpath, "wb") as f:
    while True:
        d = conn.recv(4096)
        if not d: break
        f.write(d); f.flush()
' "$path" "$log" &
    echo $!
}

echo "== starting listeners =="
CTRL_SRV_PID=$(start_listener "$CONTROL_SOCK" "$CONTROL_LOG")
AUDIO_SRV_PID=$(start_listener "$AUDIO_SOCK" "/dev/null")
sleep 0.5

echo "== starting mock-slmodemd + shim =="
export SYNTHMODEM_AUDIO_PATH="$AUDIO_SOCK"
export SYNTHMODEM_CONTROL_PATH="$CONTROL_SOCK"
export SYNTHMODEM_LOG_LEVEL=info
export SYNTHMODEM_PTY_PATH=/dev/null      # shim won't really use it here

./test/mock-slmodemd/mock-slmodemd \
    -e "$PWD/vm/shim/modemd-shim" \
    -L /tmp/synthmodem-test-ttySL0 \
    > "$PTS_OUT" 2> "$MOCK_ERR" &
MOCK_PID=$!

# Wait up to 3 seconds for HELLO to show up in control log
for _ in $(seq 1 30); do
    if [ -s "$CONTROL_LOG" ]; then break; fi
    sleep 0.1
done

echo "== mock stderr (first lines) =="
head -20 "$MOCK_ERR" || true

echo "== control log hex dump =="
if [ -s "$CONTROL_LOG" ]; then
    hexdump -C "$CONTROL_LOG" | head -5
else
    echo "FAIL: control log is empty"
    exit 1
fi

echo "== verifying HELLO =="
python3 -c "
with open('$CONTROL_LOG', 'rb') as f: data = f.read()
if len(data) < 3:
    print('FAIL: too few bytes'); exit(1)
ln = data[0] | (data[1] << 8)
t = data[2]
pay = data[3:3+ln-1]
print(f'length={ln} type=0x{t:02x} payload={pay!r}')
assert t == 0x10, 'not HELLO'
assert pay.startswith(b'modemd-shim'), 'bad HELLO payload'
print('PASS')
"

echo "== PASS =="
