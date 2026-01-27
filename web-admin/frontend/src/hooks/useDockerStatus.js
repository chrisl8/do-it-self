import { useState, useEffect, useCallback, useRef } from "react";

function useDockerStatus() {
  const [dockerStatus, setDockerStatus] = useState({
    status: "Unknown",
    running: null,
    stacks: null,
  });
  const [connectionState, setConnectionState] = useState("connecting");
  const [isLoading, setIsLoading] = useState(true);
  const [restartStatus, setRestartStatus] = useState({});
  const socketRef = useRef(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimeout = useRef(null);

  const RECONNECT_INITIAL_DELAY = 1000;
  const RECONNECT_MAX_DELAY = 30000;

  const scheduleReconnect = useCallback(() => {
    const delay = Math.min(
      RECONNECT_INITIAL_DELAY * Math.pow(2, reconnectAttempts.current),
      RECONNECT_MAX_DELAY,
    );
    reconnectAttempts.current++;

    reconnectTimeout.current = setTimeout(() => {
      connectWebSocket();
    }, delay);
  }, []);

  const connectWebSocket = useCallback(() => {
    setConnectionState("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}`;
    const newSocket = new WebSocket(wsUrl);

    newSocket.onopen = () => {
      reconnectAttempts.current = 0;
      setConnectionState("connected");
    };

    newSocket.onclose = () => {
      setConnectionState("disconnected");
      scheduleReconnect();
    };

    newSocket.onerror = (error) => {
      setConnectionState("disconnected");
    };

    newSocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "status" && data.docker) {
          setDockerStatus({
            status: data.docker.error ? "Error" : "Online",
            running: data.docker.running,
            stacks: data.docker.stacks,
            error: data.docker.error,
          });
          if (data.restartStatus) {
            setRestartStatus(data.restartStatus);
          }
          if (data.docker.running || data.docker.stacks) {
            setIsLoading(false);
          }
        } else if (data.type === "dockerContainers") {
          setDockerStatus({
            status: "Online",
            running: data.payload.running,
            stacks: data.payload.stacks,
          });
          setIsLoading(false);
        } else if (data.type === "dockerContainersError") {
          setDockerStatus({
            status: "Error",
            running: null,
            stacks: null,
            error: data.error,
          });
          setIsLoading(false);
        } else if (data.type === "dockerStackRestartStarted") {
          setRestartStatus((prev) => ({
            ...prev,
            [data.stackName]: {
              status: "in_progress",
              operation: data.operation || "restart",
            },
          }));
        } else if (data.type === "dockerStackRestartResult") {
          setRestartStatus((prev) => ({
            ...prev,
            [data.stackName]: {
              status: data.success ? "completed" : "failed",
              operation: data.operation || "restart",
              output: data.output,
              error: data.error,
            },
          }));
        }
      } catch (error) {
        console.error("Error parsing WebSocket message:", error);
      }
    };

    socketRef.current = newSocket;
  }, [scheduleReconnect]);

  const getDockerStatus = useCallback(() => {
    setIsLoading(true);
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "getDockerContainers" }));
    }
  }, []);

  const restartDockerStack = useCallback((stackName) => {
    setRestartStatus((prev) => ({
      ...prev,
      [stackName]: { status: "requested", operation: "restart" },
    }));
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({ type: "restartDockerStack", payload: { stackName } }),
      );
    }
  }, []);

  const restartDockerStackWithUpgrade = useCallback((stackName) => {
    setRestartStatus((prev) => ({
      ...prev,
      [stackName]: { status: "requested", operation: "upgrade" },
    }));
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({
          type: "restartDockerStackWithUpgrade",
          payload: { stackName },
        }),
      );
    }
  }, []);

  const clearRestartStatus = useCallback((stackName) => {
    setRestartStatus((prev) => {
      const newStatus = { ...prev };
      delete newStatus[stackName];
      return newStatus;
    });
  }, []);

  useEffect(() => {
    connectWebSocket();

    return () => {
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current);
      }
      if (socketRef.current) {
        socketRef.current.close();
      }
    };
  }, [connectWebSocket]);

  return {
    dockerStatus,
    getDockerStatus,
    restartDockerStack,
    restartDockerStackWithUpgrade,
    restartStatus,
    clearRestartStatus,
    connectionState,
    isLoading,
  };
}

export default useDockerStatus;
