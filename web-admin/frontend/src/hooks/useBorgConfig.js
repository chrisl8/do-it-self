import { useCallback, useEffect, useState } from "react";

// Config editing for the Borg Backup Configuration section on the
// Backups page. Separate from useBackupStatus (which reads run-status)
// so the two concerns don't entangle.
const useBorgConfig = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchConfig = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/config/borg");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      setData(j);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const save = useCallback(async (patch) => {
    const res = await fetch("/api/config/borg", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Failed to save");
    await fetchConfig();
    return body;
  }, [fetchConfig]);

  const generatePassphrase = useCallback(async () => {
    const res = await fetch("/api/config/borg/passphrase/generate", {
      method: "POST",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Failed to generate");
    return body.value;
  }, []);

  const savePassphrase = useCallback(async (key, value) => {
    const res = await fetch("/api/config/borg/passphrase", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Failed to save passphrase");
    await fetchConfig();
    return body;
  }, [fetchConfig]);

  const initRepo = useCallback(async () => {
    const res = await fetch("/api/borg/init-repo", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Failed to run setup");
    return body;
  }, []);

  const runBackupNow = useCallback(async () => {
    const res = await fetch("/api/borg/run-now", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Failed to start backup");
    return body;
  }, []);

  return {
    data,
    loading,
    error,
    refresh: fetchConfig,
    save,
    generatePassphrase,
    savePassphrase,
    initRepo,
    runBackupNow,
  };
};

export default useBorgConfig;

// Fetches a (cached) `du -sh` for a single path. Rendered per-row in the
// backup-paths editor; callers debounce/throttle so a full list of 12
// paths doesn't all kick off du at once on first paint.
export const usePathSize = (path, { enabled = true } = {}) => {
  const [size, setSize] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !path) return;
    let cancelled = false;
    setLoading(true);
    const url = `/api/borg/path-size?path=${encodeURIComponent(path)}`;
    fetch(url)
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled) setSize(j.size || "?");
      })
      .catch(() => {
        if (!cancelled) setSize("?");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, enabled]);

  return { size, loading };
};
