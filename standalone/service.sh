#!/bin/sh
BASE=/media/developer/magic-fire
SUPERVISOR=/tmp/magic-fire-supervisor.pid
CHILD=/tmp/magic-fire-node.pid
export PYTHONDONTWRITEBYTECODE=1

running() {
    [ -r "$SUPERVISOR" ] || return 1
    read -r supervisor_pid < "$SUPERVISOR"
    [ -r "/proc/$supervisor_pid/cmdline" ] || return 1
    tr '\000' ' ' < "/proc/$supervisor_pid/cmdline" | grep -q 'service.sh supervise'
}

case "$1" in
    start)
        if running; then exit 0; fi
        nohup /bin/sh "$BASE/service.sh" supervise </dev/null >>/tmp/magic-fire.log 2>&1 &
        echo "$!" > "$SUPERVISOR"
        ;;
    supervise)
        child_pid=
        finish() {
            trap - TERM INT
            if [ -n "$child_pid" ]; then
                kill -TERM "$child_pid" 2>/dev/null
                wait "$child_pid" 2>/dev/null
            fi
            rm -f "$SUPERVISOR" "$CHILD"
            exit 0
        }
        trap finish TERM INT
        cd "$BASE" || exit 1
        while :; do
            /usr/bin/node "$BASE/bridge.js" &
            child_pid=$!
            echo "$child_pid" > "$CHILD"
            wait "$child_pid"
            child_pid=
            rm -f "$CHILD"
            sleep 5 &
            wait "$!"
        done
        ;;
    stop)
        if running; then
            kill -TERM "$supervisor_pid"
            attempt=0
            while kill -0 "$supervisor_pid" 2>/dev/null && [ "$attempt" -lt 20 ]; do
                sleep 1
                attempt=$((attempt + 1))
            done
        fi
        ;;
    status)
        if running; then
            echo "Magic Fire supervisor running (PID $supervisor_pid)"
            if [ -r "$CHILD" ]; then
                read -r child_pid < "$CHILD"
                echo "Bridge PID $child_pid"
            fi
        else
            echo 'Magic Fire is stopped'
            exit 1
        fi
        ;;
    *)
        echo 'Usage: service.sh start|stop|status' >&2
        exit 2
        ;;
esac
