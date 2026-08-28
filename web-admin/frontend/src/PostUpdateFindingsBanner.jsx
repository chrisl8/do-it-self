import React from "react";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import { useNavigate } from "react-router-dom";

// App-wide reminder that a container's post-update maintenance check found
// something worth a look (see scripts/post-update-checks/). Details and the
// dismiss action live on the Docker Status page, next to that container --
// this banner just makes sure it's seen from anywhere in the app.
const PostUpdateFindingsBanner = ({ byContainer }) => {
  const navigate = useNavigate();
  const needsAttention = Object.entries(byContainer || {}).filter(
    ([, finding]) => finding.needsAttention,
  );

  if (needsAttention.length === 0) return null;

  const names = needsAttention.map(([container]) => container).join(", ");

  return (
    <Box sx={{ px: 2, pt: 1 }}>
      <Alert
        severity="info"
        sx={{ cursor: "pointer" }}
        onClick={() => navigate("/docker-status")}
      >
        <AlertTitle>Post-update check found something to review</AlertTitle>
        {names} — see the Docker Status page for details.
      </Alert>
    </Box>
  );
};

export default PostUpdateFindingsBanner;
