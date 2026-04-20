import React, { useContext } from "react";
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
import ContainerConfig from "./ContainerConfig";
import Browse from "./Browse";
import Sources from "./Sources";
import BorgNotConfiguredBanner from "./BorgNotConfiguredBanner";
import useDockerStatus from "./hooks/useDockerStatus";

const routes = [
  { path: "/docker-status", label: "Dashboard" },
  { path: "/container-config", label: "Configuration" },
  { path: "/browse", label: "Browse" },
  { path: "/sources", label: "Sources" },
  { path: "/backup-status", label: "Backups" },
];

const Navigation = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { mode, toggleColorMode } = useContext(ColorModeContext);
  const currentTab = routes.findIndex((r) => r.path === location.pathname);

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
        onChange={(e, val) => navigate(routes[val].path)}
        variant="scrollable"
        scrollButtons="auto"
        allowScrollButtonsMobile
        sx={{ flexGrow: 1, minWidth: 0 }}
      >
        {routes.map((r) => (
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
      </Routes>
    </BrowserRouter>
  );
};

export default App;
