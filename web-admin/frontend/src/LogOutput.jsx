import React, { useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";

const LogOutput = ({
  value,
  placeholder = "",
  fontSize = "0.8rem",
  maxHeight = "60vh",
  sx,
}) => {
  const [feedback, setFeedback] = useState(null);
  const timerRef = useRef(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const showFeedback = (state, ms) => {
    setFeedback(state);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setFeedback(null), ms);
  };

  const onCopy = () => {
    if (!navigator.clipboard) {
      showFeedback("error", 1800);
      return;
    }
    navigator.clipboard
      .writeText(value || "")
      .then(() => showFeedback("ok", 1200))
      .catch(() => showFeedback("error", 1800));
  };

  const display = value || placeholder;

  return (
    <Box sx={{ position: "relative" }}>
      <Box
        component="pre"
        sx={{
          backgroundColor: (theme) =>
            theme.palette.mode === "dark" ? "grey.800" : "grey.900",
          color: "grey.100",
          p: 2,
          borderRadius: 1,
          overflow: "auto",
          maxHeight,
          fontFamily: "monospace",
          fontSize,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          margin: 0,
          ...sx,
        }}
      >
        {display}
      </Box>
      <Tooltip
        open={feedback !== null}
        title={feedback === "error" ? "Copy failed" : "Copied!"}
        placement="left"
        arrow
      >
        <span style={{ position: "absolute", top: 4, right: 4, zIndex: 1 }}>
          <IconButton
            size="small"
            onClick={onCopy}
            disabled={!value}
            aria-label="Copy log to clipboard"
            sx={{
              color: "grey.100",
              backgroundColor: "rgba(0,0,0,0.4)",
              "&:hover": { backgroundColor: "rgba(0,0,0,0.6)" },
              "&.Mui-disabled": { color: "grey.500" },
            }}
          >
            <ContentCopyIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  );
};

export default LogOutput;
