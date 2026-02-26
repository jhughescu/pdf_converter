const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const packageInfo = require('./package.json');
const PACKAGE_NAME = packageInfo.name || 'pdf-converter';
const APP_VERSION = packageInfo.version || 'dev';


// Global state
let isProcessing = false;
let shouldCancel = false;
let progressState = {
  currentFile: null,
  fileIndex: 0,
  totalFiles: 0,
  processedFiles: [],
  errors: [],
  completedFormats: {}
};
let progressClients = [];
let updateCheckCache = {
  currentVersion: APP_VERSION,
  latestVersion: APP_VERSION,
  updateAvailable: false,
  checkedAt: 0,
  error: null,
};

function compareSemver(v1, v2) {
  const a = String(v1 || '0.0.0').split('.').map(n => parseInt(n, 10) || 0);
  const b = String(v2 || '0.0.0').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function fetchLatestPackageVersionFromNpm(packageName) {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(packageName);
    const url = `https://registry.npmjs.org/${encoded}/latest`;

    https.get(url, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Registry responded ${response.statusCode}`));
        return;
      }

      let body = '';
      response.on('data', chunk => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const latestVersion = parsed && parsed.version ? String(parsed.version) : null;
          if (!latestVersion) {
            reject(new Error('Latest version missing in registry response'));
            return;
          }
          resolve(latestVersion);
        } catch (err) {
          reject(new Error(`Invalid registry response: ${err.message}`));
        }
      });
    }).on('error', err => {
      reject(err);
    });
  });
}

async function getUpdateStatus(force = false) {
  const now = Date.now();
  const ttlMs = 10 * 60 * 1000;

  if (!force && now - updateCheckCache.checkedAt < ttlMs) {
    return {
      currentVersion: APP_VERSION,
      latestVersion: updateCheckCache.latestVersion,
      updateAvailable: updateCheckCache.updateAvailable,
      checkedAt: updateCheckCache.checkedAt,
      error: updateCheckCache.error,
    };
  }

  try {
    const latestVersion = await fetchLatestPackageVersionFromNpm(PACKAGE_NAME);
    const updateAvailable = compareSemver(latestVersion, APP_VERSION) > 0;
    updateCheckCache = {
      currentVersion: APP_VERSION,
      latestVersion,
      updateAvailable,
      checkedAt: now,
      error: null,
    };
  } catch (err) {
    updateCheckCache = {
      ...updateCheckCache,
      currentVersion: APP_VERSION,
      checkedAt: now,
      error: err.message,
    };
  }

  return {
    currentVersion: APP_VERSION,
    latestVersion: updateCheckCache.latestVersion,
    updateAvailable: updateCheckCache.updateAvailable,
    checkedAt: updateCheckCache.checkedAt,
    error: updateCheckCache.error,
  };
}

/**
 * Reads and extracts text from a PDF file
 * @param {string} filePath - Path to the PDF file
 * @returns {Promise<Object>} Extracted data including text and metadata
 */
async function extractPDFData(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(fileBuffer);

    return {
      success: true,
      metadata: {
        pages: data.numpages,
        title: data.info?.Title || 'N/A',
        author: data.info?.Author || 'N/A',
        subject: data.info?.Subject || 'N/A',
        creator: data.info?.Creator || 'N/A',
      },
      text: data.text,
      version: data.version,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Extracts text and images from a PDF file
 * @param {string} filePath - Path to the PDF file
 * @returns {Promise<Object>} Extracted data including text, metadata, and images
 */
async function extractPDFDataWithImages(filePath, outputDir) {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Use pdf-parse for text extraction
    const fileBuffer = fs.readFileSync(filePath);
    const textData = await pdfParse(fileBuffer);

    // Extract page renders as images
    const images = await extractPageRenders(fileBuffer, textData.numpages);

    // Extract text with positioning metadata for super/subscript detection
    const textMetadata = await extractTextWithMetadata(fileBuffer, textData.numpages);

    return {
      success: true,
      metadata: {
        pages: textData.numpages,
        title: textData.info?.Title || 'N/A',
        author: textData.info?.Author || 'N/A',
        subject: textData.info?.Subject || 'N/A',
        creator: textData.info?.Creator || 'N/A',
      },
      text: textData.text,
      textMetadata: textMetadata,
      images: images,
      version: textData.version,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Extracts embedded images using pdfjs-dist + @napi-rs/canvas
 * @param {Buffer} fileBuffer - PDF file buffer
 * @param {number} numPages - Number of pages to scan
 * @returns {Promise<Array>} Array of embedded image info
 */
/**
 * Extracts page renders as images (full-page rendering approach)
 * @param {Buffer} fileBuffer - PDF file buffer
 * @param {number} numPages - Number of pages
 * @returns {Promise<Array>} Array of rendered page images
 */
async function extractPageRenders(fileBuffer, numPages) {
  try {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const { createCanvas } = require('@napi-rs/canvas');
    
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(fileBuffer),
      disableWorker: true,
    });
    const pdfDocument = await loadingTask.promise;
    const images = [];

    // Render at 2x scale (200 DPI equivalent) to capture detail without huge file size
    const scale = 2;

    for (let page = 1; page <= Math.min(numPages, pdfDocument.numPages); page++) {
      try {
        const pdfPage = await pdfDocument.getPage(page);
        const viewport = pdfPage.getViewport({ scale });
        const canvas = createCanvas(viewport.width, viewport.height);
        const ctx = canvas.getContext('2d');

        // Render the page
        await pdfPage.render({ canvasContext: ctx, viewport }).promise;
        
        // Convert to PNG
        const base64 = canvas.toBuffer('image/png').toString('base64');
        images.push({
          page,
          width: viewport.width,
          height: viewport.height,
          data: base64,
        });
      } catch (err) {
        // Error rendering page - skip
      }
    }

    return images;
  } catch (err) {
    return [];
  }
}

/**
 * Extracts text with positioning metadata for superscript/subscript detection
 * @param {Buffer} fileBuffer - PDF file buffer
 * @param {number} numPages - Number of pages
 * @returns {Promise<Array>} Array of text items with positioning info
 */
async function extractTextWithMetadata(fileBuffer, numPages) {
  try {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(fileBuffer),
      disableWorker: true,
    });
    const pdfDocument = await loadingTask.promise;
    const textItems = [];

    for (let pageNum = 1; pageNum <= Math.min(numPages, pdfDocument.numPages); pageNum++) {
      try {
        const pdfPage = await pdfDocument.getPage(pageNum);
        const textContent = await pdfPage.getTextContent();
        
        // PDF.js already provides items in reading order
        // Just extract the positioning data we need
        for (const item of textContent.items) {
          if (item.str && item.str.trim()) {
            // Extract height from transform matrix: transform[3] is font size/height
            const height = Math.abs(item.transform[3]); 
            textItems.push({
              text: item.str,
              x: item.transform[4], // transform[4] is X position
              y: item.transform[5], // transform[5] is Y position
              width: item.width,
              height: height,
              font: item.fontName || 'unknown',
              transform: item.transform,
            });
          }
        }
      } catch (err) {
        // Error extracting metadata - skip
      }
    }

    return textItems;
  } catch (err) {
    return [];
  }
}

/**
 * Detects superscript/subscript based on positioning and font size
 * Returns text with HTML markup for super/subscript elements
 * MORE AGGRESSIVE detection with multiple heuristics
 * @param {Array} textItems - Text items with positioning metadata
 * @returns {string} Text with <sup> and <sub> tags
 */
function markupSuperSubscript(textItems) {
  if (textItems.length === 0) return '';

  let result = '';
  let superCount = 0;
  let subCount = 0;

  // Calculate statistics for detection
  const heights = textItems.map(item => item.height).filter(h => h > 0);
  const ys = textItems.map(item => Math.round(item.y));
  
  // Median baseline Y position and font size (more robust than mode)
  const sortedHeights = [...heights].sort((a, b) => a - b);
  const baselineFontSize = sortedHeights[Math.floor(sortedHeights.length / 2)];
  
  const yFreq = {};
  ys.forEach(y => { yFreq[y] = (yFreq[y] || 0) + 1; });
  const baselineY = parseInt(Object.keys(yFreq).reduce((a, b) => (yFreq[a] > yFreq[b] ? a : b)));

  const lineBin = 2;
  const lineBuckets = new Map();
  for (const item of textItems) {
    const key = Math.round(item.y / lineBin) * lineBin;
    if (!lineBuckets.has(key)) {
      lineBuckets.set(key, []);
    }
    lineBuckets.get(key).push(item);
  }

  const lineStats = new Map();
  for (const [key, items] of lineBuckets.entries()) {
    // Skip lines with very few items (unreliable baseline)
    if (items.length < 2) {
      continue;
    }

    const maxHeight = Math.max(...items.map(item => item.height));
    const normalItems = items.filter(item => item.height >= maxHeight * 0.9);
    const heightSource = normalItems.length > 0 ? normalItems : items;
    const ySource = normalItems.length > 0 ? normalItems : items;

    const heightSorted = [...heightSource].map(item => item.height).sort((a, b) => a - b);
    const ySorted = [...ySource].map(item => item.y).sort((a, b) => a - b);

    const lineBaselineFontSize = heightSorted[Math.floor(heightSorted.length / 2)];
    const lineBaselineY = ySorted[Math.floor(ySorted.length / 2)];

    lineStats.set(key, { baselineY: lineBaselineY, baselineFontSize: lineBaselineFontSize });
  }

  // Classify with permissive thresholds
  for (let i = 0; i < textItems.length; i++) {
    const item = textItems[i];
    const nextItem = textItems[i + 1];
    
    const lineKey = Math.round(item.y / lineBin) * lineBin;
    const stats = lineStats.get(lineKey);
    const effectiveBaselineY = stats ? stats.baselineY : baselineY;
    const effectiveBaselineFontSize = stats ? stats.baselineFontSize : baselineFontSize;

    const positionDiff = item.y - effectiveBaselineY; // Signed difference to detect direction
    const absDiff = Math.abs(positionDiff);
    const sizeFactor = item.height / effectiveBaselineFontSize;
    const isSmaller = sizeFactor < 0.85; // Tightened: 85% instead of 90%
    const isNumeric = /^[0-9-]+$/.test(item.text);
    const isSymbol = /^[+\-]$/.test(item.text);

    // Detect super/subscript based on size and/or position
    // 1) Must be significantly smaller (< 85%) AND shifted
    // 2) Numeric/symbol with larger shift, even if font size matches baseline
    const isShifted = absDiff > 0.5; // Tightened: 0.5px instead of 0.3px
    const isSameSizeShifted = absDiff > 2.0 && (isNumeric || isSymbol); // Tightened: 2.0px instead of 1.2px
    
    // Don't mark very long text runs (> 30 chars) as super/subscript
    // These are likely regular paragraphs, not actual markup
    const isLongRun = item.text.length > 30;
    
    // Don't mark regular words as super/subscript unless they're very clearly shifted
    // Allow single letters, numbers, symbols, but filter out dictionary words
    const isWord = /^[a-zA-Z]{3,}$/.test(item.text);
    const isVeryShifted = absDiff > 2.5;
    
    const isSuperSubscript = ((isSmaller && isShifted) || isSameSizeShifted) && !(isWord && !isVeryShifted);

    if (isSuperSubscript && !isLongRun) {
      // Character is smaller and shifted - determine which based on direction
      if (positionDiff > 0) {
        // Positive diff: character is higher in document (standard coords: superscript)
        result += '<sup>' + item.text + '</sup>';
        superCount += 1;
      } else {
        // Negative diff: character is lower in document (standard coords: subscript)
        result += '<sub>' + item.text + '</sub>';
        subCount += 1;
      }
    } else {
      result += item.text;
    }

    // Add space before next item if X gap is large enough
    if (nextItem && nextItem.x - (item.x + item.width) > item.width * 0.25) {
      result += ' ';
    }
  }

  console.log(
    `[Super/Subscript Summary] items=${textItems.length} baselineY=${baselineY} baselineSize=${baselineFontSize.toFixed(2)} super=${superCount} sub=${subCount}`
  );
  return result;
}

function mergeMarkupIntoText(baseText, markupText) {
  const tokens = [];
  const tagRegex = /<\/?(?:sup|sub)>/g;
  let lastIndex = 0;
  let match;

  while ((match = tagRegex.exec(markupText)) !== null) {
    const chunk = markupText.slice(lastIndex, match.index);
    for (const ch of chunk) {
      tokens.push({ type: 'char', value: ch });
    }
    tokens.push({ type: 'tag', value: match[0] });
    lastIndex = match.index + match[0].length;
  }

  const tail = markupText.slice(lastIndex);
  for (const ch of tail) {
    tokens.push({ type: 'char', value: ch });
  }

  const baseChars = [];
  for (let i = 0; i < baseText.length; i++) {
    const ch = baseText[i];
    if (!/\s/.test(ch)) {
      baseChars.push({ ch: normalizePdfMathCharacters(ch), index: i });
    }
  }

  const markupChars = [];
  for (const token of tokens) {
    if (token.type === 'char' && !/\s/.test(token.value)) {
      markupChars.push(normalizePdfMathCharacters(token.value));
    }
  }

  const mappedIndices = new Array(markupChars.length).fill(null);
  let basePtr = 0;

  for (let i = 0; i < markupChars.length; i++) {
    const target = markupChars[i];
    let found = false;
    while (basePtr < baseChars.length) {
      if (baseChars[basePtr].ch === target) {
        mappedIndices[i] = basePtr;
        basePtr += 1;
        found = true;
        break;
      }
      basePtr += 1;
    }
    if (!found) {
      mappedIndices[i] = null;
    }
  }

  const insertBefore = {};
  let markupCharIndex = 0;

  for (const token of tokens) {
    if (token.type === 'tag') {
      let targetIndex = mappedIndices[markupCharIndex];
      if (targetIndex === null || targetIndex === undefined) {
        for (let j = markupCharIndex + 1; j < mappedIndices.length; j++) {
          if (mappedIndices[j] !== null && mappedIndices[j] !== undefined) {
            targetIndex = mappedIndices[j];
            break;
          }
        }
      }
      if (targetIndex !== null && targetIndex !== undefined) {
        const baseIndex = baseChars[targetIndex].index;
        insertBefore[baseIndex] = (insertBefore[baseIndex] || '') + token.value;
      }
    } else if (!/\s/.test(token.value)) {
      markupCharIndex += 1;
    }
  }

  if (Object.keys(insertBefore).length === 0) {
    return baseText;
  }

  let output = '';
  for (let i = 0; i < baseText.length; i++) {
    if (insertBefore[i]) {
      output += insertBefore[i];
    }
    output += baseText[i];
  }

  return output;
}

async function extractEmbeddedImages(fileBuffer, numPages) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = require('@napi-rs/canvas');
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(fileBuffer),
    disableWorker: true,
  });
  const pdfDocument = await loadingTask.promise;

  const images = [];
  const extractedImageNames = new Set();

  for (let page = 1; page <= numPages; page++) {
    try {
      const pdfPage = await pdfDocument.getPage(page);
      
      // Render at a very small size to minimize memory use
      try {
        const viewport = pdfPage.getViewport({ scale: 0.2 });
        const canvas = createCanvas(viewport.width, viewport.height);
        const ctx = canvas.getContext('2d');
        await pdfPage.render({ canvasContext: ctx, viewport }).promise;
      } catch (renderErr) {
        // Render error - skip
      }

      // Get operator list
      let ops;
      try {
        ops = await pdfPage.getOperatorList();
      } catch (opsErr) {
        continue;
      }
      
      // Find all image XObjects
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        if (fn === pdfjsLib.OPS.paintImageXObject || fn === pdfjsLib.OPS.paintInlineImageXObject) {
          const imageName = ops.argsArray[i][0];
          
          // Skip if we already tried to extract this
          if (extractedImageNames.has(imageName)) continue;
          extractedImageNames.add(imageName);
          
          let image = null;
          
          // Try multiple strategies to get the image
          try {
            image = await pdfPage.objs.get(imageName);
          } catch (err1) {
            try {
              image = await pdfPage.commonObjs.get(imageName);
            } catch (err2) {
              // Try accessing through PDFWorker promise mechanism
              try {
                // Some objects are lazy-loaded via promise
                const obj = pdfPage.objs.objs[imageName];
                if (obj && obj.promise) {
                  image = await obj.promise;
                }
              } catch (err3) {
                // Last resort: try to get from the PDF's resource dict
              }
            }
          }
          
          if (!image || !image.data || !image.width || !image.height) {
            continue;
          }

          // Try to convert and save
          try {
            const imgCanvas = createCanvas(image.width, image.height);
            const imgCtx = imgCanvas.getContext('2d');
            const imageData = imgCtx.createImageData(image.width, image.height);

            const expectedRGB = image.width * image.height * 3;
            const expectedRGBA = image.width * image.height * 4;
            
            if (image.data.length === expectedRGBA) {
              imageData.data.set(image.data);
            } else if (image.data.length === expectedRGB) {
              for (let p = 0, q = 0; p < image.data.length; p += 3, q += 4) {
                imageData.data[q] = image.data[p];
                imageData.data[q + 1] = image.data[p + 1];
                imageData.data[q + 2] = image.data[p + 2];
                imageData.data[q + 3] = 255;
              }
            } else {
              if (image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray) {
                imageData.data.set(new Uint8ClampedArray(image.data));
              } else {
                continue;
              }
            }

            imgCtx.putImageData(imageData, 0, 0);
            const base64 = imgCanvas.toBuffer('image/png').toString('base64');
            images.push({ page, width: image.width, height: image.height, data: base64 });
          } catch (canvasErr) {
            // Canvas error - skip
          }
        }
      }
    } catch (err) {
      // Page error - skip
    }
  }

  return images;
}

/**
 * Exports extracted PDF data to JSON format
 * @param {Object} pdfData - Extracted PDF data
 * @param {string} outputPath - Path for output JSON file
 */
/**
 * Exports extracted PDF data to plain text format
 * @param {Object} pdfData - Extracted PDF data
 * @param {string} outputPath - Path for output text file
 */
function exportToText(pdfData, outputPath) {
  try {
    const content = `PDF Extraction Report\n${'='.repeat(50)}\n\nMetadata:\n${JSON.stringify(pdfData.metadata, null, 2)}\n\nContent:\n${'='.repeat(50)}\n\n${pdfData.text}`;
    fs.writeFileSync(outputPath, content);
    console.log(`✓ Text file saved to: ${outputPath}`);
    return true;
  } catch (error) {
    console.error(`✗ Error saving text: ${error.message}`);
    return false;
  }
}

/**
 * Applies superscript/subscript markup to HTML by detecting common patterns
 * COMPREHENSIVE pattern matching for chemical, mathematical, and standard notation
 * @param {string} html - HTML content
 * @returns {string} HTML with super/subscript markup
 */
function applySuperSubscriptMarkup(html) {
  let result = html;

  const normalizeExponentToken = (raw) => {
    return String(raw).replace(/[lI]/g, '1');
  };
  
  // SUBSCRIPT PATTERNS - Basic chemical formulas
  result = result.replace(/H2O/gi, 'H<sub>2</sub>O');
  result = result.replace(/H3O/gi, 'H<sub>3</sub>O');
  result = result.replace(/CO2/gi, 'CO<sub>2</sub>');
  result = result.replace(/CO3/gi, 'CO<sub>3</sub>');
  result = result.replace(/N2O/gi, 'N<sub>2</sub>O');
  result = result.replace(/NO2/gi, 'NO<sub>2</sub>');
  result = result.replace(/NO3/gi, 'NO<sub>3</sub>');
  result = result.replace(/SO2/gi, 'SO<sub>2</sub>');
  result = result.replace(/SO3/gi, 'SO<sub>3</sub>');
  result = result.replace(/SO4/gi, 'SO<sub>4</sub>');
  result = result.replace(/CH4/gi, 'CH<sub>4</sub>');
  result = result.replace(/O2/gi, 'O<sub>2</sub>');
  result = result.replace(/N2/gi, 'N<sub>2</sub>');
  
  // Unicode subscript digits (if present in text)
  result = result.replace(/([a-zA-Z])([₀-₉]+)/g, '$1<sub>$2</sub>');
  
  // Generic pattern: Letter followed by one or two digits (not in tags)
  // e.g., "PH2" -> "PH<sub>2</sub>" but avoid if already in a tag
  result = result.replace(/([A-Z][a-z]?)([0-9]{1,2})(?=[^0-9<]|$)/g, function(match, letters, nums) {
    // Don't process if already in a tag
    const beforeContext = result.substring(Math.max(0, result.indexOf(match) - 10), result.indexOf(match));
    if (beforeContext.includes('<')) return match;
    return letters + '<sub>' + nums + '</sub>';
  });
  
  // SUPERSCRIPT PATTERNS - Mathematical and ordinals
  
  // Unicode superscript digits
  result = result.replace(/([a-zA-Z0-9])([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g, '$1<sup>$2</sup>');
  
  // Math notation: x^2, a^n, etc.
  result = result.replace(/([a-zA-Z])\^([0-9]+)/gi, '$1<sup>$2</sup>');
  result = result.replace(/\^([0-9]+)/g, '<sup>$1</sup>');
  
  // Powers: 10^x, 2^x, 3^x, etc.
  result = result.replace(/([0-9]+)\^([0-9]+)/g, '$1<sup>$2</sup>');
  
  // Ordinal numbers: 1st, 2nd, 3rd, 21st, etc.
  result = result.replace(/([0-9]+)(st|nd|rd|th)\b/gi, '$1<sup>$2</sup>');

  // Unit exponents with spaced negative powers (e.g., cm -3, s -1, mol -1)
  // Handles unicode minus and flexible spacing before punctuation
  result = result.replace(/\b(cm|mm|m|km|s|g|kg|mol|K|Pa|MPa|kJ|J|W|Hz|N|eV)\b\s*[-−–]\s*([0-9]+)(?=\b|[^0-9])/g, '$1<sup>-$2</sup>');

  // Common OCR confusion where exponent 1 is read as lowercase l / uppercase I
  // Examples: g -l, s -I -> g<sup>-1</sup>, s<sup>-1</sup>
  result = result.replace(/\b(cm|mm|m|km|s|g|kg|mol|K|Pa|MPa|kJ|J|W|Hz|N|eV)\b\s*[-−–]\s*([lI])(?=\b|[^a-zA-Z0-9])/g, (_m, unit, exp) => `${unit}<sup>-${normalizeExponentToken(exp)}</sup>`);

  // Handle compact mass-density OCR forms like "gm -3" -> "g m<sup>-3</sup>"
  result = result.replace(/\bgm\b\s*[-−–]\s*([0-9lI]+)(?=\b|[^0-9])/g, (_m, exp) => `g m<sup>-${normalizeExponentToken(exp)}</sup>`);

  // Fix spaced chemical formulas that often appear after PDF extraction, e.g. "NH 4", "H 2 O", "ClO 4"
  result = result.replace(/\b(NH|ClO|CO|SO|NO|CH|H|O|N)\s+([0-9]{1,2})(?=\b|\s|\))/g, '$1<sub>$2</sub>');
  
  // Footnote/reference markers: (1), (2), [1], [2], etc.
  result = result.replace(/\(([0-9]{1,3})\)(?=[\s,;:]|$)/g, '<sup>($1)</sup>');
  result = result.replace(/\[([0-9]{1,3})\]/g, '<sup>[$1]</sup>');
  
  return result;
}

/**
 * Converts inline alpha-paren lists (a) b) c)) inside paragraphs to ordered lists.
 * Example: "Some intro: a) First item b) Second item" -> <ol style="list-style-type: lower-alpha;">...</ol>
 * @param {string} html - HTML content
 * @returns {string} HTML with ordered lists
 */
function convertAlphaParenLists(html) {
  const paragraphRegex = /<p([^>]*)>([\s\S]*?)<\/p>/g;

  const markerRegex = /(^|[\s:;])([a-h])\)\s+/g;

  return html.replace(paragraphRegex, (match, attrs, inner) => {
    const matches = [...inner.matchAll(markerRegex)];
    if (matches.length < 1) {
      return match;
    }

    const firstMatch = matches[0];
    const introEnd = firstMatch.index + firstMatch[1].length;
    const introText = inner.slice(0, introEnd).trimEnd();

    const items = [];
    for (let i = 0; i < matches.length; i++) {
      const current = matches[i];
      const itemStart = current.index + current[0].length;
      const next = matches[i + 1];
      const itemEnd = next ? next.index : inner.length;
      const rawItem = inner.slice(itemStart, itemEnd).trim();
      if (rawItem) {
        items.push(rawItem);
      }
    }

    if (items.length < 1) {
      return match;
    }

    if (items.length < 2 && introText) {
      return match;
    }

    let tailText = '';
    const lastItem = items[items.length - 1];
    const tailSplit = lastItem.match(/^([\s\S]+?\.)\s+([A-Z][\s\S]{20,})$/);
    if (tailSplit) {
      items[items.length - 1] = tailSplit[1].trim();
      tailText = tailSplit[2].trim();
    }

    const introParagraph = introText ? `<p${attrs}>${introText}</p>` : '';
    const listHtml = `\n  <ol style="margin: 10px 0; padding-left: 20px; list-style-type: lower-alpha;">\n${items
      .map(item => `    <li style="margin: 5px 0;">${item}</li>`)
      .join('\n')}\n  </ol>`;
    const tailParagraph = tailText ? `\n  <p${attrs}>${tailText}</p>` : '';

    return `${introParagraph}${listHtml}${tailParagraph}`;
  });
}

/**
 * Converts inline numeric-paren lists (1) 2) 3)) inside paragraphs to ordered lists.
 * Example: "Intro: 1) First 2) Second" -> <ol>...</ol>
 * @param {string} html - HTML content
 * @returns {string} HTML with ordered lists
 */
function convertNumberParenLists(html) {
  const paragraphRegex = /<p([^>]*)>([\s\S]*?)<\/p>/g;
  const markerRegex = /(^|[\s:;])([1-9]\d*)\)\s+/g;

  return html.replace(paragraphRegex, (match, attrs, inner) => {
    const matches = [...inner.matchAll(markerRegex)];
    if (matches.length < 2) {
      return match;
    }

    const firstMatch = matches[0];
    const introEnd = firstMatch.index + firstMatch[1].length;
    const introText = inner.slice(0, introEnd).trimEnd();

    const items = [];
    for (let i = 0; i < matches.length; i++) {
      const current = matches[i];
      const itemStart = current.index + current[0].length;
      const next = matches[i + 1];
      const itemEnd = next ? next.index : inner.length;
      const rawItem = inner.slice(itemStart, itemEnd).trim();
      if (rawItem) {
        items.push(rawItem);
      }
    }

    if (items.length < 2) {
      return match;
    }

    const introParagraph = introText ? `<p${attrs}>${introText}</p>` : '';
    const listHtml = `\n  <ol style="margin: 10px 0; padding-left: 20px;">\n${items
      .map(item => `    <li style="margin: 5px 0;">${item}</li>`)
      .join('\n')}\n  </ol>`;
    return `${introParagraph}${listHtml}`;
  });
}

/**
 * Converts inline bullet lists (• or private-use bullet) inside paragraphs to unordered lists.
 * Example: "Intro: • First • Second" -> <ul>...</ul>
 * @param {string} html - HTML content
 * @returns {string} HTML with unordered lists
 */
function convertBulletLists(html) {
  const paragraphRegex = /<p([^>]*)>([\s\S]*?)<\/p>/g;
  const markerRegex = /(^|[\s:;])(?:\u2022|\uF0B7)\s+/g;

  return html.replace(paragraphRegex, (match, attrs, inner) => {
    const matches = [...inner.matchAll(markerRegex)];
    if (matches.length < 2) {
      return match;
    }

    const firstMatch = matches[0];
    const introEnd = firstMatch.index + firstMatch[1].length;
    const introText = inner.slice(0, introEnd).trimEnd();

    const items = [];
    for (let i = 0; i < matches.length; i++) {
      const current = matches[i];
      const itemStart = current.index + current[0].length;
      const next = matches[i + 1];
      const itemEnd = next ? next.index : inner.length;
      const rawItem = inner.slice(itemStart, itemEnd).trim();
      if (rawItem) {
        items.push(rawItem);
      }
    }

    if (items.length < 2) {
      return match;
    }

    const introParagraph = introText ? `<p${attrs}>${introText}</p>` : '';
    const listHtml = `\n  <ul style="margin: 10px 0; padding-left: 20px;">\n${items
      .map(item => `    <li style="margin: 5px 0;">${item}</li>`)
      .join('\n')}\n  </ul>`;
    return `${introParagraph}${listHtml}`;
  });
}

/**
 * Merges adjacent content blocks that each contain a single unordered list.
 * This handles PDF extraction cases where one logical bullet list is split
 * across multiple lines/blocks.
 * @param {string} html - HTML content
 * @returns {string} HTML with merged adjacent bullet blocks
 */
function mergeAdjacentBulletBlocks(html) {
  if (!html || typeof html !== 'string') {
    return html;
  }

  let mergedHtml = html;
  let previous;

  const adjacentUlBlocksPattern = /<div class="content-block">\s*<ul([^>]*)>([\s\S]*?)<\/ul>\s*<\/div>\s*<div class="content-block">\s*<ul([^>]*)>([\s\S]*?)<\/ul>\s*<\/div>/g;

  do {
    previous = mergedHtml;
    mergedHtml = mergedHtml.replace(
      adjacentUlBlocksPattern,
      (_match, attrs1, listItems1, _attrs2, listItems2) => {
        return `<div class="content-block"><ul${attrs1}>${listItems1}${listItems2}</ul></div>`;
      }
    );
  } while (mergedHtml !== previous);

  return mergedHtml;
}

/**
 * Applies text transformations to clean up extracted text
 * @param {string} text - Text to transform
 * @returns {string} Transformed text
 */
function applyTextTransformations(text, options = {}) {
  const preserveLineBreakAlignment = options.preserveLineBreakAlignment === true;
  let transformedText = text;
  
  // Fix known PDF glyph-to-Unicode mismaps (math italic letters, etc.)
  transformedText = normalizePdfMathCharacters(transformedText);
  
  // Remove line breaks that are NOT paragraph breaks
  // This can shift alignment for metadata-based super/sub merge, so allow opt-out.
  if (!preserveLineBreakAlignment) {
    transformedText = removeNonParagraphLineBreaks(transformedText);
  }

  // Remove double-spaces (and any multiple consecutive spaces)
  transformedText = transformedText.replace(/  +/g, ' ');
  
  // Normalize spacing that interferes with super/subscript detection
  // "H 2 O" -> "H2O", "x ^ 2" -> "x^2"
  transformedText = transformedText.replace(/([A-Z])\s+([0-9]+)\s+([A-Z])/g, '$1$2$3');
  transformedText = transformedText.replace(/([a-zA-Z])\s*\^\s*([0-9]+)/g, '$1^$2');
  
  return transformedText;
}

/**
 * Normalizes known PDF glyph-to-Unicode mismaps for math/italic symbols.
 * This PDF uses a font with missing/incorrect ToUnicode mappings, which can
 * produce Hangul syllables instead of math italic letters.
 * @param {string} text - Text to normalize
 * @returns {string} Normalized text
 */
function normalizePdfMathCharacters(text) {
  const replacements = {
    '': 'α',
    '': 'β',
    '': 'γ',
    '': 'δ',
    '': 'ε',
    '': 'θ',
    '': 'λ',
    '': 'μ',
    '': 'π',
    '': 'ρ',
    '': 'σ',
    '': 'τ',
    '': 'φ',
    '': 'χ',
    '': 'ψ',
    '': 'ω',
    '푎': '𝑎',
    '푛': '𝑛',
    '풏': '𝑛',
    '푟': '𝑟',
    '푃': '𝑃',
    '푐': '𝑐',
    '푚': '𝑚',
    '퐴': '𝐴',
    '푠': '𝑠',
    '푥': '𝑥',
    '퐾': '𝐾',
    '푘': '𝑘',
    '푡': '𝑡',
    '푁': '𝑁',
    '휌': '𝜌',
    '푇': '𝑇',
    '휋': '𝜋',
    '푑': '𝑑',
    '흅': '𝝅',
    '풌': '𝒌',
    '풕': '𝒕',
    '훼': '𝛼',
    '푝': '𝑝',
    '훽': '𝛽',
    '퐹': '𝐹',
    '푒': '𝑒',
    '푭': '𝑭',
    'ퟏ': '𝟏',
    'ퟐ': '𝟐',
    '푷': '𝑷',
    '풆': '𝒆',
    '풅': '𝒅',
    '풎': '𝒎',
    '풗': '𝒗',
    '푨': '𝑨',
    '푣': '𝑣',
    '푀': '𝑀̅',
    '퐼': '𝐼',
    '푔': '𝑔',
    '퐻': '𝐻',
    '퐶': '𝐶',
    '훾': '𝛾',
    '푅': '𝑅',
    '푉': '𝑉',
    '푙': '𝑙',
    '표': '𝑜',
    '푖': '𝑖',
    '푦': '𝑦',
    '푏': '𝑏',
    '푢': '𝑢',
    '퐿': '𝐿',
    '퐷': '𝐷',
  };

  return text.replace(/[\uAC00-\uD7AF\uD7B0-\uD7FF]/g, (ch) => replacements[ch] || ch);
}

/**
 * Removes line breaks that are not paragraph breaks.
 * Paragraph breaks are detected by blank lines, numbered headings (1, 1.1, etc.),
 * or by lines ending with a sentence terminator followed by 2+ trailing spaces.
 * @param {string} text - Text to process
 * @returns {string} Text with non-paragraph line breaks removed
 */
function removeNonParagraphLineBreaks(text, options = {}) {
  const pageBreakAware = options.pageBreakAware === true;
  const logPageBreakJoins = options.logPageBreakJoins === true;
  const logLabel = options.logLabel || 'text';
  const lines = text.split(/\r?\n/);
  const output = [];
  let currentParagraph = '';
  let pageBreakJoinCount = 0;

  const isStrongPageMarker = (value) => {
    const trimmed = value.trim();
    return /^Page[-\s]*\d+$/i.test(trimmed)
      || /^Page\s+\d+\s+of\s+\d+$/i.test(trimmed);
  };

  const isLikelyNumericPageMarker = (value) => /^\d{1,3}$/.test(value.trim());

  const isNumberedHeading = (value) => /^\d+(\.\d+)*\s+/.test(value);
  const isLikelyHeading = (value) => {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 90) return false;
    return /^[A-Z][A-Z0-9\s\-,:()&\/\.]+$/.test(trimmed);
  };

  const shouldContinueAcrossPageBreak = (prevText, nextText) => {
    if (!prevText || !nextText) return false;
    if (isNumberedHeading(nextText) || isLikelyHeading(nextText)) return false;

    const prevEndsSentence = /[.!?]["')\]]?$/.test(prevText);
    if (prevEndsSentence) return false;

    const prevEndsColon = /[:;]$/.test(prevText);
    const prevEndsHyphen = /[-‐‑‒–—]$/.test(prevText);
    const nextStartsContinuation = /^[a-z(\[\{]/.test(nextText)
      || /^[,;:)/\]\}]/.test(nextText)
      || /^[-‐‑‒–—]/.test(nextText);

    return prevEndsHyphen || nextStartsContinuation || !prevEndsColon;
  };

  const flushParagraph = () => {
    if (currentParagraph.length > 0) {
      output.push(currentParagraph.trim());
      currentParagraph = '';
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isBlankLine = line.trim().length === 0;
    if (isBlankLine) {
      if (pageBreakAware && currentParagraph.length > 0) {
        let lookahead = i + 1;
        while (lookahead < lines.length && lines[lookahead].trim().length === 0) {
          lookahead += 1;
        }

        let sawPageMarker = false;
        while (
          lookahead < lines.length &&
          (isStrongPageMarker(lines[lookahead]) || isLikelyNumericPageMarker(lines[lookahead]))
        ) {
          sawPageMarker = true;
          lookahead += 1;
          while (lookahead < lines.length && lines[lookahead].trim().length === 0) {
            lookahead += 1;
          }
        }

        if (sawPageMarker && lookahead < lines.length) {
          const nextLine = lines[lookahead].trim();
          const prevText = currentParagraph.trim();
          if (shouldContinueAcrossPageBreak(prevText, nextLine)) {
            pageBreakJoinCount += 1;
            i = lookahead - 1;
            continue;
          }
        }
      }

      flushParagraph();
      output.push('');
      continue;
    }

    const trimmedLine = line.trim();    
    // Skip page markers (e.g., "Page-2", "Page-10")
    const isPageMarker = isStrongPageMarker(trimmedLine);
    if (isPageMarker) {
      continue;
    }
    
    // Detect numbered headings (1, 1.1, 1.2.3, etc.)
    const headingDetected = isNumberedHeading(trimmedLine);
    if (headingDetected) {
      flushParagraph();
      output.push(trimmedLine);
      continue;
    }

    const endsParagraph = /[.!?]["')\]]?\s{2,}$/.test(line);

    if (currentParagraph.length > 0) {
      currentParagraph += ` ${trimmedLine}`;
    } else {
      currentParagraph = trimmedLine;
    }

    if (endsParagraph) {
      flushParagraph();
    }
  }

  flushParagraph();
  if (pageBreakAware && logPageBreakJoins) {
    console.log(`[PageBreakJoin] ${logLabel}: joined=${pageBreakJoinCount}`);
  }
  return output.join('\n');
}

/**
 * Exports extracted PDF data to plain text format with transformations applied
 * @param {Object} pdfData - Extracted PDF data
 * @param {string} outputPath - Path for output text file
 */
function exportToEditedText(pdfData, outputPath) {
  try {
    const transformedText = applyTextTransformations(pdfData.text);
    const content = `PDF Extraction Report (Edited)
${'='.repeat(50)}

Metadata:
${JSON.stringify(pdfData.metadata, null, 2)}

Content:
${'='.repeat(50)}

${transformedText}`;
    fs.writeFileSync(outputPath, content);
    console.log(`✓ Edited text file saved to: ${outputPath}`);
    return true;
  } catch (error) {
    console.error(`✗ Error saving edited text: ${error.message}`);
    return false;
  }
}

function applyHighlightOverlayFeatures(html, options = {}) {
  const readOnly = options.readOnly === true;
  const minimapDefaultVisible = options.minimapDefaultVisible !== false;
  let output = html;

  if (readOnly) {
    output = output.replace(/<script[\s\S]*?<\/script>/gi, '');
    output = output.replace(/<!-- Edit Modal -->[\s\S]*?<\/div>\s*<\/div>\s*/i, '');
  }

  output = output.replace(/<(sup|sub)([^>]*)>/gi, (_match, tagName, attrs) => {
    const highlightClass = String(tagName).toLowerCase() === 'sub' ? 'hl-sub' : 'hl-sup';
    if (/\bclass\s*=\s*"/i.test(attrs)) {
      return `<${tagName}${attrs.replace(/\bclass\s*=\s*"([^"]*)"/i, (_m, classVal) => ` class="${classVal} ${highlightClass}"`)}>`;
    }
    return `<${tagName}${attrs} class="${highlightClass}">`;
  });

  const highlightPanelHtml = `
  <div id="highlightControls" class="highlight-panel" role="region" aria-label="Highlight Controls">
    <label class="hl-item"><input type="checkbox" id="toggleHighlights" checked> Highlights</label>
    <label class="hl-item"><input type="checkbox" id="toggleSup" checked> Superscript</label>
    <label class="hl-item"><input type="checkbox" id="toggleSub" checked> Subscript</label>
    <label class="hl-item"><input type="checkbox" id="toggleMinimap" ${minimapDefaultVisible ? 'checked' : ''}> Minimap</label>
    <span class="hl-counts">Total: <strong id="countTotal">0</strong> | Sup: <strong id="countSup">0</strong> | Sub: <strong id="countSub">0</strong></span>
  </div>`;

  const minimapHtml = `
  <div id="highlightMinimap" class="highlight-minimap" aria-label="Superscript and subscript map">
    <div class="minimap-track"></div>
    <div id="minimapMarkers" class="minimap-markers"></div>
  </div>`;

  output = output.replace(
    /<body([^>]*)>/i,
    `<body$1 class="highlights-on show-sup show-sub${minimapDefaultVisible ? ' show-minimap' : ''}">${highlightPanelHtml}${minimapHtml}`
  );

  const readOnlyStyles = readOnly
    ? `
    .block-buttons,
    .copy-btn,
    .copy-html-btn,
    .edit-btn,
    .edit-modal,
    .format-toolbar,
    #backToTop,
    #backToToc {
      display: none !important;
      visibility: hidden !important;
    }
    .content-block,
    .content-block.editable {
      padding-right: 10px !important;
      padding-top: 10px !important;
      cursor: default !important;
    }
    `
    : '';

  const highlightStyles = `<style>
    .container {
      margin-top: 64px !important;
    }
    .highlight-panel {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 2000;
      display: flex;
      gap: 20px;
      align-items: center;
      padding: 10px 16px;
      background: #ffffff;
      border-bottom: 1px solid #d8d8d8;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      font-size: 14px;
    }
    .highlight-panel .hl-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: #222;
      user-select: none;
    }
    .hl-counts {
      margin-left: auto;
      color: #333;
      font-size: 13px;
      white-space: nowrap;
    }
    .highlight-minimap {
      position: fixed;
      top: 74px;
      right: 10px;
      bottom: 20px;
      width: 14px;
      z-index: 5000;
      border-radius: 8px;
      background: rgba(12, 16, 24, 0.92);
      border: 1px solid rgba(255, 255, 255, 0.25);
      overflow: hidden;
      pointer-events: auto;
    }
    body:not(.highlights-on) .highlight-minimap {
      display: none !important;
    }
    body:not(.show-minimap) .highlight-minimap {
      display: none !important;
    }
    .minimap-track {
      position: absolute;
      inset: 0;
      background: transparent;
      pointer-events: none;
    }
    .minimap-markers {
      position: absolute;
      inset: 0;
      z-index: 2;
      pointer-events: auto;
    }
    .minimap-marker {
      position: absolute;
      left: 1px;
      width: 10px;
      height: 5px;
      border: none;
      border-radius: 3px;
      padding: 0;
      margin: 0;
      cursor: pointer;
      opacity: 0.95;
      pointer-events: auto;
    }
    .minimap-marker.mm-sup {
      background: #ffeb3b;
    }
    .minimap-marker.mm-sub {
      background: #8dff8d;
    }
    body:not(.show-sup) .minimap-marker.mm-sup {
      display: none;
    }
    body:not(.show-sub) .minimap-marker.mm-sub {
      display: none;
    }
    .hl-sup,
    .hl-sub {
      border-radius: 2px;
      padding: 0 1px;
      transition: background-color 0.15s ease;
    }
    body.highlights-on.show-sup .hl-sup {
      background-color: #ffeb3b !important;
    }
    body.highlights-on.show-sub .hl-sub {
      background-color: #8dff8d !important;
    }
    ${readOnlyStyles}
  </style>`;

  output = output.replace('</head>', `${highlightStyles}\n</head>`);

  const highlightScript = `<script>
    (function () {
      const root = document.body;
      const toggleAll = document.getElementById('toggleHighlights');
      const toggleSup = document.getElementById('toggleSup');
      const toggleSub = document.getElementById('toggleSub');
      const toggleMinimap = document.getElementById('toggleMinimap');
      const countTotal = document.getElementById('countTotal');
      const countSup = document.getElementById('countSup');
      const countSub = document.getElementById('countSub');
      const markersHost = document.getElementById('minimapMarkers');
      if (!root || !toggleAll || !toggleSup || !toggleSub || !toggleMinimap || !markersHost) return;

      function getLiveHighlights() {
        const supers = Array.from(document.querySelectorAll('.hl-sup')).filter(el => el.isConnected);
        const subs = Array.from(document.querySelectorAll('.hl-sub')).filter(el => el.isConnected);
        return { supers, subs, all: [...supers, ...subs] };
      }

      function updateCounts() {
        const { supers, subs, all } = getLiveHighlights();
        if (countTotal) countTotal.textContent = String(all.length);
        if (countSup) countSup.textContent = String(supers.length);
        if (countSub) countSub.textContent = String(subs.length);
        return { supers, subs, all };
      }

      function markerTopPercent(el) {
        const docHeight = Math.max(document.documentElement.scrollHeight, 1);
        const topPx = el.getBoundingClientRect().top + window.scrollY;
        return Math.max(0, Math.min(100, (topPx / docHeight) * 100));
      }

      function buildMinimap() {
        const { all } = updateCounts();
        markersHost.innerHTML = '';
        all.forEach((el, index) => {
          const marker = document.createElement('button');
          marker.type = 'button';
          marker.className = 'minimap-marker ' + (el.classList.contains('hl-sub') ? 'mm-sub' : 'mm-sup');
          marker.style.top = 'calc(' + markerTopPercent(el).toFixed(4) + '% - 2px)';
          marker.title = el.classList.contains('hl-sub') ? 'Subscript' : 'Superscript';
          marker.setAttribute('aria-label', marker.title + ' marker ' + (index + 1));
          marker.addEventListener('click', () => {
            if (!el.isConnected) {
              buildMinimap();
              return;
            }
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          });
          markersHost.appendChild(marker);
        });
      }

      function updateHighlightState() {
        root.classList.toggle('highlights-on', toggleAll.checked);
        root.classList.toggle('show-sup', toggleSup.checked);
        root.classList.toggle('show-sub', toggleSub.checked);
        root.classList.toggle('show-minimap', toggleMinimap.checked);
        toggleSup.disabled = !toggleAll.checked;
        toggleSub.disabled = !toggleAll.checked;
        toggleMinimap.disabled = !toggleAll.checked;
      }

      toggleAll.addEventListener('change', updateHighlightState);
      toggleSup.addEventListener('change', updateHighlightState);
      toggleSub.addEventListener('change', updateHighlightState);
      toggleMinimap.addEventListener('change', updateHighlightState);
      window.addEventListener('resize', buildMinimap);

      const contentHost = document.querySelector('.content') || document.body;
      let minimapRebuildTimer = null;
      const observer = new MutationObserver(() => {
        if (minimapRebuildTimer) clearTimeout(minimapRebuildTimer);
        minimapRebuildTimer = setTimeout(buildMinimap, 80);
      });
      observer.observe(contentHost, { childList: true, subtree: true, characterData: true });

      buildMinimap();
      updateHighlightState();
    })();
  </script>`;

  output = output.replace('</body>', `${highlightScript}\n</body>`);
  return output;
}

