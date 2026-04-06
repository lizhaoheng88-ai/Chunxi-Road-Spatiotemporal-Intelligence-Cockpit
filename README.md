# Chunxi Road Web Package

This folder is a standalone deployment package for the Chunxi Road Spatiotemporal Intelligence Cockpit.

## Local run

1. Install Node.js 20 or newer.
2. Run `node server.js` in this folder.
3. Open `http://127.0.0.1:4173`.

## Public deployment

This package is ready for Render deployment. If this folder is uploaded as the repository root, Render can read `render.yaml` directly.

## Included files

- `public/`: frontend pages, styles, scripts, and compiled JSON data
- `server.js`: static server plus chat API
- `Dockerfile`: container deployment
- `package.json`: runtime metadata
- `render.yaml`: Render deployment config
