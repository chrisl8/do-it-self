"use strict";

// Default The Lounge configuration.
// For personal customization, create the-lounge/config-personal/config/config.js
// with any settings you want to override.

module.exports = {
  // Public mode: no login required, connections are per-session.
  // Set to false and create user accounts for persistent connections.
  public: true,

  host: undefined,
  port: 9000,

  // Reverse proxy awareness (Tailscale Serve handles TLS)
  reverseProxy: true,

  // Default theme
  theme: "default",

  // Enable prefetch of links for URL previews
  prefetch: true,
};