/**
 * Exports extracted PDF data to HTML format
 * @param {Object} pdfData - Extracted PDF data
 * @param {string} outputPath - Path for output HTML file
 * @param {string} outputDir - Output directory for saving image files
 */
function exportToHTML(pdfData, outputPath, outputDir, options = {}) {
  try {
    console.log('[ExportHTML] Start:', outputPath);
    console.log('[ExportHTML] Text length:', pdfData.text ? pdfData.text.length : 0);
    console.log('[ExportHTML] Metadata items:', Array.isArray(pdfData.textMetadata) ? pdfData.textMetadata.length : 0);
    const transformedText = applyTextTransformations(pdfData.text, { preserveLineBreakAlignment: true });
    
    // Apply positioning-based super/subscript detection if metadata available
    let textForHTML = transformedText;
    if (pdfData.textMetadata && Array.isArray(pdfData.textMetadata) && pdfData.textMetadata.length > 0) {
      const filteredMetadata = pdfData.textMetadata.filter(item => {
        const value = (item.text || '').trim();
        return value.length > 0 && !/^Page-\d+$/i.test(value);
      });
      const positionBasedMarkup = markupSuperSubscript(filteredMetadata);
      if (positionBasedMarkup && positionBasedMarkup.length > 0) {
        textForHTML = mergeMarkupIntoText(transformedText, positionBasedMarkup);
      }
    }
    
    // Apply pattern-based superscript/subscript markup (before HTML structure is built)
    // This catches things like unit exponents (cm -3), ordinals (1st, 2nd), math notation (x^2), etc.
    textForHTML = applySuperSubscriptMarkup(textForHTML);

    // Apply paragraph/page-break cleanup after super/sub merge to avoid alignment regressions.
    textForHTML = removeNonParagraphLineBreaks(textForHTML, {
      pageBreakAware: true,
      logPageBreakJoins: true,
      logLabel: 'interactive-html'
    });
    
    const lines = textForHTML.split('\n');
    
    // Embedded images extracted from PDF
    const imageReferences = [];
    if (Array.isArray(pdfData.images) && pdfData.images.length > 0) {
      const imagesDir = path.join(outputDir, 'images');
      if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true });
      }

      pdfData.images.forEach((img, index) => {
        const imgFileName = `image_${String(index + 1).padStart(3, '0')}.png`;
        const imgPath = path.join(imagesDir, imgFileName);
        const buffer = Buffer.from(img.data, 'base64');
        fs.writeFileSync(imgPath, buffer);
        imageReferences.push({
          filename: `images/${imgFileName}`,
          page: img.page,
          width: img.width,
          height: img.height,
        });
      });
    }
    
    // Helper function to create anchor ID from text
    function createAnchorId(text) {
      return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }
    
    // Convert text lines to HTML paragraphs and headings, and collect TOC
    const tableOfContents = [];
    const contentHTML = lines.map(line => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        return '';
      }
      
      let htmlLine = '';
      
      // Check if this is a TOC entry first (number + text + dots + page number)
      const tocEntryMatch = trimmed.match(/^(\d+(?:\.\d+)*)\s+([A-Za-z][^\.]+?)\s+\.{2,}\s*(\d+)$/);
      if (tocEntryMatch) {
        const [, number, title, pageNum] = tocEntryMatch;
        const fullText = `${number} ${title}`.trim();
        const anchorId = createAnchorId(fullText);
        htmlLine = `<p><a href="#${anchorId}" class="toc-link">${number} ${title}</a> ${'·'.repeat(3)} ${pageNum}</p>`;
      } else {
        // Detect numbered headings (1, 1.1, 1.2.3, etc.)
        // Stricter detection: must be mostly uppercase and relatively short
        // Main headings: "1 ROCKET PROPELLANTS"
        const mainHeadingPattern = /^(\d+)\s+([A-Z][A-Z\s\.]+)$/;
        const mainHeadingMatch = mainHeadingPattern.test(trimmed);
        // Sub headings: "1.1 AWARENESS SUMMARY" or "1.2 SOLID ROCKET PROPELLANTS"
        const subHeadingPattern = /^(\d+\.\d+)\s+([A-Z][A-Z\s\.]+)$/;
        const subHeadingMatch = subHeadingPattern.test(trimmed);
        // Sub-sub headings: "1.2.1 Grain Shape and Inhibition"
        const subSubHeadingPattern = /^(\d+\.\d+\.\d+)\s+/;
        const subSubHeadingMatch = subSubHeadingPattern.test(trimmed);
        
        // Additional check: line should be reasonably short (< 80 chars) to be a heading
        // and should not contain tags like <sup> or <sub> (which indicate inline content)
        const isReasonableLength = trimmed.length < 80;
        const hasInlineTags = /<su[bp]>/.test(trimmed);
        const likelyHeading = isReasonableLength && !hasInlineTags;
        
        if (mainHeadingMatch && likelyHeading) {
          const anchorId = createAnchorId(trimmed);
          tableOfContents.push({
            level: 2,
            text: trimmed,
            id: anchorId,
          });
          htmlLine = `<h2 id="${anchorId}">${trimmed}</h2>`;
        } else if (subHeadingMatch && likelyHeading) {
          const anchorId = createAnchorId(trimmed);
          tableOfContents.push({
            level: 3,
            text: trimmed,
            id: anchorId,
          });
          htmlLine = `<h3 id="${anchorId}">${trimmed}</h3>`;
        } else if (subSubHeadingMatch && likelyHeading) {
          const anchorId = createAnchorId(trimmed);
          htmlLine = `<h4 id="${anchorId}">${trimmed}</h4>`;
        } else {
          htmlLine = `<p>${trimmed}</p>`;
        }
      }
      
      // Wrap each line in a content-block div
      return `<div class="content-block">${htmlLine}</div>`;
    }).join('\n');

    const contentHTMLWithLists = mergeAdjacentBulletBlocks(
      convertBulletLists(convertNumberParenLists(convertAlphaParenLists(contentHTML)))
    );
    
    // No auto-generated TOC needed - the original PDF TOC is now clickable
    
    // Create images section HTML
    let imagesHTML = '';
    if (imageReferences.length > 0) {
      imagesHTML = `
    <div class="images-section">
      <h2>Embedded Images</h2>
      <div class="image-grid">
${imageReferences.map((img, idx) => `        <div class="image-item">
          <img src="${img.filename}" alt="Embedded image ${idx + 1} from page ${img.page}" />
          <p class="image-caption">Image ${idx + 1} (Page ${img.page})</p>
        </div>`).join('\n')}
      </div>
    </div>`;
    }
    
    const compiledAt = new Date().toISOString();
    const documentKey = path.basename(outputDir);
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PDF Extract - ${pdfData.metadata.title !== 'N/A' ? pdfData.metadata.title : 'Document'}</title>
  <style>
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      line-height: 1.6;
      max-width: 900px;
      margin: 0 auto;
      padding: 20px;
      background-color: #f5f5f5;
    }
    .container {
      background-color: white;
      padding: 40px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .metadata {
      background-color: #f8f9fa;
      padding: 20px;
      border-left: 4px solid #007bff;
      margin-bottom: 30px;
    }
    .metadata h2 {
      margin-top: 0;
      color: #007bff;
    }
    .metadata dl {
      display: grid;
      grid-template-columns: 120px 1fr;
      gap: 10px;
    }
    .metadata dt {
      font-weight: bold;
      color: #555;
    }
    .metadata dd {
      margin: 0;
    }
    .toc {
      background-color: #f0f8ff;
      padding: 20px;
      border-left: 4px solid #28a745;
      margin: 30px 0;
      border-radius: 4px;
    }
    .toc h2 {
      margin-top: 0;
      color: #28a745;
    }
    .toc ul {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .toc li {
      margin: 8px 0;
      padding-left: 20px;
    }
    .toc li:nth-child(n+2) li {
      padding-left: 40px;
    }
    .toc a {
      color: #007bff;
      text-decoration: none;
      transition: color 0.2s;
    }
    .toc a:hover {
      color: #0056b3;
      text-decoration: underline;
    }
    .toc-link {
      color: #007bff;
      text-decoration: none;
      font-weight: 500;
      display: inline-block;
    }
    .toc-link:hover {
      color: #0056b3;
      text-decoration: underline;
    }
    .toc-item {
      margin: 4px 0;
    }
    /* Main section links (1.1, 1.2, 1.3, etc.) */
    a.toc-link[href*="#1-1-"],
    a.toc-link[href*="#1-2-"],
    a.toc-link[href*="#1-3-"],
    a.toc-link[href*="#1-4-"],
    a.toc-link[href*="#1-5-"],
    a.toc-link[href*="#1-6-"],
    a.toc-link[href*="#1-7-"],
    a.toc-link[href*="#1-8-"] {
      font-size: 1.1em;
      font-weight: 600;
      color: #0056b3;
    }
    /* Sub-section links (1.2.1, 1.2.2, 1.3.1, etc.) - check for double dash pattern */
    a.toc-link[href*="-1-"][href*="-1-"],
    a.toc-link[href*="-2-"][href*="-2-"],
    a.toc-link[href*="-3-"][href*="-3-"],
    a.toc-link[href*="-4-"][href*="-4-"],
    a.toc-link[href*="-5-"][href*="-5-"],
    a.toc-link[href*="-6-"][href*="-6-"],
    a.toc-link[href*="-7-"][href*="-7-"],
    a.toc-link[href*="-8-"][href*="-8-"] {
      font-size: 0.95em;
      font-weight: 400;
      color: #007bff;
      margin-left: 20px;
    }
    .content h2 {
      color: #333;
      border-bottom: 2px solid #007bff;
      padding-bottom: 10px;
      margin-top: 30px;
      scroll-margin-top: 20px;
    }
    .content h3 {
      color: #555;
      margin-top: 25px;
      scroll-margin-top: 20px;
    }
    .content h4 {
      color: #666;
      margin-top: 20px;
      margin-left: 20px;
      font-size: 1em;
      scroll-margin-top: 20px;
    }
    .content p {
      text-align: left;
      margin: 15px 0;
      color: #333;
    }
    .images-section {
      margin-top: 40px;
      padding-top: 30px;
      border-top: 2px solid #007bff;
    }
    .images-section h2 {
      color: #007bff;
      margin-bottom: 20px;
    }
    .image-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 20px;
      margin-top: 20px;
    }
    .image-item {
      border: 1px solid #ddd;
      padding: 10px;
      border-radius: 8px;
      background: #f9f9f9;
    }
    .image-item img {
      width: 100%;
      height: auto;
      border-radius: 4px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .image-caption {
      margin-top: 10px;
      text-align: center;
      font-size: 0.9em;
      color: #666;
    }
    .content-block {
      position: relative;
      margin: 15px 0;
      padding: 10px;
      padding-top: 45px;
      padding-right: 180px;
      transition: background-color 0.2s;
      min-height: 80px;
    }
    .content-block.toc-block {
      padding-top: 10px;
    }
    .content-block:hover {
      background-color: #f9f9f9;
    }
    .content-block p,
    .content-block h2,
    .content-block h3,
    .content-block h4 {
      margin: 0;
    }
    .block-buttons {
      position: absolute;
      top: 8px;
      right: 8px;
      display: flex;
      flex-direction: column;
      gap: 3px;
      z-index: 20;
      width: 96px;
    }
    .copy-btn, .edit-btn {
      background-color: #007bff;
      color: white;
      border: none;
      border-radius: 4px;
      padding: 5px 8px;
      font-size: 0.8em;
      cursor: pointer;
      transition: background-color 0.2s;
      white-space: nowrap;
    }
    .copy-btn:hover, .edit-btn:hover {
      background-color: #0056b3;
    }
    .copy-btn.copied {
      background-color: #28a745;
    }
    .edit-btn {
      background-color: #28a745;
    }
    .edit-btn:hover {
      background-color: #218838;
    }
    .copy-html-btn {
      background-color: #6c757d;
    }
    .copy-html-btn:hover {
      background-color: #5a6268;
    }
    .copy-html-btn.copied {
      background-color: #28a745;
    }
    .back-to-top {
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background-color: #007bff;
      color: white;
      border: none;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      cursor: pointer;
      font-size: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s, background-color 0.2s;
      z-index: 999;
    }
    .back-to-top:hover {
      background-color: #0056b3;
      transform: translateY(-2px);
    }
    .back-to-toc {
      position: fixed;
      bottom: 20px;
      right: 72px;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background-color: #6c757d;
      color: white;
      border: none;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      cursor: pointer;
      font-size: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s, background-color 0.2s;
      z-index: 999;
    }
    .back-to-toc:hover {
      background-color: #5a6268;
      transform: translateY(-2px);
    }
    .restore-history {
      position: fixed;
      bottom: 20px;
      right: 124px;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background-color: #7b3fe4;
      color: white;
      border: none;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      cursor: pointer;
      font-size: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s, background-color 0.2s;
      z-index: 999;
    }
    .restore-history:hover {
      background-color: #6730c9;
      transform: translateY(-2px);
    }
    .history-panel {
      position: fixed;
      top: 0;
      right: 0;
      width: 360px;
      max-width: 90vw;
      height: 100vh;
      background: #ffffff;
      border-left: 1px solid #ddd;
      box-shadow: -8px 0 24px rgba(0, 0, 0, 0.18);
      z-index: 1200;
      transform: translateX(100%);
      transition: transform 0.2s ease;
      display: flex;
      flex-direction: column;
    }
    .history-panel.open {
      transform: translateX(0);
    }
    .history-panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 14px;
      border-bottom: 1px solid #eee;
      background: #f8f9fa;
    }
    .history-panel-title {
      margin: 0;
      font-size: 1em;
      color: #333;
    }
    .history-panel-actions {
      display: flex;
      gap: 6px;
    }
    .history-panel-btn {
      border: 1px solid #ccc;
      background: #fff;
      color: #333;
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 0.8em;
      cursor: pointer;
    }
    .history-panel-btn:hover {
      background: #f0f0f0;
    }
    .history-panel-list {
      list-style: none;
      margin: 0;
      padding: 10px;
      overflow-y: auto;
      flex: 1;
    }
    .history-entry {
      border: 1px solid #e5e5e5;
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 8px;
      background: #fafafa;
    }
    .history-entry-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
      gap: 8px;
    }
    .history-entry-version {
      font-weight: 600;
      color: #333;
    }
    .history-entry-meta {
      font-size: 0.8em;
      color: #666;
    }
    .history-entry-reason {
      font-size: 0.85em;
      color: #444;
      margin-bottom: 8px;
    }
    .history-restore-btn {
      border: 1px solid #7b3fe4;
      background: #7b3fe4;
      color: #fff;
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 0.78em;
      cursor: pointer;
      white-space: nowrap;
    }
    .history-restore-btn:hover {
      background: #6730c9;
      border-color: #6730c9;
    }
    .history-undo-merge-btn {
      border: 1px solid #b26f00;
      background: #ff9800;
      color: #fff;
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 0.78em;
      cursor: pointer;
      white-space: nowrap;
      margin-right: 6px;
    }
    .history-undo-merge-btn:hover {
      background: #e68900;
      border-color: #a86800;
    }
    .history-empty {
      color: #666;
      font-size: 0.9em;
      padding: 12px;
    }
    /* Edit Modal Styles */
    .edit-modal {
      display: none;
      position: fixed;
      z-index: 1000;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      overflow: auto;
      background-color: rgba(0, 0, 0, 0.5);
      animation: fadeIn 0.3s;
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .edit-modal.show {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .edit-modal-content {
      background-color: white;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
      width: 90%;
      max-width: 700px;
      animation: slideIn 0.3s;
    }
    @keyframes slideIn {
      from { transform: translateY(-50px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    .edit-modal-header {
      font-size: 1.3em;
      font-weight: bold;
      margin-bottom: 20px;
      color: #333;
    }
    .edit-modal-editor {
      width: 100%;
      min-height: 200px;
      padding: 12px;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      font-size: 1em;
      border: 2px solid #ddd;
      border-radius: 4px;
      margin-bottom: 15px;
      overflow-y: auto;
      background: #fff;
    }
    .edit-modal-editor:focus {
      outline: none;
      border-color: #007bff;
      box-shadow: 0 0 5px rgba(0, 123, 255, 0.3);
    }
    .edit-modal-char-count {
         .format-toolbar {
           display: flex;
           gap: 5px;
           margin-bottom: 15px;
           padding: 10px;
           background-color: #f8f9fa;
           border-radius: 4px;
           border: 1px solid #ddd;
           flex-wrap: wrap;
         }
         .format-btn {
           background-color: #e9ecef;
           color: #333;
           border: 1px solid #dee2e6;
           border-radius: 4px;
           padding: 6px 10px;
           font-size: 0.85em;
           cursor: pointer;
           transition: all 0.2s;
           font-weight: bold;
           min-width: 40px;
         }
         .format-btn:hover {
           background-color: #dee2e6;
           border-color: #007bff;
         }
         .format-btn.active {
           background-color: #007bff;
           color: white;
           border-color: #007bff;
         }
         .edit-modal-char-count {
      font-size: 0.85em;
      color: #666;
      margin-bottom: 15px;
    }
    .edit-modal-buttons {
      display: flex;
      gap: 10px;
      justify-content: flex-end;
    }
    .edit-modal-btn {
      padding: 10px 20px;
      border: none;
      border-radius: 4px;
      font-size: 1em;
      cursor: pointer;
      transition: background-color 0.2s;
    }
    .edit-modal-save {
      background-color: #28a745;
      color: white;
    }
    .edit-modal-save:hover {
      background-color: #218838;
    }
    .edit-modal-cancel {
      background-color: #6c757d;
      color: white;
    }
    .edit-modal-cancel:hover {
      background-color: #5a6268;
    }
    .edit-modal-reset {
      background-color: #dc3545;
      color: white;
      margin-right: auto;
    }
    .edit-modal-reset:hover {
      background-color: #c82333;
    }
    .content-block.editable {
      cursor: pointer;
      position: relative;
    }
    .content-block.editable {
      padding-right: 180px;
    }
    .content-block.editable:hover {
      background-color: #e8f4f8 !important;
    }
    .content-block.editable.merge-inactive {
      cursor: default !important;
    }
    .content-block.editable.merge-inactive:hover {
      background-color: transparent !important;
    }
    .content-block.merge-source {
      background-color: #fff3cd !important;
      border: 2px solid #ffc107 !important;
      border-radius: 4px;
    }
    .merge-btn {
      background-color: #ff9800 !important;
    }
    .merge-btn:hover:not(:disabled):not(.disabled) {
      background-color: #e68900 !important;
    }
    .merge-btn.active {
      background-color: #ffc107 !important;
      color: #333 !important;
    }
    .merge-btn:disabled {
      background-color: #c7c7c7 !important;
      border-color: #c7c7c7 !important;
      color: #666 !important;
      cursor: default !important;
      opacity: 0.65 !important;
      pointer-events: auto;
      transition: none !important;
    }
    .merge-btn.disabled {
      background-color: #ccc !important;
      border-color: #ccc !important;
      color: #666 !important;
      cursor: default !important;
      opacity: 0.6;
      pointer-events: auto;
      transition: none !important;
    }
    .merge-btn:disabled:hover,
    .merge-btn.disabled:hover {
      background-color: #c7c7c7 !important;
      border-color: #c7c7c7 !important;
      color: #666 !important;
      cursor: default !important;
    }
    .copy-btn.merge-btn.disabled,
    .copy-btn.merge-btn.disabled:hover,
    .copy-btn.merge-btn:disabled,
    .copy-btn.merge-btn:disabled:hover {
      background-color: #c7c7c7 !important;
      border-color: #c7c7c7 !important;
      color: #666 !important;
      cursor: default !important;
      box-shadow: none !important;
      transform: none !important;
      transition: none !important;
    }
  </style>
</head>
<body>
  <div id="compiled-at" style="display: none;">Compiled at: ${compiledAt}</div>
  <div class="container">
    <h1>PDF Extraction Report</h1>
    
    <div class="metadata">
      <h2>Document Metadata</h2>
      <dl>
        <dt>Pages:</dt>
        <dd>${pdfData.metadata.pages}</dd>
        <dt>Title:</dt>
        <dd>${pdfData.metadata.title}</dd>
        <dt>Author:</dt>
        <dd>${pdfData.metadata.author}</dd>
        <dt>Subject:</dt>
        <dd>${pdfData.metadata.subject}</dd>
        <dt>Creator:</dt>
        <dd>${pdfData.metadata.creator}</dd>${imageReferences.length > 0 ? `
        <dt>Embedded Images:</dt>
        <dd>${imageReferences.length} extracted</dd>` : ''}
      </dl>
    </div>
    
    <div class="content">
${contentHTMLWithLists}
    </div>
${imagesHTML}
  </div>

  <button class="back-to-toc" id="backToToc" title="Return to links">☰</button>
  <button class="restore-history" id="restoreHistory" title="Restore from history">↶</button>
  <button class="back-to-top" id="backToTop" title="Return to top">↑</button>

  <aside id="historyPanel" class="history-panel" aria-hidden="true">
    <div class="history-panel-header">
      <h2 class="history-panel-title">History</h2>
      <div class="history-panel-actions">
        <button type="button" id="historyRefresh" class="history-panel-btn">Refresh</button>
        <button type="button" id="historyClose" class="history-panel-btn">Close</button>
      </div>
    </div>
    <ul id="historyList" class="history-panel-list"></ul>
  </aside>

  <!-- Edit Modal -->
  <div id="editModal" class="edit-modal">
    <div class="edit-modal-content">
      <div class="edit-modal-header">Edit Text Block</div>
      <div id="editEditor" class="edit-modal-editor" contenteditable="true" spellcheck="true"></div>
          <div class="format-toolbar">
            <button type="button" class="format-btn" id="boldBtn" title="Bold (Ctrl+B)"><b>B</b></button>
            <button type="button" class="format-btn" id="italicBtn" title="Italic (Ctrl+I)"><i>I</i></button>
            <button type="button" class="format-btn" id="underlineBtn" title="Underline (Ctrl+U)"><u>U</u></button>
            <button type="button" class="format-btn" id="superBtn" title="Superscript">x<sup>²</sup></button>
            <button type="button" class="format-btn" id="subBtn" title="Subscript">x<sub>2</sub></button>
            <button type="button" class="format-btn" id="clearBtn" title="Clear Formatting">Clear</button>
          </div>
      <div class="edit-modal-char-count"><span id="charCount">0</span> characters</div>
      <div class="edit-modal-buttons">
        <button class="edit-modal-btn edit-modal-reset" id="resetBtn">Reset to Original</button>
        <button class="edit-modal-btn edit-modal-cancel" id="cancelBtn">Cancel</button>
        <button class="edit-modal-btn edit-modal-save" id="saveBtn">Save Changes</button>
      </div>
    </div>
  </div>

  <script>
    const DOCUMENT_KEY = ${JSON.stringify(documentKey)};
    // Storage key for edits - unique per document based on title
    const STORAGE_KEY = 'pdf-text-edits-' + document.title.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const MERGE_KEY = 'pdf-block-merges-' + document.title.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    let persistedVersion = 0;
    let saveQueue = Promise.resolve();
    let currentEditingBlock = null;
    let currentBlockOriginalText = null;
    let lastSelectionStart = 0;
    let lastSelectionEnd = 0;
    let mergeSourceBlock = null;
    let mergeSourceIndex = null;

    function getEditableBlocksArray() {
      return Array.from(document.querySelectorAll('.content-block.editable'));
    }

    function getAdjacentEditableBlocks(sourceBlock) {
      const editableBlocks = getEditableBlocksArray();
      const sourceIdx = editableBlocks.indexOf(sourceBlock);
      if (sourceIdx < 0) return [];

      const adjacent = [];
      if (sourceIdx > 0) adjacent.push(editableBlocks[sourceIdx - 1]);
      if (sourceIdx < editableBlocks.length - 1) adjacent.push(editableBlocks[sourceIdx + 1]);
      return adjacent;
    }

    function getPrimaryContentElement(block) {
      return block.querySelector('p, h2, h3, h4');
    }
    
    // Update merge button availability for adjacent blocks only
    function updateMergeButtonStates() {
      const blocks = getEditableBlocksArray();
      
      // Reset all to enabled
      blocks.forEach(block => {
        const btn = block.querySelector('.merge-btn');
        block.classList.remove('merge-inactive');
        if (btn) {
          btn.classList.remove('disabled');
          btn.disabled = false;
          btn.style.opacity = '';
          btn.style.backgroundColor = '';
          btn.style.borderColor = '';
          btn.style.color = '';
          btn.style.cursor = '';
          btn.style.transform = '';
          btn.style.boxShadow = '';
          btn.style.transition = '';
        }
      });
      
      // If a source is selected, disable all except adjacent blocks
      if (mergeSourceBlock !== null) {
        const allowedBlocks = new Set([mergeSourceBlock, ...getAdjacentEditableBlocks(mergeSourceBlock)]);
        blocks.forEach(block => {
          const btn = block.querySelector('.merge-btn');
          if (!btn) return;
          if (!allowedBlocks.has(block)) {
            block.classList.add('merge-inactive');
            btn.classList.add('disabled');
            btn.disabled = true;
            btn.style.opacity = '0.6';
            btn.style.backgroundColor = '#c7c7c7';
            btn.style.borderColor = '#c7c7c7';
            btn.style.color = '#666';
            btn.style.cursor = 'default';
            btn.style.transform = 'none';
            btn.style.boxShadow = 'none';
            btn.style.transition = 'none';
          }
        });
      }
    }
    
    function buildDocumentStateFromDom() {
      const edits = {};
      const editableBlocks = document.querySelectorAll('.content-block.editable');
      editableBlocks.forEach((block, index) => {
        const contentEl = getPrimaryContentElement(block);
        if (!contentEl) return;
        const content = contentEl.innerHTML.trim();
        if (content) {
          edits[index] = content;
        }
      });

      const merges = JSON.parse(localStorage.getItem(MERGE_KEY) || '[]');
      return { edits, merges };
    }

    async function persistState(reason) {
      const state = buildDocumentStateFromDom();
      const response = await fetch('/api/document-state/' + encodeURIComponent(DOCUMENT_KEY), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: persistedVersion,
          reason: reason || 'save',
          state,
        }),
      });

      const data = await response.json();
      if (response.status === 409 && data.state) {
        persistedVersion = data.state.version || 0;
        throw new Error('Version conflict while saving edits');
      }
      if (!response.ok || !data.success) {
        throw new Error((data && data.error) || 'Failed to persist state');
      }

      persistedVersion = data.state.version || persistedVersion;
      return data.state;
    }

    function queuePersistState(reason) {
      saveQueue = saveQueue
        .then(() => persistState(reason))
        .catch(err => {
          console.error('Persist state failed:', err);
        });
      return saveQueue;
    }

    async function fetchHistoryEntries() {
      const historyRes = await fetch('/api/document-history/' + encodeURIComponent(DOCUMENT_KEY));
      const historyData = await historyRes.json();
      if (!historyRes.ok || !historyData.success) {
        throw new Error((historyData && historyData.error) || 'Failed to load history');
      }
      return Array.isArray(historyData.history) ? historyData.history : [];
    }

    async function restoreVersion(targetVersion) {
      const restoreRes = await fetch('/api/document-state/' + encodeURIComponent(DOCUMENT_KEY) + '/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: targetVersion }),
      });
      const restoreData = await restoreRes.json();

      if (!restoreRes.ok || !restoreData.success || !restoreData.state) {
        throw new Error((restoreData && restoreData.error) || 'Restore failed');
      }

      persistedVersion = restoreData.state.version || persistedVersion;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(restoreData.state.edits || {}));
      localStorage.setItem(MERGE_KEY, JSON.stringify(restoreData.state.merges || []));
      return restoreData.state;
    }

    function closeHistoryPanel() {
      const panel = document.getElementById('historyPanel');
      if (panel) {
        panel.classList.remove('open');
        panel.setAttribute('aria-hidden', 'true');
      }
    }

    async function renderHistoryPanel() {
      const list = document.getElementById('historyList');
      if (!list) return;
      list.innerHTML = '<li class="history-empty">Loading history...</li>';

      try {
        const history = await fetchHistoryEntries();
        list.innerHTML = '';

        if (history.length === 0) {
          list.innerHTML = '<li class="history-empty">No history entries yet.</li>';
        } else {
          history.forEach(entry => {
            const li = document.createElement('li');
            li.className = 'history-entry';

            const top = document.createElement('div');
            top.className = 'history-entry-top';

            const version = document.createElement('span');
            version.className = 'history-entry-version';
            version.textContent = 'Version ' + entry.version;

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'history-restore-btn';
            btn.textContent = 'Restore';

            const isMergeEntry = (entry.reason || '').toLowerCase() === 'merge';
            if (isMergeEntry && Number.isInteger(entry.version) && entry.version > 0) {
              const undoBtn = document.createElement('button');
              undoBtn.type = 'button';
              undoBtn.className = 'history-undo-merge-btn';
              undoBtn.textContent = 'Undo Merge';
              undoBtn.addEventListener('click', async function() {
                const targetVersion = entry.version - 1;
                if (!confirm('Undo this merge by restoring to version ' + targetVersion + '?')) return;
                try {
                  undoBtn.disabled = true;
                  btn.disabled = true;
                  await restoreVersion(targetVersion);
                  alert('Merge undone. Reloading page.');
                  window.location.reload();
                } catch (err) {
                  alert('Undo merge failed: ' + err.message);
                } finally {
                  undoBtn.disabled = false;
                  btn.disabled = false;
                }
              });
              top.appendChild(undoBtn);
            }

            btn.addEventListener('click', async function() {
              if (!confirm('Restore to version ' + entry.version + '?')) return;
              try {
                btn.disabled = true;
                await restoreVersion(entry.version);
                alert('Restored to version ' + entry.version + '. Reloading page.');
                window.location.reload();
              } catch (err) {
                alert('Restore failed: ' + err.message);
              } finally {
                btn.disabled = false;
              }
            });

            top.appendChild(version);
            top.appendChild(btn);

            const reason = document.createElement('div');
            reason.className = 'history-entry-reason';
            reason.textContent = entry.reason || 'save';

            const meta = document.createElement('div');
            meta.className = 'history-entry-meta';
            const stamp = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : 'unknown time';
            meta.textContent = stamp + ' • edits: ' + (entry.editsCount || 0) + ' • merges: ' + (entry.mergeCount || 0);

            li.appendChild(top);
            li.appendChild(reason);
            li.appendChild(meta);
            list.appendChild(li);
          });
        }

        const originalItem = document.createElement('li');
        originalItem.className = 'history-entry';

        const originalTop = document.createElement('div');
        originalTop.className = 'history-entry-top';

        const originalVersion = document.createElement('span');
        originalVersion.className = 'history-entry-version';
        originalVersion.textContent = 'Original state';

        const originalBtn = document.createElement('button');
        originalBtn.type = 'button';
        originalBtn.className = 'history-restore-btn';
        originalBtn.textContent = 'Restore';
        originalBtn.addEventListener('click', async function() {
          if (!confirm('Restore to the original unedited state?')) return;
          try {
            originalBtn.disabled = true;
            await restoreVersion(0);
            alert('Restored to original state. Reloading page.');
            window.location.reload();
          } catch (err) {
            alert('Restore failed: ' + err.message);
          } finally {
            originalBtn.disabled = false;
          }
        });

        originalTop.appendChild(originalVersion);
        originalTop.appendChild(originalBtn);

        const originalReason = document.createElement('div');
        originalReason.className = 'history-entry-reason';
        originalReason.textContent = 'Base output (no edits or merges)';

        const originalMeta = document.createElement('div');
        originalMeta.className = 'history-entry-meta';
        originalMeta.textContent = 'Version 0 • edits: 0 • merges: 0';

        originalItem.appendChild(originalTop);
        originalItem.appendChild(originalReason);
        originalItem.appendChild(originalMeta);
        list.appendChild(originalItem);
      } catch (err) {
        list.innerHTML = '<li class="history-empty">Failed to load history: ' + err.message + '</li>';
      }
    }

    async function restoreFromHistory() {
      const panel = document.getElementById('historyPanel');
      if (!panel) return;
      panel.classList.add('open');
      panel.setAttribute('aria-hidden', 'false');
      await renderHistoryPanel();
    }
    
    // Reconstruct merged blocks from storage
    function reconstructMergedBlocks(mergeOps) {
      const merges = Array.isArray(mergeOps) ? mergeOps : JSON.parse(localStorage.getItem(MERGE_KEY) || '[]');
      if (merges.length === 0) return;

      merges.forEach(merge => {
        const [sourceIdx, targetIdx] = merge;
        const blocks = document.querySelectorAll('.content-block');
        if (sourceIdx < blocks.length && targetIdx < blocks.length) {
          const sourceBlock = blocks[sourceIdx];
          const targetBlock = blocks[targetIdx];
          const sourcePara = getPrimaryContentElement(sourceBlock);
          const targetPara = getPrimaryContentElement(targetBlock);
          
          if (sourcePara && targetPara) {
            targetPara.innerHTML += ' ' + sourcePara.innerHTML;
            sourceBlock.remove();
          }
        }
      });
    }
    
    // Load edits from persisted state (server-backed with local fallback)
    async function loadEdits() {
      let edits = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      let merges = JSON.parse(localStorage.getItem(MERGE_KEY) || '[]');

      try {
        const response = await fetch('/api/document-state/' + encodeURIComponent(DOCUMENT_KEY));
        const data = await response.json();
        if (response.ok && data.success && data.state) {
          persistedVersion = data.state.version || 0;
          edits = (data.state.edits && typeof data.state.edits === 'object') ? data.state.edits : {};
          merges = Array.isArray(data.state.merges) ? data.state.merges : [];
          localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
          localStorage.setItem(MERGE_KEY, JSON.stringify(merges));
        }
      } catch (err) {
        console.warn('Could not load persisted state; using local cache:', err);
      }

      reconstructMergedBlocks(merges);
      const blocks = document.querySelectorAll('.content-block');
      let editableIndex = 0;
      blocks.forEach(block => {
        if (block.querySelector('.toc-link')) {
          return;
        }
        const contentEl = getPrimaryContentElement(block);
        if (contentEl && edits[editableIndex]) {
          contentEl.innerHTML = edits[editableIndex];
        }
        editableIndex += 1;
      });
    }
    
    // Save edits to localStorage and persisted sidecar state
    function saveEditsToStorage(reason = 'edit') {
      const edits = {};
      const blocks = document.querySelectorAll('.content-block.editable');
      blocks.forEach((block, index) => {
        const contentEl = getPrimaryContentElement(block);
        if (!contentEl) return;
        const text = contentEl.innerHTML.trim();
        if (text) {
          edits[index] = text;
        }
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(edits));
      queuePersistState(reason);
    }

    // Apply formatting to selected text in textarea
    function applyFormatting(tag) {
      const editor = document.getElementById('editEditor');
      editor.focus();

      if (tag === 'clear') {
        document.execCommand('removeFormat');
        return;
      }

      const commandMap = {
        b: 'bold',
        i: 'italic',
        u: 'underline',
        sup: 'superscript',
        sub: 'subscript',
      };

      const cmd = commandMap[tag];
      if (cmd) {
        document.execCommand(cmd, false, null);
      }
    }
    
    // Open edit modal for a block
    function openEditModal(block) {
      const para = getPrimaryContentElement(block);
      if (!para) return;
      
      currentEditingBlock = block;
      currentBlockOriginalText = para.innerHTML;
      
      const modal = document.getElementById('editModal');
      const editor = document.getElementById('editEditor');
      const charCount = document.getElementById('charCount');
      
      editor.innerHTML = currentBlockOriginalText;
      charCount.textContent = editor.textContent.length;
      
      modal.classList.add('show');
      editor.focus();
    }
    
    // Close edit modal
    function closeEditModal() {
      const modal = document.getElementById('editModal');
      modal.classList.remove('show');
      currentEditingBlock = null;
      currentBlockOriginalText = null;
    }
    
    document.addEventListener('DOMContentLoaded', async function() {
      document.querySelectorAll('.content p').forEach(p => {
        if (p.querySelector('.toc-link')) {
          p.classList.add('toc-item');
        }
      });

      const backToToc = document.getElementById('backToToc');
      if (backToToc) {
        backToToc.addEventListener('click', function() {
          const firstTocLink = document.querySelector('.toc-link');
          if (firstTocLink) {
            firstTocLink.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } else {
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }
        });
      }
      const backToTop = document.getElementById('backToTop');
      if (backToTop) {
        backToTop.addEventListener('click', function() {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        });
      }
      const restoreHistory = document.getElementById('restoreHistory');
      if (restoreHistory) {
        restoreHistory.addEventListener('click', function() {
          restoreFromHistory();
        });
      }
      const historyClose = document.getElementById('historyClose');
      if (historyClose) {
        historyClose.addEventListener('click', function() {
          closeHistoryPanel();
        });
      }
      const historyRefresh = document.getElementById('historyRefresh');
      if (historyRefresh) {
        historyRefresh.addEventListener('click', function() {
          renderHistoryPanel();
        });
      }
      document.addEventListener('click', function(e) {
        const panel = document.getElementById('historyPanel');
        const trigger = document.getElementById('restoreHistory');
        if (!panel || !panel.classList.contains('open')) return;
        if (panel.contains(e.target)) return;
        if (trigger && (trigger === e.target || trigger.contains(e.target))) return;
        closeHistoryPanel();
      });

      // Load any saved edits
      await loadEdits();

      function sanitizeHtmlForCopy(rawHtml) {
        const container = document.createElement('div');
        container.innerHTML = rawHtml;

        container.querySelectorAll('sup, sub').forEach(el => {
          const keptClasses = Array.from(el.classList).filter(className => !/^hl-/.test(className));
          if (keptClasses.length > 0) {
            el.className = keptClasses.join(' ');
          } else {
            el.removeAttribute('class');
          }

          if (el.hasAttribute('style')) {
            const keptRules = el
              .getAttribute('style')
              .split(';')
              .map(rule => rule.trim())
              .filter(Boolean)
              .filter(rule => {
                const prop = rule.split(':')[0].trim().toLowerCase();
                return prop !== 'background-color' && prop !== 'border-radius' && prop !== 'padding';
              });

            if (keptRules.length > 0) {
              el.setAttribute('style', keptRules.join('; ') + ';');
            } else {
              el.removeAttribute('style');
            }
          }
        });

        return container.innerHTML.trim();
      }
      
      // Add copy and edit buttons to all content blocks
      const blocks = document.querySelectorAll('.content-block');
      blocks.forEach((block, index) => {
        if (block.querySelector('.toc-link')) {
          block.classList.add('toc-block');
          return;
        }
        block.classList.add('editable');
        
        // Create button container
        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'block-buttons';
        
        // Add copy button
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          const text = block.textContent.trim();
          navigator.clipboard.writeText(text).then(() => {
            copyBtn.textContent = 'Copied!';
            copyBtn.classList.add('copied');
            setTimeout(() => {
              copyBtn.textContent = 'Copy';
              copyBtn.classList.remove('copied');
            }, 2000);
          }).catch(err => {
            console.error('Failed to copy:', err);
            copyBtn.textContent = 'Error';
          });
        });
        buttonContainer.appendChild(copyBtn);
        
        // Add copy HTML button
        const copyHtmlBtn = document.createElement('button');
        copyHtmlBtn.className = 'copy-btn copy-html-btn';
        copyHtmlBtn.textContent = 'Copy HTML';
        copyHtmlBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          const para = block.querySelector('p');
          const html = para ? para.innerHTML.trim() : block.innerHTML.trim();
          const cleanedHtml = sanitizeHtmlForCopy(html);
          navigator.clipboard.writeText(cleanedHtml).then(() => {
            copyHtmlBtn.textContent = 'Copied!';
            copyHtmlBtn.classList.add('copied');
            setTimeout(() => {
              copyHtmlBtn.textContent = 'Copy HTML';
              copyHtmlBtn.classList.remove('copied');
            }, 2000);
          }).catch(err => {
            console.error('Failed to copy:', err);
            copyHtmlBtn.textContent = 'Error';
          });
        });
        buttonContainer.appendChild(copyHtmlBtn);
        
        // Add edit button
        const editBtn = document.createElement('button');
        editBtn.className = 'edit-btn';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          openEditModal(block);
        });
        buttonContainer.appendChild(editBtn);
        
        // Add merge button
        const mergeBtn = document.createElement('button');
        mergeBtn.className = 'copy-btn merge-btn';
        mergeBtn.textContent = 'Merge';
        mergeBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          
          // Prevent clicking disabled merge buttons
          if (mergeBtn.disabled) return;
          
          // If no source block selected, make this one the source
          if (mergeSourceBlock === null) {
            mergeSourceBlock = block;
            mergeSourceIndex = index;
            block.classList.add('merge-source');
            mergeBtn.classList.add('active');
            mergeBtn.textContent = 'Merge with...';
            updateMergeButtonStates();
          } else if (mergeSourceBlock === block) {
            // Clicking same block again - cancel merge
            block.classList.remove('merge-source');
            mergeBtn.classList.remove('active');
            mergeBtn.textContent = 'Merge';
            mergeSourceBlock = null;
            mergeSourceIndex = null;
            updateMergeButtonStates();
          } else {
            const adjacentBlocks = getAdjacentEditableBlocks(mergeSourceBlock);
            if (!adjacentBlocks.includes(block)) return;

            // Merge selected block with source block
            const sourceContent = getPrimaryContentElement(mergeSourceBlock);
            const targetContent = getPrimaryContentElement(block);
            if (sourceContent && targetContent) {
              targetContent.innerHTML += ' ' + sourceContent.innerHTML;
              const oldMergeSourceBtn = mergeSourceBlock.querySelector('.merge-btn');
              mergeSourceBlock.classList.remove('merge-source');
              if (oldMergeSourceBtn) oldMergeSourceBtn.classList.remove('active');
              if (oldMergeSourceBtn) oldMergeSourceBtn.textContent = 'Merge';
              
              // Store merge operation
              const merges = JSON.parse(localStorage.getItem(MERGE_KEY) || '[]');
              const allBlocks = Array.from(document.querySelectorAll('.content-block'));
              const sourceDomIndex = allBlocks.indexOf(mergeSourceBlock);
              const targetDomIndex = allBlocks.indexOf(block);
              if (sourceDomIndex >= 0 && targetDomIndex >= 0) {
                merges.push([sourceDomIndex, targetDomIndex]);
              }
              localStorage.setItem(MERGE_KEY, JSON.stringify(merges));
              
              // Remove source block
              mergeSourceBlock.remove();
              
              // Update edits storage (re-index after removal)
              saveEditsToStorage('merge');
              
              // Reset merge state
              mergeSourceBlock = null;
              mergeSourceIndex = null;
              mergeBtn.classList.remove('active');
              mergeBtn.textContent = 'Merge';
              updateMergeButtonStates();
            }
          }
        });
        buttonContainer.appendChild(mergeBtn);
        
        block.appendChild(buttonContainer);
      });
      
      // Modal event listeners
      const modal = document.getElementById('editModal');
      const editor = document.getElementById('editEditor');
      const charCount = document.getElementById('charCount');
      const saveBtn = document.getElementById('saveBtn');
      const cancelBtn = document.getElementById('cancelBtn');
      const resetBtn = document.getElementById('resetBtn');
      
      // Track selection in textarea
      // Update character count
      const updateCharCount = () => {
        charCount.textContent = editor.textContent.length;
      };
      editor.addEventListener('input', updateCharCount);
      editor.addEventListener('keyup', updateCharCount);
      editor.addEventListener('mouseup', updateCharCount);
      editor.addEventListener('focus', updateCharCount);
      
      // Save changes
      saveBtn.addEventListener('click', function() {
        if (currentEditingBlock) {
          const para = getPrimaryContentElement(currentEditingBlock);
          if (para) {
            para.innerHTML = editor.innerHTML;
            saveEditsToStorage('edit');
          }
        }
        closeEditModal();
      });
      
      // Cancel
      cancelBtn.addEventListener('click', function() {
        closeEditModal();
      });
      
      // Reset to original
      resetBtn.addEventListener('click', function() {
        editor.innerHTML = currentBlockOriginalText;
        charCount.textContent = editor.textContent.length;
        editor.focus();
      });
      
      // Format button event listeners
      document.getElementById('boldBtn').addEventListener('click', (e) => {
        e.preventDefault();
        applyFormatting('b');
      });
      document.getElementById('italicBtn').addEventListener('click', (e) => {
        e.preventDefault();
        applyFormatting('i');
      });
      document.getElementById('underlineBtn').addEventListener('click', (e) => {
        e.preventDefault();
        applyFormatting('u');
      });
      document.getElementById('superBtn').addEventListener('click', (e) => {
        e.preventDefault();
        applyFormatting('sup');
      });
      document.getElementById('subBtn').addEventListener('click', (e) => {
        e.preventDefault();
        applyFormatting('sub');
      });
      document.getElementById('clearBtn').addEventListener('click', (e) => {
        e.preventDefault();
        applyFormatting('clear');
      });
      
      // Keyboard shortcuts
      document.addEventListener('keydown', function(e) {
        if (e.ctrlKey || e.metaKey) {
          if (e.key === 'b' || e.key === 'B') {
            e.preventDefault();
            applyFormatting('b');
          } else if (e.key === 'i' || e.key === 'I') {
            e.preventDefault();
            applyFormatting('i');
          } else if (e.key === 'u' || e.key === 'U') {
            e.preventDefault();
            applyFormatting('u');
          }
        }
      });
      
      // Close modal when clicking outside
      modal.addEventListener('click', function(e) {
        if (e.target === modal) {
          closeEditModal();
        }
      });
      
      // Close modal with Escape key
      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
          closeEditModal();
        }
      });
    });
  </script>
