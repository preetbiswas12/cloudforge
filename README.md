# CloudForge

A self-hostable **web code editor** — the Monaco engine from VS Code, in the browser, served by a Node.js backend that writes real files to disk and keeps them in git.

Point a domain at it and anyone with the link can write code.

---

## What's in the box

| Area | Details |
| --- | --- |
| Editor | Monaco (same engine as VS Code), 40+ languages, IntelliSense, minimap, multi-cursor |
| Files | Real files on disk, not a database. Create, rename, delete, nested folders |
| Sync | WebSocket live sync — everyone on the domain sees every change instantly |
| History | Auto git commits every 5 min + on shutdown, plus a manual "Save version" button |
| Persistence | Works on **ephemeral** PaaS disks: commits push to a remote and restore on boot |
| Security | Path-traversal proof on every request, atomic writes, size limits, optional token gate |
| UI | File tree with context menu, tabs with dirty markers, Ctrl+P quick open, status bar |

**Shortcuts:** `Ctrl/Cmd+S` save · `Ctrl/Cmd+P` quick open · `Ctrl/Cmd+B` toggle sidebar · right-click for create/rename/delete.

---

## 1. Run it locally

```bash
git clone <your-repo> cloudforge
cd cloudforge
npm install
npm run dev
```

Open **http://localhost:5173**. The Vite dev server proxies `/api` and `/ws` to the backend on port 8080.

To run the production build the way a server will:

```bash
npm run build
npm start          # serves the built client on http://localhost:8080
```

Your files land in `./workspace`. It's git-ignored — that's the point.

---

## 2. Architecture

```
web/     React 18 + Vite + Monaco      → the editor UI
server/  Express + ws + chokidar       → file API, live sync, git
workspace/  real files + .git          → the actual data
```

**Request flow for a save:**

1. You type → React store marks the file dirty → 900 ms debounce
2. `PUT /api/file` → server resolves the path, proves it stays inside `workspace/`
3. Writes to a temp file, then renames (a crash mid-save can't corrupt the file)
4. The filesystem watcher fires → broadcast over WebSocket → every other browser updates
5. The next autosave tick commits to git and pushes to your remote

The one hard rule: **every path from the client goes through `resolveInRoot()`** in `server/src/fs/safePath.ts`. It rejects absolute paths, drive letters, UNC paths, null bytes and `..` traversal, then verifies the resolved absolute path is still a descendant of the workspace. It's the only place that decides where a file may be written — and it has tests.

---

## 3. Deploy it

### The one thing to get right

> **Railway, Render and Fly all use ephemeral filesystems on their cheap tiers.** Anything you write with `fs.writeFile` is wiped on the next deploy, restart, or scale event.

CloudForge gives you two fixes. **Use both if you can.**

**Fix A — mount a volume (fast, simple)**

| Platform | How |
| --- | --- |
| **Render** | `render.yaml` already declares a 1 GB disk at `/workspace`. Set the plan to Starter, or add the disk by hand under *Mount Disk*. |
| **Railway** | Railway.json → *Volumes* → New Volume → mount path `/workspace`. |
| **Fly.io** | `fly volumes create cloudforge_data --size 1` then `fly deploy`. One machine only. |

**Fix B — git remote as the persistence layer (free, survives anything)**

Create a **private** GitHub repo, generate a fine-grained token with `contents: read+write`, and set:

```
GIT_REMOTE=https://github.com/you/workspace.git
GIT_REMOTE_TOKEN=github_pat_xxx
GIT_PULL_ON_BOOT=true
```

The server injects the token into the remote URL **in memory only** — it is never written to disk or committed. On boot it pulls (fast-forward only, so it can never clobber local work), and every autosave pushes. Your files are then backed up to GitHub, inspectable with full history.

> Token safety: with a token configured, a compromised server could read that one repo. Scope the token to that repo alone, never reuse it, and rotate it if it leaks.

### Railway

```bash
npm i -g @railway/cli
railway login
railway init
railway up
```

Then in the dashboard: add the `/workspace` volume, set `EDITOR_TOKEN` (and the git vars), and attach your domain under *Settings → Networking*.

### Render

Push the repo, create a **Web Service → Docker**. `render.yaml` supplies the build command, health check and disk automatically.

### Fly.io

```bash
fly launch --no-deploy --copy-config
fly volumes create cloudforge_data --size 1
fly secrets set EDITOR_TOKEN=... GIT_REMOTE=... GIT_REMOTE_TOKEN=...
fly deploy
fly certs add your-domain.com      # HTTPS, automatic
```

### Any VPS (Docker + Nginx)

```bash
docker compose up -d --build
```

```nginx
server {
    server_name editor.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        # Required for the live-sync WebSocket.
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 3600s;   # keep long-lived sockets open
    }
}
```

```bash
sudo certbot --nginx -d editor.yourdomain.com
```

Domain DNS: an **A record** pointing at the server's IP (Cloudflare users: set the proxy to DNS-only if you hit WebSocket trouble).

---

## 4. Lock it down

Out of the box **anyone who reaches the domain can edit the workspace**. That's fine for a private link, not fine for the open internet.

Set one env var:

```
EDITOR_TOKEN=a-long-random-string
```

Visitors then open `https://yourdomain.com/?token=...` once. The token is stored in their browser, sent as `x-editor-token`, and scrubbed from the URL so it never lingers in history.

> This is a shared secret, not user accounts — everyone has the same power, and there's no per-file isolation. For a true multi-tenant editor, add real auth (the `WorkspaceService` is already instance-scoped, so you'd give each user their own root).

