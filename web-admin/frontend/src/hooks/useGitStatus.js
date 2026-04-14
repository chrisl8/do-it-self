import { useState, useEffect, useCallback, useMemo } from "react";

const useGitStatus = () => {
  const [gitStatus, setGitStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchGitStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/git-status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setGitStatus(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const devSync = useCallback(async (moduleName) => {
    const res = await fetch(`/api/modules/dev-sync/${encodeURIComponent(moduleName)}`, {
      method: "POST",
    });
    return await res.json();
  }, []);

  useEffect(() => {
    fetchGitStatus();
  }, [fetchGitStatus]);

  const dirtyRepos = useMemo(
    () => gitStatus?.repos?.filter((r) => !r.clean) || [],
    [gitStatus],
  );

  return {
    gitStatus,
    dirtyRepos,
    loading,
    error,
    refresh: fetchGitStatus,
    devSync,
  };
};

export default useGitStatus;