</body>
</html>`;
    
    const includeHighlightOverlay = options.includeHighlightOverlay !== false;
    const finalHtml = includeHighlightOverlay ? applyHighlightOverlayFeatures(html, { readOnly: false, minimapDefaultVisible: false }) : html;

    fs.writeFileSync(outputPath, finalHtml);
    console.log(`✓ HTML file saved to: ${outputPath}`);
    return true;
  } catch (error) {
    console.error(`✗ Error saving HTML: ${error.message}`);
    return false;
  }
}

/**
 * Exports extracted PDF data to highlighted HTML format.
 * Starts from the interactive HTML output, then removes visible controls
 * and highlights all superscript/subscript content.
 * @param {Object} pdfData - Extracted PDF data
 * @param {string} outputPath - Path for output highlighted HTML file
 * @param {string} outputDir - Output directory for saving image files
 */
function exportToHighlightedHTML(pdfData, outputPath, outputDir) {
  try {
    const generated = exportToHTML(pdfData, outputPath, outputDir, { includeHighlightOverlay: false });
    if (!generated) {
      return false;
    }

    let html = fs.readFileSync(outputPath, 'utf8');
    html = applyHighlightOverlayFeatures(html, { readOnly: true });

    fs.writeFileSync(outputPath, html);
    console.log(`✓ Highlighted HTML file saved to: ${outputPath}`);
    return true;
  } catch (error) {
    console.error(`✗ Error saving highlighted HTML: ${error.message}`);
    return false;
  }
}

/**
 * Exports extracted PDF data to CSV format (simple key-value)
 * @param {Object} pdfData - Extracted PDF data
 * @param {string} outputPath - Path for output CSV file
 */
function exportToCSV(pdfData, outputPath) {
  try {
    let csv = 'Field,Value\n';
    csv += `Pages,${pdfData.metadata.pages}\n`;
    csv += `Title,"${pdfData.metadata.title}"\n`;
    csv += `Author,"${pdfData.metadata.author}"\n`;
    csv += `Subject,"${pdfData.metadata.subject}"\n`;
    fs.writeFileSync(outputPath, csv);
    console.log(`✓ CSV file saved to: ${outputPath}`);
    return true;
  } catch (error) {
    console.error(`✗ Error saving CSV: ${error.message}`);
    return false;
  }
}

/**
 * Generates a UUID-like random ID
 * @returns {string} Random UUID in format xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 */
function generateUUID() {
  return 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'.replace(/x/g, () => {
    return Math.floor(Math.random() * 16).toString(16);
  });
}

/**
 * Extracts first N sub-sections from the edited text
 * @param {string} text - Full edited text content
 * @param {number} count - Number of sub-sections to extract (default 8)
 * @returns {Array} Array of sub-section texts
 */
function extractSubSections(text, count = 8) {
  const sections = [];
  const lines = text.split('\n');
  let currentSection = '';
  let sectionCount = 0;

  for (let i = 0; i < lines.length && sectionCount < count; i++) {
    const line = lines[i].trim();
    
    // Check if this is a sub-section heading (1.x format)
    const subSectionMatch = line.match(/^1\.\d+\s+/);
    
    if (subSectionMatch && currentSection) {
      // We found a new sub-section, save the previous one
      sections.push(currentSection.trim());
      currentSection = line;
      sectionCount++;
    } else if (subSectionMatch && !currentSection) {
      // Starting the first sub-section
      currentSection = line;
      sectionCount++;
    } else if (currentSection) {
      // Add to current section
      currentSection += '\n' + line;
    }
  }
  
  // Don't forget the last section
  if (currentSection && sectionCount <= count) {
    sections.push(currentSection.trim());
  }

  return sections.slice(0, count);
}

/**
 * Exports extracted PDF data to H5P content.json format
 * @param {Object} pdfData - Extracted PDF data
 * @param {string} outputPath - Path for output H5P JSON file
 */
function exportToH5P(pdfData, outputPath) {
  try {
    // Extract first 8 sub-sections from edited text
    const subSections = extractSubSections(pdfData.text, 8);

    // Build chapters array
    const chapters = subSections.map((sectionText, index) => {
      // Escape HTML special characters
      const escapedText = sectionText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

      return {
        params: {
          content: [
            {
              content: {
                params: {
                  text: `<p>${escapedText.replace(/\n/g, '<br>')}<\/p>`,
                },
                library: 'H5P.AdvancedText 1.1',
                metadata: {
                  contentType: 'Text',
                  license: 'U',
                  title: 'Section Content',
                },
                subContentId: generateUUID(),
              },
              useSeparator: 'auto',
            },
          ],
        },
        library: 'H5P.Column 1.18',
        subContentId: generateUUID(),
        metadata: {
          contentType: 'Page',
          license: 'U',
          title: `Page ${index + 1}`,
        },
      };
    });

    // Build complete H5P content structure
    const h5pContent = {
      showCoverPage: false,
      bookCover: {
        coverDescription: '<p style="text-align: center;"></p>',
      },
      chapters: chapters,
      behaviour: {
        baseColor: '#1768c4',
        defaultTableOfContents: true,
        progressIndicators: true,
        progressAuto: true,
        displaySummary: true,
        enableRetry: true,
      },
      read: 'Read',
      displayTOC: "Display &#039;Table of contents&#039;",
      hideTOC: "Hide &#039;Table of contents&#039;",
      nextPage: 'Next page',
      previousPage: 'Previous page',
      chapterCompleted: 'Page completed!',
      partCompleted: '@pages of @total completed',
      incompleteChapter: 'Incomplete page',
      navigateToTop: 'Navigate to the top',
      markAsFinished: 'I have finished this page',
      fullscreen: 'Fullscreen',
      exitFullscreen: 'Exit fullscreen',
      bookProgressSubtext: '@count of @total pages',
      interactionsProgressSubtext: '@count of @total interactions',
      submitReport: 'Submit Report',
      restartLabel: 'Restart',
      summaryHeader: 'Summary',
      allInteractions: 'All interactions',
      unansweredInteractions: 'Unanswered interactions',
      scoreText: '@score \/ @maxscore',
      leftOutOfTotalCompleted: '@left of @max interactions completed',
      noInteractions: 'No interactions',
      score: 'Score',
      summaryAndSubmit: 'Summary &amp; submit',
      noChapterInteractionBoldText: 'You have not interacted with any pages.',
      noChapterInteractionText: 'You have to interact with at least one page before you can see the summary.',
      yourAnswersAreSubmittedForReview: 'Your answers are submitted for review!',
      bookProgress: 'Book progress',
      interactionsProgress: 'Interactions progress',
      totalScoreLabel: 'Total score',
      a11y: {
        progress: 'Page @page of @total.',
        menu: 'Toggle navigation menu',
      },
    };

    fs.writeFileSync(outputPath, JSON.stringify(h5pContent, null, 2));
    console.log(`✓ H5P content file saved to: ${outputPath}`);
    return true;
  } catch (error) {
    console.error(`✗ Error saving H5P content: ${error.message}`);
    return false;
  }
}

/**
 * Exports extracted PDF data to Canvas HTML format (simplified, content-focused)
 * @param {Object} pdfData - Extracted PDF data
 * @param {string} outputPath - Path for output canvas HTML file
 */
function exportToCanvasHTML(pdfData, outputPath) {
  try {
    const transformedText = applyTextTransformations(pdfData.text, { preserveLineBreakAlignment: true });
    let textForCanvas = transformedText;

    // Apply the same super/subscript pipeline used for interactive HTML
    if (pdfData.textMetadata && Array.isArray(pdfData.textMetadata) && pdfData.textMetadata.length > 0) {
      const filteredMetadata = pdfData.textMetadata.filter(item => {
        const value = (item.text || '').trim();
        return value.length > 0 && !/^Page-\d+$/i.test(value);
      });
      const positionBasedMarkup = markupSuperSubscript(filteredMetadata);
      if (positionBasedMarkup && positionBasedMarkup.length > 0) {
        textForCanvas = mergeMarkupIntoText(transformedText, positionBasedMarkup);
      }
    }
    textForCanvas = applySuperSubscriptMarkup(textForCanvas);

    // Apply paragraph/page-break cleanup after super/sub merge to avoid alignment regressions.
    textForCanvas = removeNonParagraphLineBreaks(textForCanvas, {
      pageBreakAware: true,
      logPageBreakJoins: true,
      logLabel: 'canvas-html'
    });

    const lines = textForCanvas.split('\n');
    const compiledAt = new Date().toISOString();
    
    // Build table of contents and section mapping
    const tocItems = [];
    const sections = [];
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      // Detect numbered sections
      const mainMatch = trimmed.match(/^(\d+)\s+([A-Z][A-Z\s\.]+)$/);
      const subMatch = trimmed.match(/^(\d+\.\d+)\s+([A-Z][A-Z\s\.]+)$/);
      const subSubMatch = trimmed.match(/^(\d+\.\d+\.\d+)\s+(.+)$/);
      
      if (mainMatch) {
        const [, number, title] = mainMatch;
        const id = `section${number.replace(/\./g, '-')}`;
        tocItems.push({ level: 1, number, title, id });
        sections.push({ type: 'h2', id, text: trimmed });
      } else if (subMatch) {
        const [, number, title] = subMatch;
        const id = `section${number.replace(/\./g, '-')}`;
        tocItems.push({ level: 2, number, title, id });
        sections.push({ type: 'h3', id, text: trimmed });
      } else if (subSubMatch) {
        const [, number, title] = subSubMatch;
        const id = `section${number.replace(/\./g, '-')}`;
        tocItems.push({ level: 3, number, title, id });
        sections.push({ type: 'h4', id, text: trimmed });
      } else {
        sections.push({ type: 'p', text: trimmed });
      }
    }
    
    // Build TOC HTML
    let tocHTML = '';
    let currentMainSection = null;
    let currentSubSection = null;
    
    for (const item of tocItems) {
      if (item.level === 1) {
        // Close previous sections
        if (currentSubSection) tocHTML += '                </table>\n              </td>\n            </tr>\n';
        if (currentMainSection) tocHTML += '          </tbody>\n        </table>\n      </td>\n    </tr>\n';
        
        currentMainSection = item;
        currentSubSection = null;
        tocHTML += `    <tr>
      <td style="padding: 8px;"><strong><a href="#${item.id}" style="color: #3498db; text-decoration: none; font-weight: bold; font-size: 1.1em;">${item.number} ${item.title}</a></strong></td>
    </tr>
    <tr>
      <td style="padding: 8px;">
        <table border="0" width="100%" cellspacing="0" cellpadding="4">
          <tbody>
