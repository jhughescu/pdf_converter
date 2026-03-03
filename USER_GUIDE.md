# PDF Converter User Guide (Semi-Technical)

This guide is for academic support professionals who are comfortable with technical workflows, command-line tools, and local web applications.

## 1) What this app does

PDF Converter is a local-first Node.js application that:
- reads PDF files from an `input/` folder,
- converts content into selected output formats,
- writes results into `output/<pdf-name>/`,
- provides a browser dashboard for upload, processing, and output review.

Because it runs locally, your source files and converted files stay on your machine unless you explicitly move/share them.

## 2) Prerequisites

- Operating system: Windows, macOS, or Linux
- Node.js: version `18.18.0` or newer
- npm: included with Node.js
- Web browser: current Chrome/Edge/Firefox/Safari

To verify Node and npm after install:

```bash
node -v
npm -v
```

## 3) Install Node.js

Use one of the approaches below.

### Option A (recommended for most users): official installer

1. Go to: https://nodejs.org
2. Download the current LTS release.
3. Run installer with default options.
4. Re-open terminal and verify with:

```bash
node -v
npm -v
```

### Option B (recommended if you manage multiple Node versions): version manager

- Windows: `nvm-windows`
- macOS/Linux: `nvm`

Install LTS and activate it, then verify:

```bash
node -v
npm -v
```

## 4) Install PDF Converter

Use the global CLI installation model.

### Global CLI install

```bash
npm install -g @j.hughes.cu/pdf-converter
```

You then run:

```bash
pdf-converter
```

Optional custom port:

```bash
pdf-converter --port 3010
# or
pdf-converter 3010
```



## 5) Start and use the app

1. Start server with `pdf-converter`.
2. Open `http://localhost:3000`.
3. Add PDFs to `input/` (or use upload button in the UI).
4. Choose output formats.
5. Click **Start Processing**.
6. Review files under `output/<pdf-name>/`.

## 6) Port blocking and the `portclear` utility (important)

If port `3000` is already occupied, startup will fail with a message explaining the issue.

### Why this happens

Another local process is listening on port `3000` (possibly another PDF Converter instance or a different app).

### Recovery commands

#### Global install workflow

```bash
portclear
pdf-converter
```

If you started the app on a custom port:

```bash
portclear 3010
pdf-converter --port 3010
```

### Important safety note

`portclear` kills process(es) listening on the target port (default `3000`).
If another app you care about is using that port, stop only what you intend to stop.

By default, `portclear` asks for confirmation before killing any process.
For non-interactive/scripted use, add `--yes`:

```bash
portclear --yes
```

To explicitly shut down all processes listening on the target port:

```bash
portclear --all
```

If a blocked process is being immediately restarted by a related parent Node process,
`portclear` will also detect and stop that parent supervisor to prevent restart loops.

You can target a different port:

```bash
portclear 3001
```

Compatibility alias (still supported): `pdf-converter-portclear`

## 7) Supporting technology (high-level)

- Runtime/server: Node.js
- Web server: built-in `http` module
- PDF extraction/parsing: `pdf-parse`, `pdfjs-dist`
- Output rendering support: `@napi-rs/canvas`
- Upload handling: `busboy`
- Dashboard: local HTML/CSS/JS served by the app

## 8) Operational guidance for academic teams

- Keep a clean folder structure per project/course run.
- Use consistent PDF naming before processing.
- Archive output folders with timestamps for auditability.
- Keep Node.js LTS current across support staff machines.
- Document who runs conversions and where outputs are stored.

## 9) Updating the app

### Global install users

```bash
npm install -g @j.hughes.cu/pdf-converter@latest
```



## 10) Quick command reference

```bash
# Start app (global install)
pdf-converter

# Show CLI help
pdf-converter --help

# Clear blocked default port
portclear

# Clear specific port
portclear 3000

# Compatibility alias
pdf-converter-portclear
```
