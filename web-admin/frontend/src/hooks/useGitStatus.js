import { useState, useEffect, useCallback, useMemo } from "react";

const useGitStatus = () => {
  const [gitStatus, setGitStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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

  useEffect(() => {
    fetchGitStatus();
  }, [fetchGitStatus]);

  const dirtyRepos = useMemo(
    () => gitStatus?.repos?.filter((r) => !r.clean) || [],
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
  };
};

export default useGitStatus;
