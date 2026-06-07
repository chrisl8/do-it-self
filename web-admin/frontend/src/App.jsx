import React, { useContext, useState, useEffect } from "react";
import {
  BrowserRouter,
  Route,
  Routes,
  Navigate,
  useNavigate,
  useLocation,
} from "react-router-dom";
import Box from "@mui/material/Box";
import Tabs from "@mui/material/Tabs";
import Tab from "@mui/material/Tab";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Brightness4Icon from "@mui/icons-material/Brightness4";
import Brightness7Icon from "@mui/icons-material/Brightness7";
import { ColorModeContext } from "./main";
import DockerStatus from "./DockerStatus";
import BackupStatus from "./BackupStatus";
import BackupPi from "./BackupPi";
import BackupCoverage from "./BackupCoverage";
import ContainerConfig from "./ContainerConfig";
import Browse from "./Browse";
import Sources from "./Sources";
import MediaStaging from "./MediaStaging";
import BorgNotConfiguredBanner from "./BorgNotConfiguredBanner";
import useDockerStatus from "./hooks/useDockerStatus";

const routes = [
  { path: "/docker-status", label: "Dashboard" },
  { path: "/container-config", label: "Configuration" },
  { path: "/browse", label: "Browse" },
  { path: "/sources", label: "Sources" },
  { path: "/backup-status", label: "Backups" },
  { path: "/backup-pi", label: "Backup Pi" },
  { path: "/backup-coverage", label: "Coverage" },
  // Niche, per-host feature: only show the tab where a mediaStaging config
  // block exists (the receiver host). Keeps it out of the way for everyone
  // else, including the source host and any other deployment of this code.
  { path: "/media-staging", label: "Media Staging", gated: "mediaStaging" },
];

const Navigation = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { mode, toggleColorMode } = useContext(ColorModeContext);

  const [mediaStagingEnabled, setMediaStagingEnabled] = useState(false);
  useEffect(() => {
    fetch("/api/media-staging/config")
      .then((r) => r.json())
      .then((d) => setMediaStagingEnabled(!!d.enabled))
      .catch(() => setMediaStagingEnabled(false));
  }, []);

  // Per-page browser tab title (was hard-coded "Docker Status" for the whole
  // app, which is just one of many pages).
  useEffect(() => {
    const SITE = "Container Web Admin";
    const match =
      routes.find((r) => location.pathname === r.path) ||
      routes.find((r) => location.pathname.startsWith(r.path + "/"));
    document.title = match ? `${match.label} · ${SITE}` : SITE;
  }, [location.pathname]);

  const visibleRoutes = routes.filter(
    (r) => r.gated !== "mediaStaging" || mediaStagingEnabled,
  );
  const currentTab = visibleRoutes.findIndex(
    (r) => r.path === location.pathname,
  );

  return (
    <Box
      sx={{
        borderBottom: 1,
        borderColor: "divider",
        display: "flex",
        alignItems: "center",
      }}
    >
      <Tabs
        value={currentTab === -1 ? 0 : currentTab}
        onChange={(e, val) => navigate(visibleRoutes[val].path)}
        variant="scrollable"
        scrollButtons="auto"
        allowScrollButtonsMobile
        sx={{ flexGrow: 1, minWidth: 0 }}
      >
        {visibleRoutes.map((r) => (
          <Tab key={r.path} label={r.label} />
        ))}
      </Tabs>
      <Tooltip
        title={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      >
        <IconButton
          onClick={toggleColorMode}
          color="inherit"
          sx={{ mx: 1 }}
          aria-label="toggle color mode"
        >
          {mode === "dark" ? <Brightness7Icon /> : <Brightness4Icon />}
        </IconButton>
      </Tooltip>
    </Box>
  );
};

const App = () => {
  const {
    dockerStatus,
    getDockerStatus,
    restartDockerStack,
    restartDockerStackWithUpgrade,
    restartStatus,
    clearRestartStatus,
    updateAllStatus,
    startUpdateAll,
    updateAllAction,
    cancelUpdateAll,
    dismissUpdateAll,
    startAllStatus,
    startAllEnabled,
    cancelStartAll,
    dismissStartAll,
    tailscalePreflightStatus,
    runTailscalePreflight,
    connectionState,
    isLoading,
    releaseNotes,
    releaseNotesLoading,
    fetchReleaseNotes,
    clearReleaseNotes,
  } = useDockerStatus();

  return (
    <BrowserRouter>
      <Navigation />
      <BorgNotConfiguredBanner />
      <Routes>
        <Route path="/" element={<Navigate to="/docker-status" replace />} />
        <Route
          path="/docker-status"
          element={
            <DockerStatus
              dockerStatus={dockerStatus}
              getDockerStatus={getDockerStatus}
              restartDockerStack={restartDockerStack}
              restartDockerStackWithUpgrade={restartDockerStackWithUpgrade}
              restartStatus={restartStatus}
              clearRestartStatus={clearRestartStatus}
              updateAllStatus={updateAllStatus}
              startUpdateAll={startUpdateAll}
              updateAllAction={updateAllAction}
              cancelUpdateAll={cancelUpdateAll}
              dismissUpdateAll={dismissUpdateAll}
              startAllStatus={startAllStatus}
              startAllEnabled={startAllEnabled}
              cancelStartAll={cancelStartAll}
              dismissStartAll={dismissStartAll}
              tailscalePreflightStatus={tailscalePreflightStatus}
              runTailscalePreflight={runTailscalePreflight}
              connectionState={connectionState}
              isLoading={isLoading}
              releaseNotes={releaseNotes}
              releaseNotesLoading={releaseNotesLoading}
              fetchReleaseNotes={fetchReleaseNotes}
              clearReleaseNotes={clearReleaseNotes}
            />
          }
        />
        <Route
          path="/container-config"
          element={
            <ContainerConfig
              tailscalePreflightStatus={tailscalePreflightStatus}
              runTailscalePreflight={runTailscalePreflight}
              restartDockerStack={restartDockerStack}
            />
          }
        />
        <Route path="/browse" element={<Browse />} />
        <Route path="/sources" element={<Sources />} />
        <Route path="/backup-status" element={<BackupStatus />} />
        <Route path="/backup-pi" element={<BackupPi />} />
        <Route path="/backup-coverage" element={<BackupCoverage />} />
        <Route path="/backup-coverage/:host" element={<BackupCoverage />} />
        <Route path="/media-staging" element={<MediaStaging />} />
      </Routes>
    </BrowserRouter>
  );
};

export default App;
