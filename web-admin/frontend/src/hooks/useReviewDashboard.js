import { useCallback, useEffect, useState } from "react";

// Plain REST poll-on-demand hook (no WS push — this dashboard is opened
// occasionally, not watched live, so a manual refresh is enough).
const useReviewDashboard = () => {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(() => {
    setLoading(true);
    return fetch("/api/review-dashboard")
      .then((r) => r.json())
      .then((d) => {
        setItems(Array.isArray(d.items) ? d.items : []);
        setError(d.error || null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const deleteFromDeepthought = useCallback(
    (id) =>
      fetch(`/api/copy-history/${encodeURIComponent(id)}/remote`, {
        method: "DELETE",
      })
        .then((r) => r.json())
        .then((result) => {
          if (result.ok) refresh();
          return result;
        }),
    [refresh],
  );

  return { items, loading, error, refresh, deleteFromDeepthought };
};

export default useReviewDashboard;
