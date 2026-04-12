import React, { useState, useMemo } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import CardActions from "@mui/material/CardActions";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Alert from "@mui/material/Alert";
import Divider from "@mui/material/Divider";
import useModules from "./hooks/useModules";
import ModuleOperationDialog from "./ModuleOperationDialog";

// Placeholder for issue #2 (required_accounts in module.yaml). Returns
// nothing today since the field is not populated in any module. Keeps
// the rendering slot reserved so it lands without another UI change.
function RequiredAccounts({ container }) {
  const accounts = container.required_accounts || [];
  if (accounts.length === 0) return null;
  return (
    <Box sx={{ mt: 1 }}>
      <Typography variant="caption" color="text.secondary">
        Requires accounts: {accounts.join(", ")}
      </Typography>
    </Box>
  );
}

function AvailableCard({ container, onInstall, disabled }) {
  const features = [];
  if (container.uses_tailscale) features.push("Tailscale");
  return (
    <Card variant="outlined" sx={{ mb: 1.5 }}>
      <CardContent sx={{ pb: 1 }}>
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1 }}>
          <Typography variant="h6" component="div">
            {container.name}
          </Typography>
          <Chip
            size="small"
            label={container.source_module}
            variant="outlined"
          />
        </Box>
        {container.description && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {container.description}
          </Typography>
        )}
        {features.length > 0 && (
          <Box sx={{ mt: 1, display: "flex", gap: 0.5, flexWrap: "wrap" }}>
            {features.map((f) => (
              <Chip key={f} size="small" label={f} />
            ))}
          </Box>
        )}
        <RequiredAccounts container={container} />
      </CardContent>
      <CardActions sx={{ px: 2, pb: 1.5 }}>
        <Button
          variant="contained"
          size="small"
          disabled={disabled}
          onClick={() => onInstall(container)}
        >
          Install
        </Button>
      </CardActions>
    </Card>
  );
}

function Browse() {
  const { available, loading, error, installContainer } = useModules();
  const [dialog, setDialog] = useState({ open: false, title: "", running: false, result: null });

  const containersByGroup = useMemo(() => {
    const list = available?.containers || [];
    const grouped = {};
    for (const c of list) {
      const group = c.homepage_group || "Uncategorized";
      if (!grouped[group]) grouped[group] = [];
      grouped[group].push(c);
    }
    for (const group of Object.keys(grouped)) {
      grouped[group].sort((a, b) => a.name.localeCompare(b.name));
    }
    return grouped;
  }, [available]);

  const sortedGroups = Object.keys(containersByGroup).sort((a, b) => a.localeCompare(b));

  const handleInstall = async (container) => {
    setDialog({
      open: true,
      title: `Installing ${container.name}...`,
      running: true,
      result: null,
    });
    const result = await installContainer(container.source_module, container.name);
    setDialog((prev) => ({
      ...prev,
      title: result.success
        ? `Installed ${container.name}`
        : `Failed to install ${container.name}`,
      running: false,
      result,
    }));
  };

  const closeDialog = () => setDialog({ open: false, title: "", running: false, result: null });

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", mt: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="error">{error}</Alert>
      </Box>
    );
  }

  const totalAvailable = (available?.containers || []).length;

  return (
    <Box sx={{ p: 2, maxWidth: 1200, margin: "0 auto" }}>
      <Typography variant="h5" sx={{ mb: 1 }}>
        Browse Containers
      </Typography>
      <Alert severity="info" sx={{ mb: 2 }}>
        Containers available from your added module sources. Click Install to
        copy a container into the platform. It will appear in My Containers as
        disabled — enable it there and run <code>all-containers.sh --start</code>
        {" "}to bring it up.
      </Alert>

      {totalAvailable === 0 ? (
        <Alert severity="success">
          All available containers from your added sources are already installed.
          Add another source on the Sources page to browse more.
        </Alert>
      ) : (
        sortedGroups.map((group) => (
          <Box key={group} sx={{ mb: 3 }}>
            <Typography variant="h6" sx={{ mb: 1 }}>
              {group}
            </Typography>
            <Divider sx={{ mb: 1.5 }} />
            {containersByGroup[group].map((c) => (
              <AvailableCard
                key={`${c.source_module}/${c.name}`}
                container={c}
                onInstall={handleInstall}
                disabled={dialog.running}
              />
            ))}
          </Box>
        ))
      )}

      <ModuleOperationDialog
        open={dialog.open}
        title={dialog.title}
        running={dialog.running}
        result={dialog.result}
        onClose={closeDialog}
      />
    </Box>
  );
}

export default Browse;
