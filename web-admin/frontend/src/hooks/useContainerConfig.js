import { useState, useCallback, useEffect } from "react";

const API_BASE = `${window.location.protocol}//${window.location.hostname}:${window.location.port}`;

function useContainerConfig() {
  const [registry, setRegistry] = useState(null);
  const [userConfig, setUserConfig] = useState(null);
  const [validationStatus, setValidationStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [regRes, configRes, validateRes] = await Promise.all([
        fetch(`${API_BASE}/api/registry`),
        fetch(`${API_BASE}/api/config/raw`),
        fetch(`${API_BASE}/api/config/validate`),
      ]);

      if (!regRes.ok || !configRes.ok || !validateRes.ok) {
        throw new Error("Failed to fetch configuration data");
      }

      setRegistry(await regRes.json());
      setUserConfig(await configRes.json());
      setValidationStatus(await validateRes.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const updateSharedVars = useCallback(async (vars) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/config/shared`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      });
      if (!res.ok) throw new Error("Failed to save shared config");
      await fetchConfig();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }, [fetchConfig]);

  const updateContainer = useCallback(async (name, config) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/config/container/${name}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!res.ok) throw new Error("Failed to save container config");
      const result = await res.json();
      await fetchConfig();
      return result;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setSaving(false);
    }
  }, [fetchConfig]);

  const updateMounts = useCallback(async (mounts) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/config/mounts`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mounts }),
      });
      if (!res.ok) throw new Error("Failed to save mounts");
      await fetchConfig();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }, [fetchConfig]);

  return {
    registry,
    userConfig,
    validationStatus,
    loading,
    saving,
    error,
    fetchConfig,
    updateSharedVars,
    updateContainer,
    updateMounts,
  };
}

export default useContainerConfig;