`;
      } else if (item.level === 2) {
        if (currentSubSection) {
          tocHTML += '                </table>\n              </td>\n            </tr>\n';
        }
        currentSubSection = item;
        tocHTML += `            <tr>
              <td style="padding: 8px; padding-left: 30px;"><a href="#${item.id}" style="color: #3498db; text-decoration: none;">${item.number} ${item.title}</a></td>
            </tr>
            <tr>
              <td style="padding: 8px; padding-left: 30px;">
                <table border="0" width="100%" cellspacing="0" cellpadding="3">
                  <tbody>
`;
      } else if (item.level === 3) {
        tocHTML += `                    <tr>
                      <td style="padding: 8px; padding-left: 50px;"><a href="#${item.id}" style="color: #3498db; text-decoration: none;">${item.number} ${item.title}</a></td>
                    </tr>
`;
      }
    }
    
    // Close remaining sections
    if (currentSubSection) tocHTML += '                  </tbody>\n                </table>\n              </td>\n            </tr>\n';
    if (currentMainSection) tocHTML += '          </tbody>\n        </table>\n      </td>\n    </tr>\n';
    
    // Build content HTML
    let contentHTML = '';
    let inContentDiv = false;
    
    for (const section of sections) {
      if (section.type === 'h2') {
        if (inContentDiv) {
          contentHTML += '</div>\n\n';
          inContentDiv = false;
        }
        contentHTML += `<h2 id="${section.id}" style="color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px;">${section.text}</h2>\n`;
      } else if (section.type === 'h3') {
        if (inContentDiv) {
          contentHTML += '</div>\n\n';
          inContentDiv = false;
        }
        contentHTML += `<h3 id="${section.id}" style="color: #34495e; margin-top: 30px;">${section.text}</h3>\n`;
      } else if (section.type === 'h4') {
        if (inContentDiv) {
          contentHTML += '</div>\n\n';
          inContentDiv = false;
        }
        contentHTML += `<h4 id="${section.id}" style="color: #7f8c8d; margin-top: 20px; margin-left: 15px;">${section.text}</h4>\n`;
      } else if (section.type === 'p' && section.text) {
        if (!inContentDiv) {
          contentHTML += '<div style="background-color: white; padding: 20px; margin: 20px 0; box-shadow: 0 2px 4px rgba(0,0,0,0.1); border-radius: 4px;">\n';
          inContentDiv = true;
        }
        contentHTML += `  <p style="line-height: 1.6; text-align: left; color: #333;">${section.text}</p>\n`;
      }
    }
    
    if (inContentDiv) {
      contentHTML += '</div>\n';
    }
    
    // Apply list conversions
    contentHTML = convertNumberParenLists(convertAlphaParenLists(contentHTML));
    
    // Build final HTML
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${pdfData.metadata.title !== 'N/A' ? pdfData.metadata.title : 'Document'} - Table of Contents</title>
</head>
<body style="font-family: Arial, sans-serif; margin: 20px; background-color: #f5f5f5;">
<div id="compiled-at" style="display: none;">Compiled at: ${compiledAt}</div>

<h2 style="color: #2c3e50; padding-bottom: 10px;">Menu</h2>
<table border="0" width="600" cellspacing="0" cellpadding="6" style="background-color: white; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
  <tbody>
${tocHTML}
  </tbody>
</table>

<hr style="margin: 30px 0; border: none; border-top: 2px solid #ddd;" />

${contentHTML}

</body>
</html>`;

    fs.writeFileSync(outputPath, html);
    console.log(`✓ Canvas HTML file saved to: ${outputPath}`);
    return true;
  } catch (error) {
    console.error(`✗ Error saving Canvas HTML: ${error.message}`);
    return false;
  }
}

