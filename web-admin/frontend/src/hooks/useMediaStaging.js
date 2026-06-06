import { useState, useEffect, useCallback, useRef } from "react";

// Dedicated WebSocket for the Media Staging page. The copy queue and disk
// usage come from the broadcast `status.mediaStaging` snapshot, which the
// backend rebuilds from the SSH spool (transfers run on the source host and
// write status back). startCopy / cancelCopy write requests into that spool.
// The only per-socket message we handle is an enqueue-level error (e.g. the
// source Jellyfin is unreachable, or a selection couldn't be resolved).
const useMediaStaging = () => {
  const [snapshot, setSnapshot] = useState(null); // { enabled, disk, queue }
  const [connectionState, setConnectionState] = useState("connecting");
  const [enqueueError, setEnqueueError] = useState(null);
  const wsRef = useRef(null);

  const clearEnqueueError = useCallback(() => setEnqueueError(null), []);

  const startCopy = useCallback((selections) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setEnqueueError(null);
    wsRef.current.send(
      JSON.stringify({
        type: "mediaStagingStartCopy",
        payload: { selections },
      }),
    );
  }, []);

  const cancelCopy = useCallback((jobId) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(
      JSON.stringify({ type: "mediaStagingCancelCopy", payload: { jobId } }),
    );
  }, []);

  const retryCopy = useCallback((jobId) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setEnqueueError(null);
    wsRef.current.send(
      JSON.stringify({ type: "mediaStagingRetryCopy", payload: { jobId } }),
    );
  }, []);

  const dismissCopy = useCallback((jobId) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(
      JSON.stringify({ type: "mediaStagingDismissCopy", payload: { jobId } }),
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
        if (data.type === "status" && data.mediaStaging !== undefined) {
          setSnapshot(data.mediaStaging);
        } else if (
          data.type === "mediaStagingCopyResult" &&
          !data.success &&
          data.jobId == null
        ) {
          setEnqueueError(data.error || "Could not queue the copy");
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
    snapshot,
    connectionState,
    enqueueError,
    clearEnqueueError,
    startCopy,
    cancelCopy,
    retryCopy,
    dismissCopy,
  };
};

export default useMediaStaging;
