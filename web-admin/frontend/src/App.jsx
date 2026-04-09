import React from "react";
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
import DockerStatus from "./DockerStatus";
import BackupStatus from "./BackupStatus";
import ContainerConfig from "./ContainerConfig";
import useDockerStatus from "./hooks/useDockerStatus";

const routes = [
  { path: "/docker-status", label: "Docker Status" },
  { path: "/container-config", label: "Configuration" },
  { path: "/backup-status", label: "Backup Status" },
];

const Navigation = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const currentTab = routes.findIndex((r) => r.path === location.pathname);

  return (
    <Box sx={{ borderBottom: 1, borderColor: "divider" }}>
      <Tabs
        value={currentTab === -1 ? 0 : currentTab}
        onChange={(e, val) => navigate(routes[val].path)}
      >
        {routes.map((r) => (
          <Tab key={r.path} label={r.label} />
        ))}
      </Tabs>
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
            />
          }
        />
        <Route path="/backup-status" element={<BackupStatus />} />
      </Routes>
    </BrowserRouter>
  );
};

export default App;