/**
 * Process a single PDF file and export in multiple formats
 * @param {string} pdfPath - Path to the PDF file
 * @param {string} outputSubDir - Output subdirectory for this PDF
 * @param {Object} formats - Format selection options (all default to true)
 */
async function processPDF(pdfPath, outputSubDir, formats = {}) {
  // Default all formats to true if not specified
  const formatOptions = {
    text: formats.text !== false,
    editedText: formats.editedText !== false,
    html: formats.html !== false,
    htmlHighlighted: formats.htmlHighlighted === true,
    canvas: formats.canvas !== false,
    csv: formats.csv !== false,
    h5p: formats.h5p !== false,
    images: formats.images !== false
  };

  console.log(`📄 Processing PDF: ${pdfPath}\n`);
  console.log('[ProcessPDF] Formats:', JSON.stringify(formatOptions));

  // Extract PDF data with images
  const pdfData = await extractPDFDataWithImages(pdfPath, outputSubDir);

  if (!pdfData.success) {
    console.error(`✗ Failed to extract PDF: ${pdfData.error}`);
    return false;
  }

  console.log(`✓ Successfully extracted PDF data`);
  console.log(`  Pages: ${pdfData.metadata.pages}`);
  console.log(`  Title: ${pdfData.metadata.title}`);
  console.log(`  Embedded images: ${pdfData.images ? pdfData.images.length : 0}\n`);

  // Export in multiple formats based on selection
  const baseName = path.basename(pdfPath, path.extname(pdfPath));
  let exportFailed = false;
  
  try {
    if (formatOptions.text && !exportToText(pdfData, path.join(outputSubDir, `${baseName}.txt`))) exportFailed = true;
    if (formatOptions.editedText && !exportToEditedText(pdfData, path.join(outputSubDir, `${baseName}_edited.txt`))) exportFailed = true;
    if (formatOptions.html) {
      const htmlPath = path.join(outputSubDir, `${baseName}.html`);
      console.log('[ProcessPDF] Exporting interactive HTML to:', htmlPath);
      const htmlOk = exportToHTML(pdfData, htmlPath, outputSubDir);
      const htmlExists = fs.existsSync(htmlPath);
      console.log('[ProcessPDF] Interactive HTML exists:', htmlExists);
      if (!htmlOk || !htmlExists) exportFailed = true;
    } else {
      console.log('[ProcessPDF] Skipping interactive HTML export.');
    }
    if (formatOptions.htmlHighlighted) {
      const highlightedPath = path.join(outputSubDir, `${baseName}_highlighted.html`);
      console.log('[ProcessPDF] Exporting highlighted HTML to:', highlightedPath);
      const highlightedOk = exportToHighlightedHTML(pdfData, highlightedPath, outputSubDir);
      const highlightedExists = fs.existsSync(highlightedPath);
      console.log('[ProcessPDF] Highlighted HTML exists:', highlightedExists);
      if (!highlightedOk || !highlightedExists) exportFailed = true;
    } else {
      console.log('[ProcessPDF] Skipping highlighted HTML export.');
    }
    if (formatOptions.canvas && !exportToCanvasHTML(pdfData, path.join(outputSubDir, `${baseName}_canvas.html`))) exportFailed = true;
    if (formatOptions.csv && !exportToCSV(pdfData, path.join(outputSubDir, `${baseName}.csv`))) exportFailed = true;
    if (formatOptions.h5p && !exportToH5P(pdfData, path.join(outputSubDir, `${baseName}_content.json`))) exportFailed = true;
  } catch (err) {
    console.error(`Error during export:`, err.message);
    console.error(err.stack);
    exportFailed = true;
  }

  if (exportFailed) {
    console.error(`✗ One or more exports failed for ${baseName}.`);
    return false;
  }

  console.log(`✓ All conversions completed for ${baseName}!\n`);
  return true;
}

