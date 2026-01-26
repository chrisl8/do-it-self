import React from 'react';
import { BrowserRouter, Route, Routes, Navigate } from 'react-router-dom';
import DockerStatus from './DockerStatus';
import useDockerStatus from './hooks/useDockerStatus';

const App = () => {
  const {
    dockerStatus,
    getDockerStatus,
    restartDockerStack,
    restartDockerStackWithUpgrade,
    restartStatus,
    clearRestartStatus,
    connectionState,
    isLoading,
  } = useDockerStatus();

  return (
    <BrowserRouter>
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
              connectionState={connectionState}
              isLoading={isLoading}
            />
          }
        />
      </Routes>
    </BrowserRouter>
  );
};

export default App;