Also recommended: put Cloudflare in front, keep the git repo private, and run on a domain you can shut down fast if it gets abused.

---

## 5. Running code

Press <kbd>Ctrl</kbd> <kbd>`</kbd> for the terminal panel. There are two modes,
and they have very different risk profiles.

### Browser sandbox — always on, safe

JavaScript, TypeScript and Python run **in your browser**, inside an iframe
with `sandbox="allow-scripts"` and no `allow-same-origin`. The code gets an
opaque origin: it cannot read this app, its storage, its cookies, or call our
API. The server never executes anything.

Python uses [Pyodide](https://pyodide.org) — a WebAssembly build of CPython,
downloaded from jsDelivr on first run (hence the `cdn.jsdelivr.net` entry in
the CSP).

This is the default because it costs the server nothing and cannot be abused.

### Server shell — opt-in, genuinely dangerous

Set both variables:

```
TERMINAL_ENABLED=true
EDITOR_TOKEN=<a long random string>
```

That gives **anyone holding the token a shell on your server**: read every
file, run `npm install`, `node server.js`, fork bombs, scan your private
network. `EDITOR_TOKEN` is required — the server refuses to start a session
without it, so you cannot accidentally expose a shell on a public link.

Hardening that ships regardless:

| Control | Limit |
|---|---|
| Child environment | Replaced entirely. `EDITOR_TOKEN` and `GIT_REMOTE_TOKEN` are **absent** |
| Concurrent sessions | 4 |
| Idle timeout | 30 minutes |
| Absolute lifetime | 12 hours |
| Output | Ring-buffered at 512 KB per session |
| Teardown | Whole process **group** killed, so orphaned grandchildren die too |
| Input size | Capped at 4 KB per frame |
| Scoping | Sessions are bound to the owning websocket — one browser cannot drive another's shell |

There is no PTY (a native dependency that would complicate the Docker
image), so this is a pipe session: `ls`, `npm test`, `node app.js` all work;
full-screen TUI programs like `vim` and `top` do not.

> Isolating this properly means running it in a container or microVM (gVisor,
> Firecracker) with no network and a read-only rootfs. That is a larger piece
> of infrastructure than this app. If you need a real shell, treat the
> instance as a private single-user box — never share the token.

---

## 6. Configuration

Every value, with defaults, is in [`.env.example`](.env.example). The ones that matter:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port (PaaS injects this) |
| `WORKSPACE_DIR` | `./workspace` | Where user files live — mount a volume here |
| `EDITOR_TOKEN` | *(empty)* | Set to require a token |
| `TERMINAL_ENABLED` | `false` | Enable the real server shell (also needs `EDITOR_TOKEN`) |
| `TERMINAL_SHELL` | `/bin/sh` or `cmd.exe` | Which binary the server shell spawns |
| `GIT_REMOTE` / `GIT_REMOTE_TOKEN` | *(empty)* | Remote for version history + off-host persistence |
| `GIT_PULL_ON_BOOT` | `true` | Restore the workspace on restart |
| `AUTO_COMMIT` / `SNAPSHOT_INTERVAL_MS` | `true` / `300000` | Autosave cadence |
| `MAX_FILE_BYTES` | `2097152` | Largest editable file (2 MB) |
| `LOG_LEVEL` | `info` | Pino log level |

---

## 7. Commands

```bash
npm run dev         # server + web with hot reload
npm run build       # typecheck, bundle the client, compile the server
npm start           # run the production build
npm test            # server unit tests (path safety, workspace ops)
npm run typecheck   # both workspaces
npm run verify:deps # fail if any runtime import is not a real dependency
```

> **Why `verify:deps` exists.** Putting a runtime import in `devDependencies` works perfectly on your machine — devDeps are installed — and then the container runs `npm ci --omit=dev`, strips it, and the server dies with `ERR_MODULE_NOT_FOUND` after the build has already succeeded. The container build never catches it, so the deploy fails at runtime. This check scans the *compiled* server output and fails if anything it imports is missing from `dependencies`.

---

## 8. Project layout

```
cloudforge/
├── server/src/
│   ├── index.ts              bootstrap, graceful shutdown, autosave timer
│   ├── app.ts                express app, security headers, static + SPA
│   ├── env.ts                typed config from the environment
│   ├── errors.ts             HttpError + helpers
│   ├── fs/
│   │   ├── safePath.ts       *** path safety — the security boundary
│   │   ├── workspace.ts      all filesystem operations
│   │   ├── watcher.ts        chokidar → WebSocket fan-out
│   │   └── workspace.test.ts path-traversal + CRUD tests
│   ├── git/repo.ts           init, commit, push, pull-on-boot
│   ├── realtime/hub.ts       WebSocket clients, heartbeats, broadcast
│   ├── middleware/auth.ts    optional token gate (timing-safe compare)
│   └── routes/files.ts       REST API
├── web/src/
│   ├── App.tsx               layout, shortcuts, token gate
│   ├── store.ts              zustand store, autosave, live re-sync
│   ├── api.ts                typed fetch client
│   ├── realtime.ts           reconnecting WebSocket
│   ├── monaco.ts             Monaco workers + theme (bundled, no CDN)
│   └── components/           FileTree, Tabs, CodeEditor, QuickOpen, StatusBar
├── Dockerfile                multi-stage build
├── render.yaml / railway.json / fly.toml
└── workspace/                your files (git-ignored)
```

---

## 9. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Files vanish after deploy | No volume mounted. Do Fix A, or configure Fix B. |
| `Workspace is protected` | `EDITOR_TOKEN` is set — open `/?token=...` |
| Live sync never connects | Reverse proxy is stripping `Upgrade`/`Connection` headers |
| Monaco is blank | The client bundle didn't build — check `npm run build` output |
| `Exited with status 1` / `ERR_MODULE_NOT_FOUND` at startup | A runtime import is in `devDependencies`. Run `npm run verify:deps` |
| Port already in use | `PORT=3000 npm start`, or stop the other process |
| `git push` fails | Token lacks `contents: write`, or the repo has diverged (pull is fast-forward only) |

---

## License

MIT — use it, ship it, sell it.