# Agor Overview & UI Concepts — Q&A Session

**Date:** 2026-05-05
**Session:** short-id `03b62447`

---

## Summary

Exploratory Q&A covering Agor's architecture and web UI concepts.

### 1. How does Agor work?

Agor is a local-first, multiplayer control plane for AI coding agents (Claude Code, Codex, Gemini, OpenCode). The core flow:

- **Git repos** → creates isolated **worktrees** (1 per feature/issue/PR)
- **Sessions** run AI agents inside worktrees, with fork/spawn genealogy
- **Boards** display worktrees as spatial cards on a 2D canvas (React Flow)
- **agor-daemon** exposes a FeathersJS REST/WebSocket API for all clients
- **LibSQL/SQLite** database at `~/.agor/` stores all state
- **WebSockets** broadcast live updates (session streaming, board changes, cursors)

Stack: FeathersJS (backend), React + Vite + Ant Design + React Flow (frontend), oclif (CLI), simple-git (git ops).

### 2. Can multiple assistants work in the same session?

No — one session = one agent. But a single **worktree** can host multiple sessions with different agents running in parallel on the same filesystem. You can also swap models between sessions via fork/spawn.

### 3. What are the important concepts in the Agor web UI?

9 key concepts:
1. **Board** — 2D zoomable/pan-able canvas (React Flow) for spatial worktree organization
2. **WorktreeCard** — primary unit on the board, one per feature/bug, shows attached sessions
3. **WorktreeModal** — 5-tab detail overlay: Info, Environments, Sessions, Terminal, Permissions
4. **Session** — conversation displayed in left drawer (list) + right drawer (full view), organized by Tasks
5. **Task Block** — collapsible user prompt sections with progressive disclosure (summary → messages → tool details)
6. **Zone** — spatial kanban regions that trigger templated Handlebars prompts on drop
7. **Session Pinning** — parent-child locking so sessions move with their zone
8. **Real-Time Presence** — cursor swarm, facepile, spatial comments (Figma-style)
9. **Settings** — encrypted per-user API keys, env vars, MCP server config, model/effort controls

UI tech: React 18 + Vite, Ant Design 5.x (token-based dark mode, no custom CSS), React Flow, FeathersJS WebSocket hooks.

---

*Files read during Q&A: `context/concepts/core.md`, `context/concepts/architecture.md`, `context/concepts/frontend-guidelines.md`, `context/concepts/design.md`, `context/concepts/board-objects.md`, `context/concepts/conversation-ui.md`, `context/concepts/worktrees.md`, `context/concepts/social-features.md`*
