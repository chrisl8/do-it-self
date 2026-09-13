import { useCallback, useEffect, useState } from "react";

const useWatchStats = () => {
  const [data, setData] = useState({ enabled: false, users: [], items: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback((forceRefresh = false) => {
    setLoading(true);
    return fetch(`/api/watch-stats${forceRefresh ? "?refresh=1" : ""}`)
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { ...data, loading, error, refresh };
};

export default useWatchStats;
