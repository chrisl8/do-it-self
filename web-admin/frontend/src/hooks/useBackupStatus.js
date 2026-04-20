import { useState, useEffect, useCallback } from "react";

const useBackupStatus = () => {
  const [kopiaStatus, setKopiaStatus] = useState(null);
  const [kopiaLog, setKopiaLog] = useState(null);
  const [borgStatus, setBorgStatus] = useState(null);
  const [borgLog, setBorgLog] = useState(null);
  const [kopiaCheckRunning, setKopiaCheckRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [kopiaRes, borgRes] = await Promise.all([
        fetch("/api/kopia-status"),
        fetch("/api/borg-status"),
      ]);
      if (kopiaRes.ok) setKopiaStatus(await kopiaRes.json());
      if (borgRes.ok) setBorgStatus(await borgRes.json());
      if (!kopiaRes.ok && !borgRes.ok) throw new Error("Failed to fetch backup status");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchKopiaLog = useCallback(async () => {
    try {
      const res = await fetch("/api/kopia-log");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setKopiaLog(data.log);
    } catch (err) {
      setKopiaLog([`Error loading log: ${err.message}`]);
    }
  }, []);

  const fetchBorgLog = useCallback(async () => {
    try {
      const res = await fetch("/api/borg-log");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setBorgLog(data.log);
    } catch (err) {
      setBorgLog([`Error loading log: ${err.message}`]);
    }
  }, []);

  const [ignoreHosts, setIgnoreHosts] = useState(null);
  const [hostThresholds, setHostThresholds] = useState({});
  const [healthcheckUrls, setHealthcheckUrls] = useState({
    kopia: null,
    borg: null,
    borgRestore: null,
  });
  const [healthcheckAvailable, setHealthcheckAvailable] = useState(true);
  const [borgBannerDismissed, setBorgBannerDismissed] = useState(false);

  const fetchBorgBannerDismissed = useCallback(async () => {
    try {
      const res = await fetch("/api/config/borg-banner-dismiss");
      if (!res.ok) return;
      const data = await res.json();
      setBorgBannerDismissed(data.dismissed === true);
    } catch {
      // non-critical
    }
  }, []);

  const saveBorgBannerDismissed = useCallback(async (dismissed) => {
    const res = await fetch("/api/config/borg-banner-dismiss", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dismissed }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Failed to save banner preference");
    setBorgBannerDismissed(dismissed);
  }, []);

  const fetchHealthcheckUrls = useCallback(async () => {
    try {
      const res = await fetch("/api/config/backup-healthchecks");
      if (!res.ok) return;
      const data = await res.json();
      setHealthcheckAvailable(data.available !== false);
      if (data.available !== false) {
        setHealthcheckUrls({
          kopia: data.kopia ?? "",
          borg: data.borg ?? "",
          borgRestore: data.borgRestore ?? "",
        });
      }
    } catch {
      // non-critical
    }
  }, []);

  const saveHealthcheckUrls = useCallback(async (partial) => {
    const res = await fetch("/api/config/backup-healthchecks", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(partial),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Failed to save healthcheck URL");
    setHealthcheckUrls((prev) => ({ ...prev, ...partial }));
  }, []);

  const fetchIgnoreHosts = useCallback(async () => {
    try {
      const res = await fetch("/api/kopia-ignore-hosts");
      if (res.ok) {
        const data = await res.json();
        setIgnoreHosts(data.hosts);
      }
    } catch {
      // non-critical, ignore
    }
  }, []);

  const fetchHostThresholds = useCallback(async () => {
    try {
      const res = await fetch("/api/kopia-host-thresholds");
      if (res.ok) {
        setHostThresholds(await res.json());
      }
    } catch {
      // non-critical
    }
  }, []);

  const saveHostThresholds = useCallback(async (thresholds) => {
    const res = await fetch("/api/kopia-host-thresholds", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thresholds }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to save host thresholds");
    setHostThresholds(thresholds);
    return data;
  }, []);

  const saveIgnoreHosts = useCallback(async (hosts) => {
    const res = await fetch("/api/kopia-ignore-hosts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hosts }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to save ignore hosts");
    setIgnoreHosts(hosts);
    return data;
  }, []);

  const saveKopiaThreshold = useCallback(async (hours) => {
    const res = await fetch("/api/kopia-threshold", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threshold: hours }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to save threshold");
    return data;
  }, []);

  const runKopiaCheck = useCallback(async () => {
    setKopiaCheckRunning(true);
    try {
      const res = await fetch("/api/kopia-check", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Check failed");
      // Re-fetch status after check completes
      const statusRes = await fetch("/api/kopia-status");
      if (statusRes.ok) setKopiaStatus(await statusRes.json());
      // Clear cached log so next view gets fresh data
      setKopiaLog(null);
      return data;
    } catch (err) {
      throw err;
    } finally {
      setKopiaCheckRunning(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchIgnoreHosts();
    fetchHostThresholds();
    fetchHealthcheckUrls();
    fetchBorgBannerDismissed();
  }, [fetchStatus, fetchIgnoreHosts, fetchHostThresholds, fetchHealthcheckUrls, fetchBorgBannerDismissed]);

  return {
    kopiaStatus,
    kopiaLog,
    borgStatus,
    borgLog,
    kopiaCheckRunning,
    loading,
    error,
    refresh: fetchStatus,
    fetchKopiaLog,
    fetchBorgLog,
    ignoreHosts,
    hostThresholds,
    runKopiaCheck,
    saveKopiaThreshold,
    saveIgnoreHosts,
    saveHostThresholds,
    healthcheckUrls,
    healthcheckAvailable,
    saveHealthcheckUrls,
    borgBannerDismissed,
    saveBorgBannerDismissed,
  };
};

export default useBackupStatus;
