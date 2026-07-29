
# Architecture

Tern is a TypeScript monorepo. The web app serves the dashboard and API routes. The worker processes analysis jobs. The database stores account, repository, spec, analysis, patch, PR, and audit data.

External services are abstracted behind interfaces and activated by environment variables. Without credentials, the app falls back to mock/demo adapters.
