import React, { useState, useMemo } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Switch from "@mui/material/Switch";
import Button from "@mui/material/Button";
import Accordion from "@mui/material/Accordion";
import AccordionSummary from "@mui/material/AccordionSummary";
import AccordionDetails from "@mui/material/AccordionDetails";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutline";
import CircularProgress from "@mui/material/CircularProgress";
import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";
import Chip from "@mui/material/Chip";
import InputAdornment from "@mui/material/InputAdornment";
import IconButton from "@mui/material/IconButton";
import Visibility from "@mui/icons-material/Visibility";
import VisibilityOff from "@mui/icons-material/VisibilityOff";
import SaveIcon from "@mui/icons-material/Save";
import useContainerConfig from "./hooks/useContainerConfig";

function SecretField({ label, value, onChange, description }) {
  const [show, setShow] = useState(false);
  return (
    <TextField
      fullWidth
      size="small"
      label={label}
      helperText={description}
      type={show ? "text" : "password"}
      value={value || ""}
      onChange={(e) => onChange(e.target.value)}
      slotProps={{
        input: {
          endAdornment: (
            <InputAdornment position="end">
              <IconButton size="small" onClick={() => setShow(!show)}>
                {show ? <VisibilityOff /> : <Visibility />}
              </IconButton>
            </InputAdornment>
          ),
        },
      }}
    />
  );
}

function SharedVariablesSection({ registry, userConfig, onSave, saving }) {
  const sharedDefs = registry?.shared_variables || {};
  const [values, setValues] = useState(userConfig?.shared || {});
  const [dirty, setDirty] = useState(false);

  const handleChange = (name, value) => {
    setValues((prev) => ({ ...prev, [name]: value }));
    setDirty(true);
  };

  const handleSave = () => {
    onSave(values);
    setDirty(false);
  };

  return (
    <Box sx={{ mb: 3 }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          mb: 1,
        }}
      >
        <Typography variant="h6">Shared Variables</Typography>
        <Button
          variant="contained"
          size="small"
          startIcon={saving ? <CircularProgress size={16} /> : <SaveIcon />}
          disabled={!dirty || saving}
          onClick={handleSave}
        >
          Save
        </Button>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        These apply to every container that needs them. Saving updates all
        container .env files automatically.
      </Typography>
      <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}>
        {Object.entries(sharedDefs).map(([name, def]) => {
          if (def.type === "secret") {
            return (
              <SecretField
                key={name}
                label={name}
                description={def.description}
                value={values[name]}
                onChange={(val) => handleChange(name, val)}
              />
            );
          }
          return (
            <TextField
              key={name}
              fullWidth
              size="small"
              label={name}
              helperText={def.description}
              value={values[name] || ""}
              onChange={(e) => handleChange(name, e.target.value)}
              placeholder={def.default || ""}
            />
          );
        })}
      </Box>
    </Box>
  );
}

function ReadinessBadge({ status }) {
  if (!status) return null;
  if (!status.enabled) {
    return (
      <Chip
        icon={<RemoveCircleOutlineIcon />}
        label="Disabled"
        size="small"
        color="default"
      />
    );
  }
  if (status.ready) {
    return (
      <Chip
        icon={<CheckCircleIcon />}
        label="Ready"
        size="small"
        color="success"
      />
    );
  }
  return (
    <Chip
      icon={<ErrorIcon />}
      label={`Missing ${status.missing.length}`}
      size="small"
      color="warning"
    />
  );
}

