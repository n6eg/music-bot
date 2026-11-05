// PM2 process definition for hosting the multi-bot fleet.
//
// IMPORTANT: keep instances: 1. All bots of this fleet share ONE process,
// one in-memory clientsMap, and one config.json (re-read from disk on every
// command). Scaling instances would split bots across processes and make
// them fight over config.json writes.
module.exports = {
  apps: [
    {
      name: "music-bot",
      script: "index.js",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: "600M",
      time: true,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};