/**
 * Generates HTML dashboard for starting PDF conversion
 * @param {Array} inputFiles - Array of PDF filenames in input folder
 * @param {boolean} processing - Whether processing is currently running
 * @returns {string} HTML content
 */
function generateDashboardHTML(inputFiles, processing) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PDF Converter Dashboard</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
      background: #0d1117;
      color: #c9d1d9;
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
    }
    h1 {
      color: #58a6ff;
      margin-bottom: 30px;
      font-size: 1.5em;
      font-weight: normal;
      border-bottom: 1px solid #21262d;
      padding-bottom: 10px;
    }
    .section {
      background: #161b22;
      border: 1px solid #30363d;
      padding: 20px;
      margin-bottom: 20px;
    }
    .section h2 {
      color: #58a6ff;
      font-size: 1.1em;
      font-weight: normal;
      margin-bottom: 15px;
      border-bottom: 1px solid #21262d;
      padding-bottom: 8px;
    }
    .file-list {
      background: #0d1117;
      border: 1px solid #21262d;
      padding: 15px;
      max-height: 300px;
      overflow-y: auto;
      margin-bottom: 15px;
    }
    .file-item {
      padding: 8px 0;
      color: #8b949e;
      border-bottom: 1px solid #21262d;
    }
    .file-item:last-child {
      border-bottom: none;
    }
    .file-item::before {
      content: "▪ ";
      color: #58a6ff;
      margin-right: 8px;
    }
    .no-files {
      color: #8b949e;
      font-style: italic;
      padding: 10px 0;
    }
    .button-group {
      display: flex;
      gap: 10px;
    }
    button {
      flex: 1;
      padding: 12px 20px;
      background: #21262d;
      color: #58a6ff;
      border: 1px solid #30363d;
      cursor: pointer;
      font-family: inherit;
      font-size: 0.95em;
      transition: background-color 0.2s, border-color 0.2s;
    }
    button:hover:not(:disabled) {
      background: #30363d;
      border-color: #58a6ff;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .btn-primary {
      background: #1f6feb;
      color: white;
      border-color: #1f6feb;
    }
    .btn-primary:hover:not(:disabled) {
      background: #388bfd;
      border-color: #388bfd;
    }
    .description {
      color: #8b949e;
      line-height: 1.6;
      margin-bottom: 15px;
      font-size: 0.9em;
    }
    .status-message {
      background: #161b22;
      border-left: 3px solid #58a6ff;
      padding: 15px;
      margin-bottom: 20px;
      color: #c9d1d9;
    }
    .update-banner {
      display: none;
      background: #11233d;
      border: 1px solid #2f6fb5;
      color: #cfe8ff;
      padding: 12px;
      margin-bottom: 18px;
      font-size: 0.9em;
      line-height: 1.4;
    }
    .update-banner.show {
      display: block;
    }
    .update-banner code {
      color: #9bd0ff;
      font-family: 'Consolas', 'Monaco', monospace;
    }
    .app-version {
      color: #8b949e;
      font-size: 0.85em;
      margin: -18px 0 20px 0;
    }
    .app-version-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin: -18px 0 20px 0;
    }
    .app-version-row .app-version {
      margin: 0;
    }
    .check-updates-btn {
      background: #21262d;
      color: #58a6ff;
      border: 1px solid #30363d;
      padding: 6px 10px;
      font-size: 0.8em;
      border-radius: 4px;
      cursor: pointer;
      white-space: nowrap;
    }
    .check-updates-btn:hover:not(:disabled) {
      background: #30363d;
      border-color: #58a6ff;
    }
    .check-updates-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>PDF Converter Dashboard</h1>
    <div class="app-version-row">
      <div class="app-version">Version v${APP_VERSION}</div>
      <button id="checkUpdatesBtn" class="check-updates-btn" type="button">Check updates</button>
    </div>
    <div id="updateBanner" class="update-banner" role="status" aria-live="polite"></div>
    
    <div class="section">
      <h2>Input Files</h2>
      <p class="description">Select the PDFs you want to convert from your input folder.</p>
      <div class="file-list">
        ${inputFiles.length === 0 ? `
        <div class="no-files">
          <strong>No PDFs found in input/ folder.</strong><br>
          Add one or more PDF files to <code>input/</code>, then click <em>Refresh List</em> to continue.
        </div>
        ` : `
        <label class="file-item" style="display: flex; align-items: center; gap: 8px; color: #c9d1d9; padding: 8px 0;">
          <input type="checkbox" id="selectAll" checked> Select all
        </label>
        ${inputFiles.map(file => `
        <label class="file-item" style="display: flex; align-items: center; gap: 8px; color: #8b949e; padding: 8px 0;">
          <input type="checkbox" class="file-checkbox" data-file="${file}" checked> ${file}
        </label>`).join('')}
        `}
      </div>
      <div class="button-group">
        <button onclick="location.reload()">Refresh List</button>
        <button class="btn-primary" onclick="checkPDFs()" ${processing ? 'disabled' : ''}>Check PDFs</button>
      </div>
    </div>
    
    <div class="section">
      <h2>Output Formats</h2>
      <p class="description">Select which formats to generate for each PDF:</p>
      <div id="formatCheckboxes" style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 15px;">
        <label style="display: flex; align-items: center; gap: 8px; color: #c9d1d9;">
          <input type="checkbox" id="fmt-html" checked> HTML (Interactive)
        </label>
        <label style="display: flex; align-items: center; gap: 8px; color: #c9d1d9;">
          <input type="checkbox" id="fmt-htmlHighlighted" checked> HTML (Highlighted)
        </label>
        <label style="display: flex; align-items: center; gap: 8px; color: #c9d1d9;">
          <input type="checkbox" id="fmt-canvas" checked> Canvas
        </label>
        <label style="display: flex; align-items: center; gap: 8px; color: #c9d1d9;">
          <input type="checkbox" id="fmt-text" checked> Plain Text
        </label>
        <label style="display: flex; align-items: center; gap: 8px; color: #c9d1d9;">
          <input type="checkbox" id="fmt-csv" checked> CSV
        </label>
        <label style="display: flex; align-items: center; gap: 8px; color: #c9d1d9;">
          <input type="checkbox" id="fmt-h5p" checked> H5P
        </label>
        <label style="display: flex; align-items: center; gap: 8px; color: #c9d1d9;">
          <input type="checkbox" id="fmt-images" checked> Extract Images
        </label>
      </div>
    </div>

    <div class="section">
      <h2>Convert PDFs</h2>
      <p class="description">Click "Start Processing" to begin converting all PDFs in the input folder. This may take a few moments depending on file size and number of PDFs.</p>
      <div id="statusArea" style="display: none; margin-bottom: 15px;">
        <div class="status-message">
          <div><strong>Processing:</strong> <span id="currentFile">-</span></div>
          <div><strong>Progress:</strong> <span id="fileCount">0</span>/<span id="totalCount">0</span> files</div>
          <div style="background: #0d1117; border: 1px solid #21262d; padding: 8px; margin-top: 8px; border-radius: 4px;">
            <div id="progressBar" style="background: #1f6feb; height: 20px; border-radius: 2px; width: 0%; transition: width 0.2s;"></div>
          </div>
          <div id="errorList" style="margin-top: 12px; max-height: 200px; overflow-y: auto;"></div>
          <button id="cancelBtn" class="btn-primary" onclick="cancelProcessing()" style="width: 100%; margin-top: 12px; padding: 10px;">Cancel Processing</button>
        </div>
      </div>
      ${processing ? '<div class="status-message">Processing is running...</div>' : ''}
      <button class="btn-primary" id="startBtn" onclick="startProcessing()" ${inputFiles.length === 0 || processing ? 'disabled' : ''} style="width: 100%; padding: 15px;">Start Processing</button>
    </div>
  </div>
  
  <script>
    let progressEventSource = null;

    function checkForUpdate(force = false) {
      const button = document.getElementById('checkUpdatesBtn');
      if (button && force) {
        button.disabled = true;
        button.textContent = 'Checking...';
      }

      fetch('/api/update-check' + (force ? '?force=1' : ''))
        .then(r => r.json())
        .then(data => {
          const banner = document.getElementById('updateBanner');
          if (!banner) return;

          if (!data || !data.success || !data.updateAvailable) return;
          banner.innerHTML = 'Update available: <code>v' + data.latestVersion + '</code> (current: <code>v' + data.currentVersion + '</code>). ' +
            'Run <code>npm install -g @j.hughes.cu/pdf-converter@latest</code> to update.';
          banner.classList.add('show');
        })
        .catch(() => {})
        .finally(() => {
          if (button) {
            button.disabled = false;
            button.textContent = 'Check updates';
          }
        });
    }

    const checkUpdatesBtn = document.getElementById('checkUpdatesBtn');
    if (checkUpdatesBtn) {
      checkUpdatesBtn.addEventListener('click', function() {
        checkForUpdate(true);
      });
    }
    
    function saveCheckboxStates() {
      const formatStates = {
        html: document.getElementById('fmt-html').checked,
        htmlHighlighted: document.getElementById('fmt-htmlHighlighted').checked,
        canvas: document.getElementById('fmt-canvas').checked,
        text: document.getElementById('fmt-text').checked,
        csv: document.getElementById('fmt-csv').checked,
        h5p: document.getElementById('fmt-h5p').checked,
        images: document.getElementById('fmt-images').checked
      };
      localStorage.setItem('pdf-converter-formats', JSON.stringify(formatStates));
      
      const fileStates = {};
      document.querySelectorAll('.file-checkbox').forEach(cb => {
        fileStates[cb.dataset.file] = cb.checked;
      });
      localStorage.setItem('pdf-converter-files', JSON.stringify(fileStates));
    }

    function loadCheckboxStates() {
      try {
        const formatStates = JSON.parse(localStorage.getItem('pdf-converter-formats') || '{}');
        Object.keys(formatStates).forEach(key => {
          const checkbox = document.getElementById('fmt-' + key);
          if (checkbox) checkbox.checked = formatStates[key];
        });
        
        const fileStates = JSON.parse(localStorage.getItem('pdf-converter-files') || '{}');
        document.querySelectorAll('.file-checkbox').forEach(cb => {
          if (fileStates.hasOwnProperty(cb.dataset.file)) {
            cb.checked = fileStates[cb.dataset.file];
          }
        });
      } catch (err) {
        console.error('Error loading checkbox states:', err);
      }
    }

    function getSelectedFormats() {
      return {
        html: document.getElementById('fmt-html').checked,
        htmlHighlighted: document.getElementById('fmt-htmlHighlighted').checked,
        canvas: document.getElementById('fmt-canvas').checked,
        text: document.getElementById('fmt-text').checked,
        csv: document.getElementById('fmt-csv').checked,
        h5p: document.getElementById('fmt-h5p').checked,
        images: document.getElementById('fmt-images').checked
      };
    }
    
    function checkPDFs() {
      fetch('/api/list-inputs')
        .then(r => r.json())
        .then(data => {
          if (data.files && data.files.length > 0) {
            alert('Found ' + data.files.length + ' PDF(s) ready to process');
          } else {
            alert('No PDFs found in input folder');
          }
        })
        .catch(err => alert('Error checking PDFs'));
    }

    function getSelectedFiles() {
      return Array.from(document.querySelectorAll('.file-checkbox:checked'))
        .map(cb => cb.dataset.file);
    }

    function updateSelectAllState() {
      const boxes = Array.from(document.querySelectorAll('.file-checkbox'));
      const selectAll = document.getElementById('selectAll');
      if (!selectAll || boxes.length === 0) return;
      selectAll.checked = boxes.every(cb => cb.checked);
    }

    function addViewOutputButton(checkbox, filename) {
      let viewBtn = checkbox.parentElement.querySelector('.view-output-btn');
      let deleteBtn = checkbox.parentElement.querySelector('.delete-output-btn');
      if (viewBtn && deleteBtn) return; // Already exists
      
      viewBtn = document.createElement('button');
      viewBtn.className = 'view-output-btn';
      viewBtn.textContent = 'View Output';
      viewBtn.type = 'button';
      viewBtn.style.cssText = 'background: #1f6feb; color: white; border: 1px solid #1f6feb; border-radius: 4px; padding: 4px 10px; font-size: 0.85em; cursor: pointer; margin-left: 8px;';
      viewBtn.onclick = (e) => {
        e.preventDefault();
        const baseName = filename.replace(/\.pdf$/i, '');
        const windowName = 'pdf-output-' + baseName.replace(/[^a-zA-Z0-9]/g, '-');
        window.open('/output/' + encodeURIComponent(baseName) + '/', windowName);
      };
      viewBtn.onmouseover = () => viewBtn.style.background = '#388bfd';
      viewBtn.onmouseout = () => viewBtn.style.background = '#1f6feb';
      checkbox.parentElement.appendChild(viewBtn);

      if (!deleteBtn) {
        deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-output-btn';
        deleteBtn.textContent = 'Delete Output';
        deleteBtn.type = 'button';
        deleteBtn.style.cssText = 'background: #da3633; color: white; border: 1px solid #da3633; border-radius: 4px; padding: 4px 10px; font-size: 0.85em; cursor: pointer; margin-left: 8px;';
        deleteBtn.onclick = (e) => {
          e.preventDefault();
          if (!confirm('Delete outputs for ' + filename + '?')) return;
          
          // Close any open output tab for this file
          const baseName = filename.replace(/\.pdf$/i, '');
          const windowName = 'pdf-output-' + baseName.replace(/[^a-zA-Z0-9]/g, '-');
          try {
            const outputWindow = window.open('', windowName);
            if (outputWindow && !outputWindow.closed) {
              outputWindow.close();
            }
          } catch (err) {
            console.log('Could not close output window (may be blocked):', err);
          }
          
          fetch('/api/delete-output', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: filename })
          })
            .then(r => r.json())
            .then(data => {
              if (data.success) {
                if (viewBtn && viewBtn.parentElement) viewBtn.remove();
                if (deleteBtn && deleteBtn.parentElement) deleteBtn.remove();
                alert('Outputs deleted for ' + filename);
              } else {
                alert('Delete failed: ' + (data.error || 'Unknown error'));
              }
            })
            .catch(err => alert('Delete error: ' + err.message));
        };
        deleteBtn.onmouseover = () => deleteBtn.style.background = '#f85149';
        deleteBtn.onmouseout = () => deleteBtn.style.background = '#da3633';
        checkbox.parentElement.appendChild(deleteBtn);
      }
    }

    function initFileSelection() {
      const selectAll = document.getElementById('selectAll');
      if (!selectAll) return;
      
      // Load saved states
      loadCheckboxStates();
      
      // Add change listeners with save
      selectAll.addEventListener('change', () => {
        const checked = selectAll.checked;
        document.querySelectorAll('.file-checkbox').forEach(cb => {
          cb.checked = checked;
        });
        saveCheckboxStates();
      });
      
      document.querySelectorAll('.file-checkbox').forEach(cb => {
        cb.addEventListener('change', () => {
          updateSelectAllState();
          saveCheckboxStates();
        });
      });
      
      // Save format checkbox changes
      ['html', 'htmlHighlighted', 'canvas', 'text', 'csv', 'h5p', 'images'].forEach(fmt => {
        const checkbox = document.getElementById('fmt-' + fmt);
        if (checkbox) {
          checkbox.addEventListener('change', saveCheckboxStates);
        }
      });
      
      updateSelectAllState();
      
      // Check for existing outputs and add View Output buttons
      fetch('/api/check-outputs')
        .then(r => r.json())
        .then(data => {
          const processedSet = new Set(data.processedFiles || []);
          document.querySelectorAll('.file-checkbox').forEach(checkbox => {
            const filename = checkbox.dataset.file;
            if (processedSet.has(filename)) {
              addViewOutputButton(checkbox, filename);
            }
          });
        })
        .catch(err => console.error('Error checking outputs:', err));
    }
    
    function connectProgressStream() {
      if (progressEventSource) progressEventSource.close();
      progressEventSource = new EventSource('/api/progress');
      
      progressEventSource.onmessage = (event) => {
        const state = JSON.parse(event.data);

        // Update progress bar
        const total = state.totalFiles || 1;
        const processed = state.processedFiles ? state.processedFiles.length : 0;
        const percent = Math.round((processed / total) * 100);
        document.getElementById('progressBar').style.width = percent + '%';

        // Update file counts
        document.getElementById('fileCount').textContent = processed;
        document.getElementById('totalCount').textContent = total;

        // Update current file
        document.getElementById('currentFile').textContent = state.currentFile || 'Starting...';

        // Update error list
        const errorList = document.getElementById('errorList');
        if (state.errors && state.errors.length > 0) {
          errorList.innerHTML = '<strong style="color: #f85149;">Errors:</strong><ul style="margin: 8px 0 0 20px;">' +
            state.errors.map(e => '<li style="color: #f85149; margin: 4px 0;">' + e + '</li>').join('') +
            '</ul>';
        } else {
          errorList.innerHTML = '';
        }

        if (state.completed || (processed >= total && !state.currentFile)) {
          document.getElementById('currentFile').textContent = 'Complete';
          const startBtn = document.getElementById('startBtn');
          startBtn.disabled = false;
          startBtn.textContent = 'Start Processing';
          const cancelBtn = document.getElementById('cancelBtn');
          if (cancelBtn) {
            cancelBtn.disabled = true;
            cancelBtn.textContent = 'Processing Complete';
            cancelBtn.style.backgroundColor = '#28a745';
            cancelBtn.style.borderColor = '#28a745';
            cancelBtn.onclick = null;
            setTimeout(() => {
              cancelBtn.style.backgroundColor = '#6c757d';
              cancelBtn.style.borderColor = '#6c757d';
            }, 3000);
          }
          
          // Add "View Output" buttons for processed files
          const processedFiles = state.processedFiles || [];
          processedFiles.forEach(filename => {
            const checkbox = document.querySelector('.file-checkbox[data-file="' + filename + '"]');
            if (checkbox) {
              addViewOutputButton(checkbox, filename);
            }
          });
          
          progressEventSource.close();
        }
      };
      
      progressEventSource.onerror = () => {
        console.log('Progress stream ended');
        progressEventSource.close();
      };
    }
    
    function startProcessing() {
      const formats = getSelectedFormats();
      const selectedFiles = getSelectedFiles();
      const fileCount = selectedFiles.length;
      
      if (fileCount === 0) {
        alert('Select at least one PDF to process');
        return;
      }
      
      if (!confirm('Start processing ' + fileCount + ' PDF(s) with selected formats?')) return;
      
      const btn = document.getElementById('startBtn');
      btn.disabled = true;
      btn.textContent = 'Processing...';
      
      // Show progress area
      document.getElementById('statusArea').style.display = 'block';
      
      // Connect to progress stream
      connectProgressStream();
      
      // Send start request
      fetch('/api/start-processing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ formats: formats, selectedFiles: selectedFiles })
      })
        .then(r => r.json())
        .then(data => {
          if (data.success) {
            // Processing started, progress stream will update the UI
          } else {
            alert('Error: ' + (data.error || 'Unknown error'));
            btn.disabled = false;
            btn.textContent = 'Start Processing';
            document.getElementById('statusArea').style.display = 'none';
          }
        })
        .catch(err => {
          alert('Error starting processing: ' + err.message);
          btn.disabled = false;
          btn.textContent = 'Start Processing';
          document.getElementById('statusArea').style.display = 'none';
        });
    }
    
    function cancelProcessing() {
      if (!confirm('Cancel processing?')) return;
      fetch('/api/cancel', { method: 'POST' })
        .then(() => {
          alert('Cancel requested');
        })
        .catch(err => alert('Error canceling: ' + err.message));
    }

    initFileSelection();
    checkForUpdate();
  </script>
