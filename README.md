# craTe. — Render

Deploy as a Render Web Service. The service uses `PORT` from Render and PostgreSQL via `DATABASE_URL`. WebSocket chat runs on the same service.

## Render
1. Push this folder to GitHub.
2. In Render: New + → Blueprint → select the repo.
3. Render reads `render.yaml` and creates the web service and database.
4. Open the generated `https://...onrender.com` URL.

No localhost or Radmin VPN is required after deployment.
