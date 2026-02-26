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

Open:
```text
http://localhost:3000
```

Put input PDFs in:
- `input/`

Generated files appear in:
- `output/<pdf-name>/`

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
