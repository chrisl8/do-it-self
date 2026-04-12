import React from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";

function ModuleOperationDialog({ open, title, running, result, onClose }) {
  return (
    <Dialog
      open={open}
      onClose={running ? undefined : onClose}
      maxWidth="md"
      fullWidth
      disableEscapeKeyDown={running}
    >
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {running && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 2, py: 3 }}>
            <CircularProgress size={24} />
            <Typography>Running module operation…</Typography>
          </Box>
        )}
        {!running && result && (
          <>
            {!result.success && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {result.status === 409
                  ? "Another module operation is already in progress. Wait for it to finish and try again."
                  : `Operation failed${result.status ? ` (HTTP ${result.status})` : ""}.`}
              </Alert>
            )}
            {result.success && (
              <Alert severity="success" sx={{ mb: 2 }}>
                Operation completed successfully.
              </Alert>
            )}
            <Typography variant="caption" color="text.secondary">
              Command output:
            </Typography>
            <Box
              component="pre"
              sx={{
                mt: 0.5,
                p: 1.5,
                bgcolor: "grey.100",
                fontSize: "0.8rem",
                fontFamily: "monospace",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 400,
                overflow: "auto",
                border: "1px solid",
                borderColor: "divider",
                borderRadius: 1,
              }}
            >
              {result.output || "(no output)"}
            </Box>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={running}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default ModuleOperationDialog;
