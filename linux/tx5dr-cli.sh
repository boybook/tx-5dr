#!/bin/bash
# /usr/bin/tx5dr — TX-5DR service management CLI

set -euo pipefail

# Load config for HTTP port if available
if [[ -f /etc/tx5dr/config.env ]]; then
    # shellcheck disable=SC1091
    source /etc/tx5dr/config.env 2>/dev/null || true
fi

HTTP_PORT="${TX5DR_HTTP_PORT:-8076}"

case "${1:-help}" in
    start)
        sudo systemctl start tx5dr
        echo "TX-5DR started. Web UI: http://localhost:${HTTP_PORT}"
        ;;
    stop)
        sudo systemctl stop tx5dr
        echo "TX-5DR stopped."
        ;;
    restart)
        sudo systemctl restart tx5dr
        echo "TX-5DR restarted. Web UI: http://localhost:${HTTP_PORT}"
        ;;
    status)
        systemctl status tx5dr
        ;;
    logs)
        journalctl -u tx5dr -f
        ;;
    enable)
        sudo systemctl enable tx5dr
        echo "TX-5DR enabled for auto-start on boot."
        ;;
    disable)
        sudo systemctl disable tx5dr
        echo "TX-5DR disabled from auto-start."
        ;;
    open)
        if command -v xdg-open &>/dev/null; then
            xdg-open "http://localhost:${HTTP_PORT}"
        else
            echo "Open http://localhost:${HTTP_PORT} in your browser."
        fi
        ;;
    version)
        if [[ -f /usr/share/tx5dr/version ]]; then
            cat /usr/share/tx5dr/version
        else
            echo "TX-5DR (version unknown)"
        fi
        ;;
    help|*)
        echo "TX-5DR Digital Radio Server"
        echo ""
        echo "Usage: tx5dr <command>"
        echo ""
        echo "Commands:"
        echo "  start    Start TX-5DR server and web UI"
        echo "  stop     Stop TX-5DR"
        echo "  restart  Restart TX-5DR"
        echo "  status   Show service status"
        echo "  logs     Follow service logs (Ctrl+C to exit)"
        echo "  enable   Enable auto-start on boot"
        echo "  disable  Disable auto-start on boot"
        echo "  open     Open web UI in browser"
        echo "  version  Show version"
        ;;
esac
