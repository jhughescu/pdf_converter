# PDF Converter

Interactive PDF conversion dashboard that extracts PDF content and exports multiple formats (interactive HTML, highlighted HTML, canvas HTML, text, CSV, H5P, images).

## Install

### Local development
```bash
npm install
npm run dev
```

### As a published CLI package
```bash
npm install -g @j.hughes.cu/pdf-converter
pdf-converter
```

Or run without global install:
```bash
npx @j.hughes.cu/pdf-converter
```

## Run

Start server:
```bash
pdf-converter
```

If port `3000` is already in use:
```bash
pdf-converter-portclear
pdf-converter
```

Local development equivalent:
```bash
npm run portclear
npm run dev
```

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
- Package also exposes: `pdf-converter-portclear` (kills listeners on port `3000`)
