# Project Structure

Repository root:
- contains Docker files
- contains README
- contains package.json

Backend root:
- ./

Commands must be executed from repository root unless explicitly specified.

Main commands:

Development:
- npm run dev

Production:
- npm start

Testing:
- npm test

NEVER execute commands from nested directories unless package.json exists there.

Before running commands:
1. verify current working directory
2. verify package.json location
3. verify node_modules location

The repository is NOT a monorepo.

Documentation:
- `AGENTS.md` — rules every task must follow (short, kept under the agent instruction budget)
- `docs/agents/` — per-subsystem reference, one file per area; the map is in `AGENTS.md`
- `docs/architecture/`, `docs/decisions/` — architecture notes and ADRs