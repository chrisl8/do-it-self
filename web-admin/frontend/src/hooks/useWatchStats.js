import { useCallback, useEffect, useState } from "react";

// `enabled: null` means "haven't heard back yet" — distinct from `false`
// ("genuinely not configured"), so the UI can show a loading state instead
// of falsely claiming it's unconfigured while the first (often slow, see
// watchStats.js) query is still in flight.
const useWatchStats = () => {
  const [data, setData] = useState({ enabled: null, users: [], items: [] });
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
