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
import RefreshIcon from "@mui/icons-material/Refresh";
import AlertTitle from "@mui/material/AlertTitle";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import Divider from "@mui/material/Divider";
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

function MountsSection({ mounts, onSave, saving }) {
  const [localMounts, setLocalMounts] = useState(
    mounts?.length > 0 ? mounts : [{ path: "", label: "" }],
  );
  const [dirty, setDirty] = useState(false);

  const handleChange = (index, field, value) => {
    setLocalMounts((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
    setDirty(true);
  };

  const handleAdd = () => {
    setLocalMounts((prev) => [...prev, { path: "", label: "" }]);
    setDirty(true);
  };

  const handleRemove = (index) => {
    if (localMounts.length <= 1) return;
    setLocalMounts((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  };

  const handleSave = () => {
    const valid = localMounts.filter((m) => m.path.trim());
    if (valid.length === 0) return;
    onSave(valid);
    setDirty(false);
  };

  return (
    <Box sx={{ mb: 3 }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
        <Typography variant="h6">Storage Mounts</Typography>
        <Box sx={{ display: "flex", gap: 1 }}>
          <Button size="small" startIcon={<AddIcon />} onClick={handleAdd}>
            Add Mount
          </Button>
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
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Define where container data is stored. Each volume in each container
        can be assigned to any mount. The first mount is the default.
      </Typography>
      {localMounts.map((mount, i) => (
        <Box key={i} sx={{ display: "flex", gap: 1, mb: 1, alignItems: "center" }}>
          <Chip label={i} size="small" variant="outlined" sx={{ minWidth: 32 }} />
          <TextField
            size="small"
            label="Label"
            value={mount.label || ""}
            onChange={(e) => handleChange(i, "label", e.target.value)}
            sx={{ width: 160 }}
            placeholder={i === 0 ? "e.g. Fast SSD" : "e.g. Big HDD"}
          />
          <TextField
            size="small"
            label="Path"
            value={mount.path || ""}
            onChange={(e) => handleChange(i, "path", e.target.value)}
            sx={{ flex: 1 }}
            placeholder="/mnt/my-drive"
          />
          <IconButton
            size="small"
            onClick={() => handleRemove(i)}
            disabled={localMounts.length <= 1}
          >
            <DeleteIcon fontSize="small" />
          </IconButton>
        </Box>
      ))}
    </Box>
  );
}

function SharedVarsSection({ registry, userConfig, onSave, saving }) {
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
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
        <Typography variant="h6">Global Settings</Typography>
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
    return <Chip icon={<RemoveCircleOutlineIcon />} label="Disabled" size="small" color="default" />;
  }
  if (status.ready) {
    return <Chip icon={<CheckCircleIcon />} label="Ready" size="small" color="success" />;
  }
  return <Chip icon={<ErrorIcon />} label={`Missing ${status.missing.length}`} size="small" color="warning" />;
}

function VolumeMountSelector({ volumes, volumeMounts, mounts, onChange }) {
  if (!volumes || Object.keys(volumes).length === 0) return null;

  return (
    <Box sx={{ mt: 1 }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1, fontWeight: 500 }}>
        Storage assignments
      </Typography>
      <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>
        {Object.entries(volumes).map(([volName, volDef]) => (
          <Box key={volName} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <FormControl size="small" sx={{ minWidth: 100 }}>
              <InputLabel>{volName}</InputLabel>
              <Select
                label={volName}
                value={volumeMounts[volName] ?? 0}
                onChange={(e) => onChange(volName, e.target.value)}
              >
                {mounts.map((m, i) => (
                  <MenuItem key={i} value={i}>
                    {m.label || m.path || `Mount ${i}`}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
              {volDef.host_subpath}
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function ContainerCard({ name, def, containerConfig, validation, mounts, onUpdate, saving }) {
  const [vars, setVars] = useState(containerConfig?.variables || {});
  const [volMounts, setVolMounts] = useState(containerConfig?.volume_mounts || {});
  const [enabled, setEnabled] = useState(() => {
    if (containerConfig?.enabled !== undefined) return containerConfig.enabled;
    if (def.default_disabled) return false;
    return true;
  });
  const [dirty, setDirty] = useState(false);

  const handleVarChange = (varName, value) => {
    setVars((prev) => ({ ...prev, [varName]: value }));
    setDirty(true);
  };

  const handleVolMountChange = (volName, mountIndex) => {
    setVolMounts((prev) => ({ ...prev, [volName]: mountIndex }));
    setDirty(true);
  };

  const handleToggle = () => {
    const next = !enabled;
    setEnabled(next);
    onUpdate(name, { enabled: next, variables: vars, volume_mounts: volMounts });
  };

  const handleSave = () => {
    onUpdate(name, { enabled, variables: vars, volume_mounts: volMounts });
    setDirty(false);
  };

  const varDefs = def.variables || {};
  const volumes = def.volumes || {};
  const hasVars = Object.keys(varDefs).length > 0;
  const hasVolumes = Object.keys(volumes).length > 0;
  const hasDetails = hasVars || hasVolumes;

  const features = [];
  if (def.uses_tailscale) features.push("Tailscale");
  if (def.requires_gpu) features.push("GPU");
  if (def.uses_docker_gid) features.push("Docker Socket");
  if (def.monitor_all_mounts) features.push("Disk Monitor");

  return (
    <Accordion slotProps={{ transition: { unmountOnExit: true } }}>
      <AccordionSummary expandIcon={hasDetails ? <ExpandMoreIcon /> : null}>
        <Box sx={{ display: "flex", alignItems: "center", width: "100%", gap: 1 }}>
          <Switch
            size="small"
            checked={enabled}
            onChange={handleToggle}
            onClick={(e) => e.stopPropagation()}
          />
          <Typography sx={{ fontWeight: 500, minWidth: 180 }}>{name}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
            {def.description}
          </Typography>
          {features.map((f) => (
            <Chip key={f} label={f} size="small" variant="outlined" />
          ))}
          <ReadinessBadge status={validation} />
        </Box>
      </AccordionSummary>
      {hasDetails && (
        <AccordionDetails>
          {hasVolumes && (
            <VolumeMountSelector
              volumes={volumes}
              volumeMounts={volMounts}
              mounts={mounts}
              onChange={handleVolMountChange}
            />
          )}
          {hasVars && hasVolumes && <Divider sx={{ my: 2 }} />}
          {hasVars && (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1, fontWeight: 500 }}>
                Variables
              </Typography>
              <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}>
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
            </>
          )}
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

function ContainerConfig({ tailscalePreflightStatus, runTailscalePreflight }) {
  const {
    registry,
    userConfig,
    validationStatus,
    loading,
    saving,
    error,
    updateSharedVars,
    updateContainer,
    updateMounts,
  } = useContainerConfig();

  const [snackbar, setSnackbar] = useState({ open: false, message: "" });

  const mounts = userConfig?.mounts || [{ path: "", label: "Default" }];

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

  const handleSaveMounts = async (newMounts) => {
    await updateMounts(newMounts);
    setSnackbar({ open: true, message: "Storage mounts saved and all .env files updated" });
  };

  const handleSaveShared = async (vars) => {
    await updateSharedVars(vars);
    setSnackbar({ open: true, message: "Global settings saved and all .env files updated" });
  };

  const handleUpdateContainer = async (name, config) => {
    const result = await updateContainer(name, config);
    let message = `${name} saved and .env updated`;
    if (result?.autoGenerated > 0) {
      message += ` (${result.autoGenerated} internal secret${result.autoGenerated > 1 ? "s" : ""} auto-generated)`;
    }
    setSnackbar({ open: true, message });
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
        <strong>How this works:</strong> First, define your storage mounts (one per
        disk or directory). Then set Tailscale credentials in Global Settings.
        Finally, enable containers and assign their volumes to your mounts.
        Each Save updates the container's .env file automatically. Then
        run <code>scripts/all-containers.sh --start</code> to bring everything up.
      </Alert>

      <MountsSection mounts={mounts} onSave={handleSaveMounts} saving={saving} />

      <SharedVarsSection
        registry={registry}
        userConfig={userConfig}
        onSave={handleSaveShared}
        saving={saving}
      />

      <Box sx={{ mb: 3 }}>
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
          <Typography variant="h6">Tailscale Preflight</Typography>
          <Button
            variant="outlined"
            size="small"
            startIcon={
              tailscalePreflightStatus?.status === "running" ? (
                <CircularProgress size={16} />
              ) : (
                <RefreshIcon />
              )
            }
            disabled={tailscalePreflightStatus?.status === "running"}
            onClick={runTailscalePreflight}
          >
            {tailscalePreflightStatus?.status === "running"
              ? "Checking..."
              : tailscalePreflightStatus
                ? "Re-check"
                : "Run Check"}
          </Button>
        </Box>
        {!tailscalePreflightStatus && (
          <Alert severity="info">
            Validates your tailnet configuration (ACL tags, auth key, HTTPS).
            Save your Tailscale credentials above, then click Run Check.
          </Alert>
        )}
        {tailscalePreflightStatus?.status === "passed" && (
          <Alert severity="success">
            <AlertTitle>All checks passed</AlertTitle>
            {tailscalePreflightStatus.checks
              ?.filter((c) => !c.advisory)
              .map((c) => (
                <Typography key={c.name} variant="body2" color="text.secondary">
                  {c.name}: {c.message}
                </Typography>
              ))}
          </Alert>
        )}
        {tailscalePreflightStatus?.checks
          ?.filter((c) => c.advisory && !c.ok)
          .map((c) => (
            <Alert key={c.name} severity="warning" sx={{ mt: 1 }}>
              <AlertTitle>{c.name}</AlertTitle>
              <Typography variant="body2">
                {c.message}
                {c.fixUrl && (
                  <>
                    {" "}
                    <a
                      href={c.fixUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Renew key
                    </a>
                  </>
                )}
              </Typography>
            </Alert>
          ))}
        {tailscalePreflightStatus?.status === "failed" && (
          <Alert severity="error">
            <AlertTitle>Issues found</AlertTitle>
            {tailscalePreflightStatus.error && (
              <Typography variant="body2" sx={{ mb: 1 }}>
                {tailscalePreflightStatus.error}
              </Typography>
            )}
            {tailscalePreflightStatus.checks
              ?.filter((c) => !c.ok)
              .map((c) => (
                <Typography key={c.name} variant="body2" sx={{ mt: 0.5 }}>
                  <strong>{c.name}:</strong> {c.message}
                  {c.fixUrl && (
                    <>
                      {" "}
                      <a
                        href={c.fixUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Fix
                      </a>
                    </>
                  )}
                </Typography>
              ))}
          </Alert>
        )}
        {tailscalePreflightStatus?.status === "unavailable" && (
          <Alert severity="warning">
            <Typography variant="body2">
              {tailscalePreflightStatus.message}
            </Typography>
          </Alert>
        )}
      </Box>

      <Typography variant="h6" sx={{ mb: 1, mt: 3 }}>
        Containers
      </Typography>

      {sortedCategories.map((cat) => (
        <Box key={cat} sx={{ mb: 2 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5, color: "text.secondary" }}>
            {categoryLabels[cat] || cat}
          </Typography>
          {containersByCategory[cat].map(({ name, def }) => (
            <ContainerCard
              key={name}
              name={name}
              def={def}
              containerConfig={userConfig?.containers?.[name]}
              validation={validationStatus?.containers?.[name]}
              mounts={mounts}
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
