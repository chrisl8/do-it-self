import { useState, useEffect, useRef } from "react";

// Subscribes to backupHistory broadcasts. Read-only (no ack actions),
// mirrors useBackupCoverage's WS pattern. Also does an initial REST fetch
// so the page has data before the first websocket push.
const useBackupHistory = () => {
  const [status, setStatus] = useState(null);
  const [connectionState, setConnectionState] = useState("connecting");
  const wsRef = useRef(null);

  useEffect(() => {
    fetch("/api/backup-history")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setStatus(d);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let closed = false;
    let reconnectTimer = null;

    const connect = () => {
      setConnectionState("connecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}`);
      wsRef.current = ws;

      ws.onopen = () => setConnectionState("connected");
      ws.onclose = () => {
        setConnectionState("disconnected");
        if (closed) return;
        reconnectTimer = setTimeout(connect, 5000);
      };
      ws.onerror = () => ws.close();

      ws.onmessage = (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        if (data.type === "status" && data.backupHistory !== undefined) {
          setStatus(data.backupHistory);
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  return { status, connectionState };
};

export default useBackupHistory;
