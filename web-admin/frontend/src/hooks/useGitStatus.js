import { useState, useEffect, useCallback, useMemo, useRef } from "react";

const useGitStatus = () => {
  const [gitStatus, setGitStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const wsRef = useRef(null);

  const fetchGitStatus = useCallback(async (opts = {}) => {
    setLoading(true);
    setError(null);
    try {
      const url = opts.fetch ? "/api/git-status?fetch=1" : "/api/git-status";
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setGitStatus(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshWithFetch = useCallback(() => fetchGitStatus({ fetch: true }), [fetchGitStatus]);

  const devSync = useCallback(async (moduleName) => {
    const res = await fetch(`/api/modules/dev-sync/${encodeURIComponent(moduleName)}`, {
      method: "POST",
    });
    return await res.json();
  }, []);

  const updatePlatform = useCallback(async ({ preBackup = false } = {}) => {
    const res = await fetch("/api/platform/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preBackup: !!preBackup }),
    });
    const body = await res.json().catch(() => ({}));
    return { ...body, status: res.status };
  }, []);

  const updateEverything = useCallback(async ({ preBackup = false } = {}) => {
    const res = await fetch("/api/platform/update-everything", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preBackup: !!preBackup }),
    });
    const body = await res.json().catch(() => ({}));
    return { ...body, status: res.status };
  }, []);

  useEffect(() => {
    fetchGitStatus();
  }, [fetchGitStatus]);

  // Subscribe to the backend's WebSocket push so the UI reflects the
  // background git-fetch poller's findings without a manual refresh.
  // The backend emits the full tracked-status blob on every change, so we
  // only act when data.gitStatus is present and non-null. Auto-reconnects
  // on close with a 5-second backoff.
  useEffect(() => {
    let closed = false;
    let reconnectTimer = null;
    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}`);
      wsRef.current = ws;
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "status" && data.gitStatus) {
            setGitStatus(data.gitStatus);
            setLoading(false);
          }
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        reconnectTimer = setTimeout(connect, 5000);
      };
      ws.onerror = () => { ws.close(); };
    };
    connect();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  const dirtyRepos = useMemo(
    // Explicit `=== false` so a repo with no `clean` field (older or partial
    // payload shape) doesn't accidentally get treated as dirty.
    () => gitStatus?.repos?.filter((r) => r.clean === false) || [],
    [gitStatus],
  );

  const platformRepo = useMemo(
    () => gitStatus?.repos?.find((r) => r.name === "platform") || null,
    [gitStatus],
  );

  return {
    gitStatus,
    dirtyRepos,
    platformRepo,
    loading,
    error,
    refresh: fetchGitStatus,
    refreshWithFetch,
    devSync,
    updatePlatform,
    updateEverything,
  };
};

export default useGitStatus;
