module.exports = {
  apps: [
    {
      name: "Container Web Admin",
      script: "./backend/src/main.js",
      cwd: ".",
      instances: 1,
      autorestart: true,
      watch: false,
      env_file: "./backend/.env",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
