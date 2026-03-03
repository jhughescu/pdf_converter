# PDF Converter

Interactive PDF conversion dashboard that extracts PDF content and exports multiple formats (interactive HTML, highlighted HTML, canvas HTML, text, CSV, H5P, images).

For a semi-technical setup and operations guide (including Node installation and port-clear troubleshooting), see [USER_GUIDE.md](USER_GUIDE.md).
Word-format version: [PDF_Converter_User_Guide.rtf](PDF_Converter_User_Guide.rtf)

## Install

### Global CLI install (recommended)
```bash
npm install -g @j.hughes.cu/pdf-converter
pdf-converter
```

## Run

Start server:
```bash
pdf-converter
```

Show CLI help:
```bash
pdf-converter --help
```

Start on a custom port:
```bash
pdf-converter --port 3010
# or
pdf-converter 3010
```

If port `3000` is already in use:
```bash
portclear
pdf-converter
```

`portclear` asks for confirmation before stopping processes. To skip prompts:
```bash
portclear --yes
```

To explicitly clear all listeners on port 3000:
```bash
portclear --all
```

For a custom app port:
```bash
portclear 3010
```

If the blocked process is auto-restarted by a parent Node process, `portclear` will also stop that related parent supervisor.
Processes that look like this app are labeled as `[pdf-converter]` in `portclear` output.

Compatibility alias (still supported): `pdf-converter-portclear`

Open:
```text
http://localhost:3000
```

Put input PDFs in:
- `input/`

Generated files appear in:
- `output/<pdf-name>/`

## First Run (Empty `input/` + `output/`)

If both folders are empty, the app now shows an introduction page at startup.

Use this quick flow:
1. Add one or more PDF files to `input/`
2. Refresh `http://localhost:3000`
3. In the dashboard, choose output formats and click **Start Processing**
4. Open generated files from the output menu

The intro page is only shown when there are no input PDFs and no converted output folders yet.

## Publish to npm

1. Verify account/session:
```bash
npm whoami
```

2. Validate package contents:
```bash
npm run pack:check
```

3. Bump version:
```bash
npm version patch
```

4. Publish publicly:
```bash
npm publish --access public
```

## Notes

- Requires Node.js `>=18.18.0`
- If npm 2FA is enabled, publish will require OTP
- Package exposes CLI command: `pdf-converter`
- Package also exposes: `portclear` and `pdf-converter-portclear` (both clear listeners on port `3000`)
