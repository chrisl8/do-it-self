import { useState, useEffect, useCallback, useRef } from "react";

// Subscribes to backupCoverage broadcasts and provides acknowledge /
// unacknowledge actions. Mirrors useBackupPi's per-page WS pattern.
const useBackupCoverage = () => {
  const [status, setStatus] = useState(null);
  const [connectionState, setConnectionState] = useState("connecting");
  const [lastAckResult, setLastAckResult] = useState(null); // {path, ok, error}
  const wsRef = useRef(null);

  const clearAckResult = useCallback(() => setLastAckResult(null), []);

  const acknowledge = useCallback((path, reason) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setLastAckResult({ path, ok: false, error: "WebSocket not connected" });
      return;
    }
    wsRef.current.send(
      JSON.stringify({
        type: "backupCoverageAcknowledge",
        payload: { path, reason: reason || "" },
      }),
    );
  }, []);

  const unacknowledge = useCallback((path) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setLastAckResult({ path, ok: false, error: "WebSocket not connected" });
      return;
    }
    wsRef.current.send(
      JSON.stringify({
        type: "backupCoverageUnacknowledge",
        payload: { path },
      }),
    );
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
        if (data.type === "status" && data.backupCoverage !== undefined) {
          setStatus(data.backupCoverage);
        } else if (
          data.type === "backupCoverageAcknowledgeResult" ||
          data.type === "backupCoverageUnacknowledgeResult"
        ) {
          setLastAckResult({
            path: data.path,
            ok: !!data.ok,
            error: data.error,
          });
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

  return {
    status,
    connectionState,
    acknowledge,
    unacknowledge,
    lastAckResult,
    clearAckResult,
  };
};

export default useBackupCoverage;
