import { useState, useEffect, useCallback } from "react";

// Polls post-update maintenance findings (scripts/post-update-checks/*.sh
// output, surfaced via /api/post-update-checks) so container updates that
// need a follow-up glance don't get missed. Polling (not WebSocket) is fine
// here: findings only change right after a manual update, an infrequent
// event.
const POLL_INTERVAL_MS = 30 * 1000;

const usePostUpdateChecks = () => {
  const [byContainer, setByContainer] = useState({});

  const fetchFindings = useCallback(async () => {
    try {
      const res = await fetch("/api/post-update-checks");
      if (!res.ok) return;
      const data = await res.json();
      setByContainer(data.byContainer || {});
    } catch {
      // non-critical; keep showing the last known findings
    }
  }, []);

  const acknowledge = useCallback(
    async (container) => {
      try {
        const res = await fetch(
          `/api/post-update-checks/${encodeURIComponent(container)}/ack`,
          { method: "POST" },
        );
        if (res.ok) await fetchFindings();
      } catch {
        // non-critical
      }
    },
    [fetchFindings],
  );

  useEffect(() => {
    fetchFindings();
    const timer = setInterval(fetchFindings, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [fetchFindings]);

  return { byContainer, acknowledge };
};

export default usePostUpdateChecks;