</body>
</html>`;
}

/**
 * Generates HTML menu page for converted PDFs
 * @param {string} outputBaseDir - Base output directory
 * @returns {string} HTML content
 */
function generateMenuHTML(outputBaseDir) {
  const menuItems = [];
  const inputDir = './input';
  const inputFiles = fs.existsSync(inputDir)
    ? fs.readdirSync(inputDir).filter(f => f.toLowerCase().endsWith('.pdf'))
    : [];
  
  if (fs.existsSync(outputBaseDir)) {
    const subdirs = fs.readdirSync(outputBaseDir).filter(item => {
      const itemPath = path.join(outputBaseDir, item);
      return fs.statSync(itemPath).isDirectory();
    });
    
    subdirs.forEach(dirName => {
      const dirPath = path.join(outputBaseDir, dirName);
      const files = fs.readdirSync(dirPath);
      
      const outputs = {
        html: files.find(f => f.endsWith('.html') && !f.endsWith('_canvas.html') && !f.endsWith('_highlighted.html')),
        highlighted: files.find(f => f.endsWith('_highlighted.html')),
        canvas: files.find(f => f.endsWith('_canvas.html')),
        txt: files.find(f => f.endsWith('.txt') && !f.endsWith('_edited.txt')),
        editedTxt: files.find(f => f.endsWith('_edited.txt')),
        csv: files.find(f => f.endsWith('.csv')),
        h5p: files.find(f => f.endsWith('_content.json')),
        images: fs.existsSync(path.join(dirPath, 'images'))
      };
      
      menuItems.push({ dirName, outputs });
    });
  }
  
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PDF Converter - Output Menu</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
      background: #0d1117;
      color: #c9d1d9;
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
    }
    h1 {
      color: #58a6ff;
      margin-bottom: 20px;
      font-size: 1.5em;
      font-weight: normal;
      border-bottom: 1px solid #21262d;
      padding-bottom: 10px;
    }
    .pdf-card {
      background: #161b22;
      border: 1px solid #30363d;
      padding: 20px;
      margin-bottom: 20px;
    }
    .pdf-card:hover {
      border-color: #58a6ff;
    }
    .pdf-title {
      color: #c9d1d9;
      font-size: 1.1em;
      margin-bottom: 15px;
      font-weight: normal;
    }
    .outputs-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px;
      margin-top: 15px;
    }
    .output-link {
      display: block;
      padding: 10px 15px;
      background: #21262d;
      color: #58a6ff;
      text-decoration: none;
      border: 1px solid #30363d;
      font-size: 0.9em;
      transition: background-color 0.2s, border-color 0.2s;
    }
    .output-link:hover {
      background: #30363d;
      border-color: #58a6ff;
    }
    .output-link.secondary {
      color: #79c0ff;
    }
    .output-link.tertiary {
      color: #7ee787;
    }
    .canvas-item {
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    .canvas-item .output-link {
      margin-bottom: 0;
      border-bottom: none;
    }
    .canvas-item .copy-btn {
      border-top: none;
    }
    .copy-btn {
      display: block;
      padding: 10px 15px;
      background: #21262d;
      color: #a371f7;
      border: 1px solid #30363d;
      font-size: 0.9em;
      cursor: pointer;
      transition: background-color 0.2s, border-color 0.2s;
      font-family: inherit;
    }
    .copy-btn:hover {
      background: #30363d;
      border-color: #a371f7;
    }
    .copy-btn.copied {
      color: #7ee787;
    }
    .no-pdfs {
      background: #161b22;
      border: 1px solid #30363d;
      padding: 40px;
      text-align: center;
      color: #8b949e;
    }
    .server-info {
      background: #161b22;
      border: 1px solid #30363d;
      color: #8b949e;
      padding: 10px;
      margin-bottom: 20px;
      font-size: 0.9em;
    }
    .input-empty-warning {
      background: #2b1a1a;
      border: 1px solid #a04040;
      color: #ffd7d7;
      padding: 14px;
      margin-bottom: 20px;
      font-size: 0.92em;
      line-height: 1.5;
    }
    .input-empty-warning code {
      color: #ffb3b3;
      font-family: 'Consolas', 'Monaco', monospace;
    }
    .app-version {
      color: #8b949e;
      font-size: 0.85em;
      margin: -10px 0 20px 0;
    }
    .app-version-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin: -10px 0 20px 0;
    }
    .app-version-row .app-version {
      margin: 0;
    }
    .check-updates-btn {
      background: #21262d;
      color: #58a6ff;
      border: 1px solid #30363d;
      padding: 6px 10px;
      font-size: 0.8em;
      border-radius: 4px;
      cursor: pointer;
      white-space: nowrap;
    }
    .check-updates-btn:hover:not(:disabled) {
      background: #30363d;
      border-color: #58a6ff;
    }
    .check-updates-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .update-banner {
      display: none;
      background: #11233d;
      border: 1px solid #2f6fb5;
      color: #cfe8ff;
      padding: 12px;
      margin-bottom: 18px;
      font-size: 0.9em;
      line-height: 1.4;
    }
    .update-banner.show {
      display: block;
    }
    .update-banner code {
      color: #9bd0ff;
      font-family: 'Consolas', 'Monaco', monospace;
    }
    .file-key {
      background: #161b22;
      border: 1px solid #30363d;
      padding: 20px;
      margin-bottom: 20px;
      font-size: 0.9em;
    }
    .file-key h2 {
      color: #58a6ff;
      font-size: 1em;
      font-weight: normal;
      margin-bottom: 15px;
      border-bottom: 1px solid #21262d;
      padding-bottom: 8px;
    }
    .file-key dl {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 10px 15px;
      margin: 0;
    }
    .file-key dt {
      color: #58a6ff;
      font-family: 'Consolas', 'Monaco', monospace;
    }
    .file-key dd {
      color: #8b949e;
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="server-info">
      Output Directory: ./output | Server: http://localhost:3000
    </div>
    ${inputFiles.length === 0 ? `
    <div class="input-empty-warning">
      <strong>No files were found in <code>input/</code>.</strong><br>
      You must add one or more PDF files to <code>input/</code> to continue processing new documents.
    </div>` : ''}
    <h1>PDF Converter Output</h1>
    <div class="app-version-row">
      <div class="app-version">Version v${APP_VERSION}</div>
      <button id="checkUpdatesBtn" class="check-updates-btn" type="button">Check updates</button>
    </div>
    <div id="updateBanner" class="update-banner" role="status" aria-live="polite"></div>
    <div class="file-key">
      <h2>File Types</h2>
      <dl>
        <dt>interactive.html</dt>
        <dd>Editable version of the output with inline editing capabilities</dd>
        <dt>highlighted.html</dt>
        <dd>Read-only version with superscript/subscript highlighted in yellow</dd>
        <dt>canvas.html</dt>
        <dd>HTML version with table of contents, optimized for Canvas LMS (copy directly into Canvas page)</dd>
        <dt>text.txt</dt>
        <dd>Raw text extracted from the original PDF</dd>
        <dt>edited.txt</dt>
        <dd>Partially formatted version of the original text</dd>
        <dt>images/</dt>
        <dd>PDF pages as a series of images (may require cropping)</dd>
      </dl>
    </div>
    ${menuItems.length === 0 ? `
    <div class="no-pdfs">
      <p><strong>No converted output found yet.</strong></p>
      <p>You must add some files to the <code>input/</code> folder to continue, then run processing from the dashboard.</p>
      <p style="margin-top: 10px; color: #8b949e;">Tip: after adding files, refresh this page and click <em>Start Processing</em>.</p>
    </div>` : menuItems.map(item => `
    <div class="pdf-card">
      <h2 class="pdf-title">${item.dirName}</h2>
      <div class="outputs-grid">
        ${item.outputs.html ? `<a href="/output/${item.dirName}/${item.outputs.html}" class="output-link" target="_blank">interactive.html</a>` : ''}
        ${item.outputs.highlighted ? `<a href="/output/${item.dirName}/${item.outputs.highlighted}" class="output-link" target="_blank">highlighted.html</a>` : ''}
        ${item.outputs.canvas ? `<div class="canvas-item"><a href="/output/${item.dirName}/${item.outputs.canvas}" class="output-link secondary" target="_blank">canvas.html</a><button class="copy-btn" onclick="copyCanvasHTML(event, '/output/${item.dirName}/${item.outputs.canvas}')">copy HTML</button></div>` : ''}
        ${item.outputs.txt ? `<a href="/output/${item.dirName}/${item.outputs.txt}" class="output-link tertiary" target="_blank">text.txt</a>` : ''}
        ${item.outputs.editedTxt ? `<a href="/output/${item.dirName}/${item.outputs.editedTxt}" class="output-link tertiary" target="_blank">edited.txt</a>` : ''}
        ${item.outputs.images ? `<a href="/output/${item.dirName}/images/" class="output-link" target="_blank">images/</a>` : ''}
      </div>
    </div>`).join('')}
  </div>
  
  <script>
    function checkForUpdate(force = false) {
      const button = document.getElementById('checkUpdatesBtn');
      if (button && force) {
        button.disabled = true;
        button.textContent = 'Checking...';
      }

      fetch('/api/update-check' + (force ? '?force=1' : ''))
        .then(r => r.json())
        .then(data => {
          const banner = document.getElementById('updateBanner');
          if (!banner) return;

          if (!data || !data.success || !data.updateAvailable) return;
          banner.innerHTML = 'Update available: <code>v' + data.latestVersion + '</code> (current: <code>v' + data.currentVersion + '</code>). ' +
            'Run <code>npm install -g @j.hughes.cu/pdf-converter@latest</code> to update.';
          banner.classList.add('show');
        })
        .catch(() => {})
        .finally(() => {
          if (button) {
            button.disabled = false;
            button.textContent = 'Check updates';
          }
        });
    }

    const checkUpdatesBtn = document.getElementById('checkUpdatesBtn');
    if (checkUpdatesBtn) {
      checkUpdatesBtn.addEventListener('click', function() {
        checkForUpdate(true);
      });
    }

    async function copyCanvasHTML(event, url) {
      const button = event.target;
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error('Failed to fetch file');
        const html = await response.text();
        await navigator.clipboard.writeText(html);
        
        // Provide feedback to user
        button.textContent = 'copied';
        button.classList.add('copied');
        setTimeout(() => {
          button.textContent = 'copy HTML';
          button.classList.remove('copied');
        }, 2000);
      } catch (err) {
        button.textContent = 'error';
        setTimeout(() => {
          button.textContent = 'copy HTML';
        }, 2000);
      }
    }

    checkForUpdate();
  </script>
</body>
</html>`;
  
  return html;
}

/**
 * Process all PDFs in the input directory
 * @param {string} inputDir - Input directory path
 * @param {string} outputBaseDir - Output base directory path
 * @param {Object} formats - Format selection options
 * @param {Array|null} selectedFiles - Optional list of selected PDF filenames
 */
