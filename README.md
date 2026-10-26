# Lumen AI Desktop

Local-first multi-provider AI chat workspace for Windows. Electron + React + TypeScript, with privileged main-process API calls, encrypted credentials and persistent SQLite history.

## Requirements
- Windows 10/11 x64
- Node.js 20+ and npm
- An API key from a supported provider

## Run locally
```sh
npm install
npm run dev
```
> A `predev` hook compiles `electron/*.ts` → `dist-electron/` before every dev run, so a fresh clone works out of the box. Re-run `npm run build:electron` (or restart `dev`) after editing anything under `electron/`. Renderer edits under `src/` hot-reload via Vite without a rebuild.

## Build and package
```sh
npm run typecheck
npm run lint        # eslint flat config, TS + react-hooks rules
npm test
npm run build       # = build:renderer (vite) + build:electron (tsc)
npm run dist:win    # = build + electron-builder --win nsis
```
The NSIS installer is written to `release/`. The window/taskbar/installer icon is `build/icon.ico` (electron-builder's default `buildResources` directory), so it is picked up with no extra config. The authoritative packaging config is `package.json → build` (electron-builder ignores `electron-builder.yml` whenever `package.json` has a `build` section, so the misleading duplicate was removed).

## Providers
OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, DeepSeek and Mistral are preconfigured. Add a key in Settings → Providers. Credentials are encrypted using Electron `safeStorage` (Windows DPAPI); the app refuses to store a key when system encryption is unavailable. Custom endpoints support OpenAI-compatible `/models` and `/chat/completions` APIs. Remote endpoints must use HTTPS; `http://localhost` / `http://127.0.0.1` are allowed so local servers (Ollama, LM Studio) work out of the box. The Gemini API key is sent in a request header, never in the URL.

## Data and privacy
Chat records and preferences are stored in `lumen.sqlite` under Electron's user-data directory. Provider secrets are encrypted blobs in the local database. Network requests originate in Electron main; the renderer receives stream chunks and provider metadata only. Internet access and a valid provider key are required for live responses.

## Screens
- **Workspace:** conversation sidebar with title search plus full-text search across messages, a live spinner per chat that is still generating, rename/delete, model picker, streaming chat, sanitized markdown, collapsible reasoning ("thinking") for reasoning models, and per-message token usage. Chats are named automatically from the first exchange (an LLM-written title replaces the raw text prefix; your own renames are never overwritten).
- **Messages:** regenerate (non-destructive — the outgoing answer is archived, see *History*), **Continue** when the provider reports a `length` finish reason, edit-and-resend a user message (everything after it is truncated transactionally), per-message delete, copy, image attachments (see below), and a finish-reason badge when a reply was filtered, refused, or stopped without a reported reason. Day separators ("Today", "Yesterday", …) split long conversations; fenced code blocks have a language label and their own **Copy** button.
- **Composer:** **Enhance prompt** rewrites the draft with the selected model before you send it (the original is kept until you accept the rewrite), **ArrowUp** at the start of the input recalls previously sent messages, and text typed while a reply is streaming is **queued** and sent automatically when the reply finishes (up to 10 per chat, clearable from the chip above the input).
- **Cost estimates:** providers carry per-model USD prices (per 1M tokens, editable via the provider's pricing map; sane defaults ship for the built-in model lists). Assistant messages show `≈$` next to their token counts, and Settings → Data & privacy shows the estimated lifetime cost alongside token totals. Models without a known price simply show tokens.
- **Branching:** the **Branch** action on any message forks the conversation into a new chat titled `<title> (branch)`, copying everything up to and including that message — variants and attachments included. From then on the two chats are fully independent. The toolbar links a branch back to its source and lists the forks of the active chat.
- **Personas:** named presets (system prompt + color + optional temperature/provider/model overrides), managed in Settings → Personas and selected per-conversation from the composer. A persona's prompt replaces the global system prompt for new messages.
- **Variants:** each regenerated answer keeps its predecessors; **History (n)** lists them with a preview and one click restores a previous answer in place.
- **Providers:** keys (with a saved-key indicator so you can leave the field blank to keep it), base URLs, model refresh/test, add/remove models, remove a custom provider, and a custom OpenAI-compatible endpoint. The seven cloud providers have pinned URLs; use a custom provider to point at anything else.
- **Appearance:** dark/light theme, accent color, system prompt, temperature, top-p and response token limit; system options (keep running in the tray, launch at sign-in, desktop notifications on completion) and rebindable keyboard shortcuts.
- **Data & privacy:** local-storage details, cumulative token usage by model, Markdown/JSON chat export, "open data folder", and erase-all-conversations behind an inline confirmation.

## Keyboard
Shortcuts are rebindable in Settings → Appearance (a chord must include Ctrl or Alt); the defaults are:
- `Ctrl K` — new conversation
- `Ctrl ,` — open settings
- `Ctrl B` — toggle sidebar
- `Enter` — send · `Shift Enter` — newline · `Ctrl/Cmd Enter` — send even during IME composition or from the message editor
- `Esc` — close the settings dialog, cancel the erase confirmation, cancel a hotkey capture, or clear/close the sidebar search

## Images / vision
Attach up to 4 images per message (PNG, JPEG, WebP or GIF, ≤10 MB each) via the attach button, paste, or drag-and-drop; an image-only message is valid. Bytes are stored as plain files under `userData/attachments/` (keeping them out of `lumen.sqlite`, which sql.js re-exports in full on every flush), with metadata in the database, and are served back to the sandboxed renderer through the CSP allow-listed `lumen-attachment://` protocol. Vision payloads are built per provider family: Anthropic image blocks, Gemini `inlineData` parts, and OpenAI-compatible `image_url` data URLs. Deleting a message, chat, edit-truncating, or wiping data removes the corresponding files. Edit-and-resend intentionally re-sends text only, and exports stay text-only.

## Tray and autostart
Settings → Appearance → System: "Keep running in the tray" hides the window on close instead of quitting (quit via the tray menu); "Launch at sign-in" registers the app with Windows via `app.setLoginItemSettings`.

## Current scope
Text chat, SSE streaming, **concurrent generation in several chats at once**, generation cancellation, a per-chat **message queue** while streaming, regenerate with variant history, continue-after-truncation, message editing, per-message delete, conversation branching with lineage navigation, image attachments with per-provider vision payloads, personas (prompt presets), **Enhance prompt** draft rewriting, **prompt history recall** (ArrowUp), LLM-generated chat titles, tray mode and autostart, completion notifications, rebindable shortcuts, accent themes, token usage with **USD cost estimates** and usage totals, day separators and per-block **code copy**, reasoning-model output, stream watchdog, bounded history, SQLite history, provider configuration, themes and exports are implemented. Reload-safe: generations that outlive a renderer reload are re-attached on startup instead of being orphaned.

Durability: conversation writes go through `BEGIN`/`COMMIT` transactions, are serialized atomically (temp file → `fsync` → rename) so a crash cannot leave a half-written database, and any write failure is surfaced through `data.health` rather than swallowed. A corrupt or 0-byte database is quarantined to `lumen.sqlite.corrupt-<timestamp>` and rebuilt with a warning naming the file; a database written by a newer schema version is refused instead of being overwritten. API keys are encrypted with `safeStorage` (Windows DPAPI) and a key that cannot be decrypted on the current account produces an actionable error instead of a silent auth failure. Local OpenAI-compatible servers (Ollama, LM Studio) work with no key at all.

Observability: the main process logs with a `[lumen]` prefix, catches `uncaughtException`/`unhandledRejection`, reports window load failures, and shows a dialog instead of dying silently if startup fails. DevTools and reload shortcuts are disabled in production builds only, so they stay available under `npm run dev`.

Not included yet: arbitrary JSON templates and auto-updates. Built-in model lists are suggestions; connection test refreshes models where supported.

## Known packaging gaps
These need decisions beyond code, so they are documented rather than changed:
- **asar is disabled on the CLI** (`--config.asar=false` in `dist:win`), which ships readable source in the packaged app. Enable asar (with `asarUnpack` for `node_modules/sql.js/dist/**` — the WASM loader resolves that path at runtime) once the loader paths are verified in a packaged build.
- **No `publish` config / auto-updates**: releases are manual. Add a `publish` provider to `package.json → build` and wire electron-updater if that changes.
- The exe's own embedded icon stays stock Electron because `dist:win` passes `-c.win.signAndEditExecutable=false` (skips the rcedit step); the live window/taskbar icon is set via `BrowserWindow.icon` from `build/icon.ico`.
