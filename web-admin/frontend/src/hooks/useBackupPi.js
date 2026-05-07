import { useState, useEffect, useCallback, useRef } from "react";

// Subscribes to the backend's WebSocket for backup-pi status pushes
// (data.backuppi from the broadcast `status` message) and for the
// per-action streaming messages (backupPiActionStarted /
// backupPiActionOutput / backupPiActionResult). Mirrors the dedicated-WS
// pattern used by useGitStatus — the page is self-contained, so its own
// WS connection is fine.
const useBackupPi = () => {
  const [status, setStatus] = useState(null);
  const [connectionState, setConnectionState] = useState("connecting");
  const [actionInFlight, setActionInFlight] = useState(null); // action name or null
  const [output, setOutput] = useState([]); // array of {stream, chunk}
  const [lastResult, setLastResult] = useState(null); // {action, success, exitCode, error}
  const wsRef = useRef(null);

  const clearOutput = useCallback(() => {
    setOutput([]);
    setLastResult(null);
  }, []);

  const runAction = useCallback((action) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setLastResult({
        action,
        success: false,
        error: "WebSocket not connected",
      });
      return;
    }
    setOutput([]);
    setLastResult(null);
    setActionInFlight(action);
    wsRef.current.send(
      JSON.stringify({ type: "backupPiAction", payload: { action } }),
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
      ws.onerror = () => {
        ws.close();
      };

      ws.onmessage = (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        if (data.type === "status" && data.backuppi !== undefined) {
          setStatus(data.backuppi);
        } else if (data.type === "backupPiActionStarted") {
          setActionInFlight(data.action);
          setOutput([]);
          setLastResult(null);
        } else if (data.type === "backupPiActionOutput") {
          setOutput((prev) => [
            ...prev,
            { stream: data.stream || "stdout", chunk: data.chunk || "" },
          ]);
        } else if (data.type === "backupPiActionResult") {
          setActionInFlight(null);
          setLastResult({
            action: data.action,
            success: !!data.success,
            exitCode: data.exitCode,
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
    actionInFlight,
    output,
    lastResult,
    runAction,
    clearOutput,
  };
};

export default useBackupPi;
