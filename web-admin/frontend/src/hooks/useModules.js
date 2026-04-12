import { useState, useCallback, useEffect } from "react";

const API_BASE = `${window.location.protocol}//${window.location.hostname}:${window.location.port}`;

async function postJson(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function deleteJson(path) {
  const res = await fetch(`${API_BASE}${path}`, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function useModules() {
  const [catalog, setCatalog] = useState(null);
  const [installed, setInstalled] = useState(null);
  const [available, setAvailable] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [catRes, instRes, availRes] = await Promise.all([
        fetch(`${API_BASE}/api/modules/catalog`),
        fetch(`${API_BASE}/api/modules/installed`),
        fetch(`${API_BASE}/api/modules/available`),
      ]);
      if (!catRes.ok || !instRes.ok || !availRes.ok) {
        throw new Error("Failed to fetch module data");
      }
      setCatalog(await catRes.json());
      setInstalled(await instRes.json());
      setAvailable(await availRes.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Every mutation resolves to { success, output, status } for the dialog.
  // After any mutation we refetch so the UI picks up the new state.
  const wrap = useCallback(
    async (op) => {
      const { ok, status, data } = await op();
      await refetch();
      return {
        success: ok,
        status,
        output: data?.output || data?.error || "",
      };
    },
    [refetch],
  );

  const addSource = useCallback(
    (url, name) => wrap(() => postJson("/api/modules/sources", { url, name })),
    [wrap],
  );

  const removeSource = useCallback(
    (name) => wrap(() => deleteJson(`/api/modules/sources/${encodeURIComponent(name)}`)),
    [wrap],
  );

  const updateSource = useCallback(
    (name) => wrap(() => postJson(`/api/modules/sources/${encodeURIComponent(name)}/update`)),
    [wrap],
  );

  const updateAllSources = useCallback(
    () => wrap(() => postJson(`/api/modules/sources/update-all`)),
    [wrap],
  );

  const regenerateRegistry = useCallback(
    () => wrap(() => postJson(`/api/modules/regenerate-registry`)),
    [wrap],
  );

  const installContainer = useCallback(
    (moduleName, containerName) =>
      wrap(() =>
        postJson(`/api/modules/containers/${encodeURIComponent(containerName)}/install`, {
          module: moduleName,
        }),
      ),
    [wrap],
  );

  const uninstallContainer = useCallback(
    (name) => wrap(() => deleteJson(`/api/modules/containers/${encodeURIComponent(name)}`)),
    [wrap],
  );

  return {
    catalog,
    installed,
    available,
    loading,
    error,
    refetch,
    addSource,
    removeSource,
    updateSource,
    updateAllSources,
    regenerateRegistry,
    installContainer,
    uninstallContainer,
  };
}

export default useModules;