function ContainerCard({
  name,
  def,
  containerConfig,
  validation,
  onUpdate,
  saving,
}) {
  const [vars, setVars] = useState(containerConfig?.variables || {});
  const [enabled, setEnabled] = useState(containerConfig?.enabled !== false);
  const [dirty, setDirty] = useState(false);

  const handleVarChange = (varName, value) => {
    setVars((prev) => ({ ...prev, [varName]: value }));
    setDirty(true);
  };

  const handleToggle = () => {
    const next = !enabled;
    setEnabled(next);
    onUpdate(name, { enabled: next, variables: vars });
  };

  const handleSave = () => {
    onUpdate(name, { enabled, variables: vars });
    setDirty(false);
  };

  const varDefs = def.variables || {};
  const hasVars = Object.keys(varDefs).length > 0;

  const features = [];
  if (def.uses_tailscale) features.push("Tailscale");
  if (def.requires_gpu) features.push("GPU");
  if (def.uses_docker_gid) features.push("Docker Socket");

  return (
    <Accordion slotProps={{ transition: { unmountOnExit: true } }}>
      <AccordionSummary expandIcon={hasVars ? <ExpandMoreIcon /> : null}>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            width: "100%",
            gap: 1,
          }}
        >
          <Switch
            size="small"
            checked={enabled}
            onChange={handleToggle}
            onClick={(e) => e.stopPropagation()}
          />
          <Typography sx={{ fontWeight: 500, minWidth: 180 }}>
            {name}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
            {def.description}
          </Typography>
          {features.map((f) => (
            <Chip key={f} label={f} size="small" variant="outlined" />
          ))}
          <ReadinessBadge status={validation} />
        </Box>
      </AccordionSummary>
      {hasVars && (
        <AccordionDetails>
          <Box
            sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}
          >
            {Object.entries(varDefs).map(([varName, varDef]) => {
              if (varDef.type === "secret") {
                return (
                  <SecretField
                    key={varName}
                    label={`${varName}${varDef.required ? " *" : ""}`}
                    description={varDef.description}
                    value={vars[varName]}
                    onChange={(val) => handleVarChange(varName, val)}
                  />
                );
              }
              return (
                <TextField
                  key={varName}
                  fullWidth
                  size="small"
                  label={`${varName}${varDef.required ? " *" : ""}`}
                  helperText={varDef.description}
                  value={vars[varName] || ""}
                  onChange={(e) => handleVarChange(varName, e.target.value)}
                />
              );
            })}
          </Box>
          <Box sx={{ mt: 2, display: "flex", justifyContent: "flex-end" }}>
            <Button
              variant="contained"
              size="small"
              startIcon={saving ? <CircularProgress size={16} /> : <SaveIcon />}
              disabled={!dirty || saving}
              onClick={handleSave}
            >
              Save
            </Button>
          </Box>
        </AccordionDetails>
      )}
    </Accordion>
  );
}

function ContainerConfig() {
  const {
    registry,
    userConfig,
    validationStatus,
    loading,
    saving,
    error,
    updateSharedVars,
    updateContainer,
  } = useContainerConfig();

  const [snackbar, setSnackbar] = useState({ open: false, message: "" });

  const containersByCategory = useMemo(() => {
    if (!registry?.containers) return {};
    const grouped = {};
    for (const [name, def] of Object.entries(registry.containers)) {
      const cat = def.category || "uncategorized";
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push({ name, def });
    }
    for (const cat of Object.keys(grouped)) {
      grouped[cat].sort((a, b) => a.name.localeCompare(b.name));
    }
    return grouped;
  }, [registry]);

  const categoryLabels = useMemo(() => {
    if (!registry?.categories) return {};
    const labels = {};
    for (const [slug, def] of Object.entries(registry.categories)) {
      labels[slug] = def.label || slug;
    }
    return labels;
  }, [registry]);

  const handleSaveShared = async (vars) => {
    await updateSharedVars(vars);
    setSnackbar({
      open: true,
      message: "Shared variables saved and all .env files updated",
    });
  };

  const handleUpdateContainer = async (name, config) => {
    await updateContainer(name, config);
    setSnackbar({
      open: true,
      message: `${name} saved and .env updated`,
    });
  };

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

  const sortedCategories = Object.keys(containersByCategory).sort((a, b) => {
    const la = categoryLabels[a] || a;
    const lb = categoryLabels[b] || b;
    return la.localeCompare(lb);
  });

  return (
    <Box sx={{ p: 2, maxWidth: 1200, margin: "0 auto" }}>
      <Typography variant="h5" sx={{ mb: 1 }}>
        Container Configuration
      </Typography>

      <Alert severity="info" sx={{ mb: 2 }}>
        <strong>How this works:</strong> Set your shared variables first (storage
        paths, Tailscale credentials), then enable the containers you want and
        fill in their settings. Each time you click Save, the container's .env
        file is automatically updated. Then
        run <code>scripts/all-containers.sh --start</code> to bring everything
        up.
      </Alert>

      <SharedVariablesSection
        registry={registry}
        userConfig={userConfig}
        onSave={handleSaveShared}
        saving={saving}
      />

      <Typography variant="h6" sx={{ mb: 1, mt: 3 }}>
        Containers
      </Typography>

      {sortedCategories.map((cat) => (
        <Box key={cat} sx={{ mb: 2 }}>
          <Typography
            variant="subtitle1"
            sx={{ fontWeight: 600, mb: 0.5, color: "text.secondary" }}
          >
            {categoryLabels[cat] || cat}
          </Typography>
          {containersByCategory[cat].map(({ name, def }) => (
            <ContainerCard
              key={name}
              name={name}
              def={def}
              containerConfig={userConfig?.containers?.[name]}
              validation={validationStatus?.containers?.[name]}
              onUpdate={handleUpdateContainer}
              saving={saving}
            />
          ))}
        </Box>
      ))}

      <Snackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={() => setSnackbar({ open: false, message: "" })}
        message={snackbar.message}
      />
    </Box>
  );
}

export default ContainerConfig;