async function processPDFsAsync(inputDir, outputBaseDir, formats = {}, selectedFiles = null) {
  try {
    shouldCancel = false;
    progressState = {
      currentFile: null,
      fileIndex: 0,
      totalFiles: 0,
      processedFiles: [],
      errors: [],
      completedFormats: {},
      completed: false
    };

    const files = fs.readdirSync(inputDir);
    let pdfFiles = files.filter(file => file.toLowerCase().endsWith('.pdf'));

    if (Array.isArray(selectedFiles)) {
      const selectedSet = new Set(selectedFiles);
      pdfFiles = pdfFiles.filter(file => selectedSet.has(file));
    }

    if (pdfFiles.length === 0) {
      console.log(`No PDF files found in ${inputDir}`);
      broadcastProgress();
      return;
    }

    progressState.totalFiles = pdfFiles.length;
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Found ${pdfFiles.length} PDF file(s) to process:\n`);
    console.log(`Note: Some PDF files may produce warnings like "TT: undefined function".\n       These are font encoding issues in the PDF itself and do not affect output quality.\n`);
    pdfFiles.forEach((file, index) => {
      console.log(`  ${index + 1}. ${file}`);
    });
    console.log('');
    broadcastProgress();

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < pdfFiles.length; i++) {
      if (shouldCancel) {
        console.log(`\n⚠ Processing cancelled by user`);
        progressState.currentFile = null;
        broadcastProgress();
        break;
      }

      const pdfFile = pdfFiles[i];
      progressState.fileIndex = i + 1;
      progressState.currentFile = pdfFile;
      broadcastProgress();

      const pdfPath = path.join(inputDir, pdfFile);
      const baseName = path.basename(pdfFile, path.extname(pdfFile));
      const outputSubDir = path.join(outputBaseDir, baseName);

      if (!fs.existsSync(outputSubDir)) {
        fs.mkdirSync(outputSubDir, { recursive: true });
      }

      const success = await processPDF(pdfPath, outputSubDir, formats);
      if (success) {
        successCount++;
        progressState.processedFiles.push(pdfFile);
      } else {
        failCount++;
        progressState.errors.push(pdfFile);
      }
      broadcastProgress();
    }

    console.log(`\n${'='.repeat(50)}`);
    console.log(`✓ Processing complete!`);
    console.log(`  Successful: ${successCount}`);
    console.log(`  Failed: ${failCount}`);
    console.log(`  Total: ${pdfFiles.length}`);
    console.log(`${'='.repeat(50)}`);
    console.log(`\nNote: If warnings or errors are displayed above (such as "TT: undefined function"),`);
    console.log(`these are font encoding issues in the PDF files themselves and do not affect the`);
    console.log(`quality or completeness of your converted output. All files have been processed.\n`);
    
    progressState.currentFile = null;
    progressState.completed = true;
    broadcastProgress();
  } catch (error) {
    console.error(`Error processing PDFs: ${error.message}`);
    progressState.errors.push(`Fatal error: ${error.message}`);
    broadcastProgress();
  }
}

/**
 * Broadcast progress update to all connected SSE clients
 */
function broadcastProgress() {
  const message = `data: ${JSON.stringify(progressState)}\n\n`;
  progressClients.forEach(client => {
    try {
      client.write(message);
    } catch (err) {
      // Client disconnected
    }
  });
}

function readJsonFileSafe(filePath, fallbackValue) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallbackValue;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_err) {
    return fallbackValue;
  }
}

function writeJsonAtomic(filePath, data) {
  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function appendHistoryLine(historyPath, entry) {
  const dirPath = path.dirname(historyPath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  fs.appendFileSync(historyPath, JSON.stringify(entry) + '\n', 'utf8');
}

function readHistoryEntries(historyPath) {
  if (!fs.existsSync(historyPath)) {
    return [];
  }

  const raw = fs.readFileSync(historyPath, 'utf8');
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch (_err) {
        return null;
      }
    })
    .filter(Boolean);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function normalizeDocumentState(rawState = {}) {
  const edits = (rawState.edits && typeof rawState.edits === 'object' && !Array.isArray(rawState.edits)) ? rawState.edits : {};
  const merges = Array.isArray(rawState.merges)
    ? rawState.merges.filter(item => Array.isArray(item) && item.length === 2 && Number.isInteger(item[0]) && Number.isInteger(item[1]))
    : [];
  return {
    version: Number.isInteger(rawState.version) ? rawState.version : 0,
    updatedAt: typeof rawState.updatedAt === 'string' ? rawState.updatedAt : null,
    edits,
    merges,
  };
}

function getOutputDocumentPaths(outputBaseDir, docKeyRaw) {
  let decoded = '';
  try {
    decoded = decodeURIComponent(docKeyRaw || '');
  } catch (_err) {
    return null;
  }
  const docKey = path.basename(decoded);
  if (!docKey || docKey !== decoded || docKey.includes('..')) {
    return null;
  }

  const docDir = path.join(outputBaseDir, docKey);
  const resolvedDocDir = path.resolve(docDir);
  const resolvedBase = path.resolve(outputBaseDir);
  if (!resolvedDocDir.startsWith(resolvedBase)) {
    return null;
  }

  return {
    docKey,
    docDir,
    editsFile: path.join(docDir, 'edits.json'),
    historyFile: path.join(docDir, 'edits.history.jsonl'),
  };
}

/**
 * Starts HTTP server to serve converted files
 * @param {string} outputBaseDir - Base output directory
 * @param {number} port - Port number
 */
function startServer(outputBaseDir, port = 3000) {
  const inputDir = './input';
  const server = http.createServer((req, res) => {
    // API endpoints
    if (req.url === '/api/list-inputs') {
      const files = fs.existsSync(inputDir) 
        ? fs.readdirSync(inputDir).filter(f => f.toLowerCase().endsWith('.pdf'))
        : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ files }));
      return;
    }

    if (req.url === '/api/check-outputs') {
      const inputFiles = fs.existsSync(inputDir)
        ? fs.readdirSync(inputDir).filter(f => f.toLowerCase().endsWith('.pdf'))
        : [];
      const processedFiles = [];
      
      inputFiles.forEach(file => {
        const baseName = path.basename(file, path.extname(file));
        const outputDir = path.join(outputBaseDir, baseName);
        if (fs.existsSync(outputDir)) {
          processedFiles.push(file);
        }
      });
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ processedFiles }));
      return;
    }

    if (req.url.startsWith('/api/update-check')) {
      const force = /(?:\?|&)force=1(?:&|$)/.test(req.url);
      getUpdateStatus(force)
        .then(status => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            currentVersion: status.currentVersion,
            latestVersion: status.latestVersion,
            updateAvailable: status.updateAvailable,
            checkedAt: status.checkedAt,
            error: status.error,
          }));
        })
        .catch(err => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            currentVersion: APP_VERSION,
            latestVersion: APP_VERSION,
            updateAvailable: false,
            checkedAt: Date.now(),
            error: err.message,
          }));
        });
      return;
    }

    if (req.url === '/api/delete-output' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = body ? JSON.parse(body) : {};
          const filename = typeof data.filename === 'string' ? data.filename : '';
          if (!filename.toLowerCase().endsWith('.pdf')) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Invalid filename' }));
            return;
          }

          const baseName = path.basename(filename, path.extname(filename));
          const outputDir = path.join(outputBaseDir, baseName);
          const resolvedOutput = path.resolve(outputDir);
          const resolvedBase = path.resolve(outputBaseDir);

          if (!resolvedOutput.startsWith(resolvedBase)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Invalid output path' }));
            return;
          }

          if (fs.existsSync(outputDir)) {
            fs.rmSync(outputDir, { recursive: true, force: true });
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    if (req.url.startsWith('/api/document-history/') && req.method === 'GET') {
      const docKeyRaw = req.url.replace('/api/document-history/', '').split('?')[0];
      const paths = getOutputDocumentPaths(outputBaseDir, docKeyRaw);
      if (!paths || !fs.existsSync(paths.docDir)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Document output folder not found' }));
        return;
      }

      const history = readHistoryEntries(paths.historyFile)
        .filter(entry => Number.isInteger(entry.version))
        .slice(-50)
        .reverse()
        .map(entry => ({
          timestamp: entry.timestamp,
          reason: entry.reason,
          version: entry.version,
          editsCount: Number.isInteger(entry.editsCount) ? entry.editsCount : 0,
          mergeCount: Number.isInteger(entry.mergeCount) ? entry.mergeCount : 0,
        }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, history }));
      return;
    }

    if (req.url.startsWith('/api/document-state/') && req.url.endsWith('/restore') && req.method === 'POST') {
      const docKeyRaw = req.url
        .replace('/api/document-state/', '')
        .replace(/\/restore(?:\?.*)?$/, '');
      const paths = getOutputDocumentPaths(outputBaseDir, docKeyRaw);
      if (!paths || !fs.existsSync(paths.docDir)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Document output folder not found' }));
        return;
      }

      readRequestBody(req)
        .then(body => {
          const payload = body ? JSON.parse(body) : {};
          const targetVersion = Number.isInteger(payload.version) ? payload.version : null;
          if (targetVersion === null) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'A numeric version is required' }));
            return;
          }

          let snapshot = { edits: {}, merges: [] };
          if (targetVersion !== 0) {
            const history = readHistoryEntries(paths.historyFile);
            const targetEntry = history.find(entry => entry && entry.version === targetVersion);
            if (!targetEntry) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'Version not found in history' }));
              return;
            }

            if (!targetEntry.state || typeof targetEntry.state !== 'object') {
              res.writeHead(409, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'Selected version cannot be restored (no snapshot available)' }));
              return;
            }

            snapshot = normalizeDocumentState(targetEntry.state || {});
          }

          const currentState = normalizeDocumentState(readJsonFileSafe(paths.editsFile, {
            version: 0,
            updatedAt: null,
            edits: {},
            merges: [],
          }));

          const restoredState = {
            version: currentState.version + 1,
            updatedAt: new Date().toISOString(),
            edits: snapshot.edits,
            merges: snapshot.merges,
          };

          writeJsonAtomic(paths.editsFile, restoredState);
          appendHistoryLine(paths.historyFile, {
            timestamp: restoredState.updatedAt,
            document: paths.docKey,
            reason: targetVersion === 0 ? 'restore:original' : `restore:${targetVersion}`,
            version: restoredState.version,
            editsCount: Object.keys(restoredState.edits).length,
            mergeCount: restoredState.merges.length,
            state: {
              edits: restoredState.edits,
              merges: restoredState.merges,
            },
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, state: restoredState }));
        })
        .catch(err => {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message || 'Invalid request body' }));
        });
      return;
    }

    if (req.url.startsWith('/api/document-state/') && req.method === 'GET') {
      const docKeyRaw = req.url.replace('/api/document-state/', '').split('?')[0];
      const paths = getOutputDocumentPaths(outputBaseDir, docKeyRaw);
      if (!paths || !fs.existsSync(paths.docDir)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Document output folder not found' }));
        return;
      }

      const currentState = normalizeDocumentState(readJsonFileSafe(paths.editsFile, {
        version: 0,
        updatedAt: null,
        edits: {},
        merges: [],
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, state: currentState }));
      return;
    }

    if (req.url.startsWith('/api/document-state/') && req.method === 'POST') {
      const docKeyRaw = req.url.replace('/api/document-state/', '').split('?')[0];
      const paths = getOutputDocumentPaths(outputBaseDir, docKeyRaw);
      if (!paths || !fs.existsSync(paths.docDir)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Document output folder not found' }));
        return;
      }

      readRequestBody(req)
        .then(body => {
          const payload = body ? JSON.parse(body) : {};
          const incomingState = normalizeDocumentState(payload.state || {});
          const clientVersion = Number.isInteger(payload.version) ? payload.version : 0;
          const reason = typeof payload.reason === 'string' ? payload.reason : 'save';

          const currentState = normalizeDocumentState(readJsonFileSafe(paths.editsFile, {
            version: 0,
            updatedAt: null,
            edits: {},
            merges: [],
          }));

          if (clientVersion !== currentState.version) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Version conflict', state: currentState }));
            return;
          }

          const nextState = {
            version: currentState.version + 1,
            updatedAt: new Date().toISOString(),
            edits: incomingState.edits,
            merges: incomingState.merges,
          };

          writeJsonAtomic(paths.editsFile, nextState);
          appendHistoryLine(paths.historyFile, {
            timestamp: nextState.updatedAt,
            document: paths.docKey,
            reason,
            version: nextState.version,
            editsCount: Object.keys(nextState.edits).length,
            mergeCount: nextState.merges.length,
            state: {
              edits: nextState.edits,
              merges: nextState.merges,
            },
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, state: nextState }));
        })
        .catch(err => {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message || 'Invalid request body' }));
        });
      return;
    }
    
    if (req.url === '/api/start-processing' && req.method === 'POST') {
      if (isProcessing) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Processing already in progress' }));
        return;
      }
      
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = body ? JSON.parse(body) : {};
          const formats = data.formats || { html: true, htmlHighlighted: true, canvas: true, text: true, csv: true, h5p: true, images: true };
          const selectedFiles = Array.isArray(data.selectedFiles) ? data.selectedFiles : null;

          if (selectedFiles && selectedFiles.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'No PDFs selected' }));
            return;
          }
          
          isProcessing = true;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
          
          // Start processing asynchronously
          processPDFsAsync(inputDir, outputBaseDir, formats, selectedFiles).finally(() => {
            isProcessing = false;
            shouldCancel = false;
          });
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid request body' }));
        }
      });
      return;
    }
    
    if (req.url === '/api/cancel' && req.method === 'POST') {
      shouldCancel = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Cancel requested' }));
      return;
    }
    
    if (req.url === '/api/progress') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write(`data: ${JSON.stringify(progressState)}\n\n`);
      progressClients.push(res);
      
      req.on('close', () => {
        progressClients = progressClients.filter(client => client !== res);
      });
      return;
    }
    
    // Serve the dashboard or menu at root
    if (req.url === '/' || req.url === '/index.html') {
      const inputFiles = fs.existsSync(inputDir) 
        ? fs.readdirSync(inputDir).filter(f => f.toLowerCase().endsWith('.pdf'))
        : [];
      
      // Show dashboard if we haven't processed yet or if there are new files to process
      if (inputFiles.length > 0 && !isProcessing) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(generateDashboardHTML(inputFiles, isProcessing));
      } else {
        // Show menu of converted files
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(generateMenuHTML(outputBaseDir));
      }
      return;
    }
    
    // Serve files from output directory
    if (req.url.startsWith('/output/')) {
      let decodedUrl = req.url;
      try {
        decodedUrl = decodeURIComponent(req.url);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>400 - Bad Request</h1>');
        return;
      }
      const relativePath = decodedUrl.replace(/^\/output\//, '');
      const safeRelativePath = path
        .normalize(relativePath)
        .replace(/^(\.\.(\/|\\|$))+/, '');
      const filePath = path.join(outputBaseDir, safeRelativePath);
      
      // Check if it's a directory (for images folder)
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        const files = fs.readdirSync(filePath);
        const dirListing = `<!DOCTYPE html>
<html>
<head><title>Directory: ${req.url}</title>
<style>
  body { font-family: 'Consolas', 'Monaco', monospace; padding: 20px; background: #0d1117; color: #c9d1d9; }
  h1 { color: #58a6ff; font-size: 1.2em; font-weight: normal; border-bottom: 1px solid #21262d; padding-bottom: 10px; }
  ul { list-style: none; padding: 0; }
  li { margin: 8px 0; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<h1>${req.url}</h1>
<ul>
  <li><a href="/">Back to Menu</a></li>
  ${files.map(file => `<li><a href="${req.url}/${file}" target="_blank">${file}</a></li>`).join('')}
</ul>
</body>
</html>`;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(dirListing);
        return;
      }
      
      // Serve individual files
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const contentTypes = {
          '.html': 'text/html',
          '.css': 'text/css',
          '.js': 'application/javascript',
          '.json': 'application/json',
          '.txt': 'text/plain',
          '.csv': 'text/csv',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.svg': 'image/svg+xml'
        };
        
        const contentType = contentTypes[ext] || 'application/octet-stream';
        const content = fs.readFileSync(filePath);
        
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
        return;
      }
    }
    
    // 404 Not Found
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<h1>404 - Not Found</h1>');
  });
  
  server.listen(port, () => {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Server started`);
    console.log(`Serving files from: ${outputBaseDir}`);
    console.log(`URL: http://localhost:${port}`);
    console.log(`${'='.repeat(50)}`);
    console.log(`\nPress Ctrl+C to stop the server\n`);
  });
}

/**
 * Main function to process all PDFs in the input folder
 */
async function main() {
  const inputDir = './input';
  const outputBaseDir = './output';

  // Create input and output directories if they don't exist
  if (!fs.existsSync(inputDir)) {
    fs.mkdirSync(inputDir, { recursive: true });
    console.log(`Created input directory: ${inputDir}`);
  }

  if (!fs.existsSync(outputBaseDir)) {
    fs.mkdirSync(outputBaseDir, { recursive: true });
  }

  // Start web server - user will start processing from dashboard
  startServer(outputBaseDir, 3000);
}

function startWithAutoRestart() {
  const entryFile = __filename;
  const workspaceDir = path.dirname(entryFile);
  const dashboardFile = path.join(workspaceDir, 'dashboard_new.html');
  const templatesDir = path.join(workspaceDir, 'templates');
  let childProcess = null;
  let restartPending = false;
  let shutdownRequested = false;
  let restartDebounceTimer = null;
  let templatesDirWatcher = null;

  const watchedFiles = [entryFile];
  if (fs.existsSync(dashboardFile) && fs.statSync(dashboardFile).isFile()) {
    watchedFiles.push(dashboardFile);
  }
  if (fs.existsSync(templatesDir) && fs.statSync(templatesDir).isDirectory()) {
    const templateFiles = fs.readdirSync(templatesDir)
      .map(name => path.join(templatesDir, name))
      .filter(filePath => fs.existsSync(filePath) && fs.statSync(filePath).isFile());
    watchedFiles.push(...templateFiles);
  }

  function launchChild() {
    childProcess = spawn(process.execPath, [entryFile], {
      stdio: 'inherit',
      env: { ...process.env, PDF_CONVERTER_CHILD: '1' },
    });

    childProcess.on('exit', (code, signal) => {
      if (shutdownRequested) {
        return;
      }

      if (restartPending) {
        restartPending = false;
        launchChild();
        return;
      }

      console.log(`[AutoRestart] Server exited (code=${code ?? 'null'} signal=${signal ?? 'none'}). Restarting...`);
      setTimeout(launchChild, 500);
    });
  }

  function restartChild(reason) {
    if (shutdownRequested || restartPending) {
      return;
    }

    restartPending = true;
    console.log(`[AutoRestart] ${reason}. Restarting server...`);

    if (childProcess && !childProcess.killed) {
      childProcess.kill('SIGTERM');
      setTimeout(() => {
        if (childProcess && !childProcess.killed) {
          childProcess.kill('SIGKILL');
        }
      }, 2000);
      return;
    }

    restartPending = false;
    launchChild();
  }

  watchedFiles.forEach(filePath => {
    fs.watchFile(filePath, { interval: 500 }, (current, previous) => {
      if (current.mtimeMs === previous.mtimeMs) {
        return;
      }

      if (restartDebounceTimer) {
        clearTimeout(restartDebounceTimer);
      }

      const relative = path.relative(workspaceDir, filePath) || path.basename(filePath);
      restartDebounceTimer = setTimeout(() => {
        restartChild(`Detected change in ${relative}`);
      }, 150);
    });
  });

  if (fs.existsSync(templatesDir) && fs.statSync(templatesDir).isDirectory()) {
    try {
      templatesDirWatcher = fs.watch(templatesDir, (_eventType, changedName) => {
        if (restartDebounceTimer) {
          clearTimeout(restartDebounceTimer);
        }

        restartDebounceTimer = setTimeout(() => {
          const suffix = changedName ? ` (${changedName})` : '';
          restartChild(`Detected change in templates/${suffix}`);
        }, 150);
      });
    } catch (err) {
      console.warn(`[AutoRestart] Unable to watch templates directory: ${err.message}`);
    }
  }

  function stopSupervisor(signalName) {
    shutdownRequested = true;
    watchedFiles.forEach(filePath => fs.unwatchFile(filePath));

    if (templatesDirWatcher) {
      templatesDirWatcher.close();
      templatesDirWatcher = null;
    }

    if (restartDebounceTimer) {
      clearTimeout(restartDebounceTimer);
    }

    if (childProcess && !childProcess.killed) {
      childProcess.kill(signalName);
    }

    process.exit(0);
  }

  process.on('SIGINT', () => stopSupervisor('SIGINT'));
  process.on('SIGTERM', () => stopSupervisor('SIGTERM'));

  const watchedSummary = watchedFiles.map(filePath => path.relative(workspaceDir, filePath) || path.basename(filePath)).join(', ');
  console.log(`[AutoRestart] Watching for changes: ${watchedSummary}`);
  if (fs.existsSync(templatesDir) && fs.statSync(templatesDir).isDirectory()) {
    console.log('[AutoRestart] Watching templates/ for file add/remove events.');
  }
  launchChild();
}

if (process.env.PDF_CONVERTER_CHILD === '1') {
  main().catch(console.error);
} else {
  startWithAutoRestart();
}
