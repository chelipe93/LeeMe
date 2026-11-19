/**
 * Extractor de texto PDF 1.4 - 1.7 en Vanilla JS para Web Worker (sin dependencias).
 * Soporta /ObjStm, /FlateDecode (DecompressionStream), fuentes Type0/CID 2-byte,
 * mapas /ToUnicode CMap, fallback WinAnsi y ordenación visual (x, y).
 */
(function (root) {
  const BiblioWorker = (root.BiblioWorker = root.BiblioWorker || {});

  class PdfParser {
    constructor() {
      this.objects = new Map();
      this.rawStreams = new Map();
      this.cmapCache = new Map();
      this.winAnsiDecoder = new TextDecoder('windows-1252');
    }

    async extractPages(arrayBuffer) {
      const rawBytes = new Uint8Array(arrayBuffer);
      const rawStr = new TextDecoder('latin1').decode(rawBytes);
      if (!rawStr.startsWith('%PDF')) {
        throw new Error('El archivo no es un PDF válido.');
      }

      this.objects.clear();
      this.rawStreams.clear();
      this.cmapCache.clear();

      this._parseAllObjects(rawStr, rawBytes);
      await this._unpackObjectStreams();

      const pageIds = this._findPageObjectIds();
      const pages = [];
      let pageNum = 0;

      for (const pageId of pageIds) {
        pageNum++;
        const pageBody = this.objects.get(pageId) || '';
        const fontMap = await this._extractPageFonts(pageBody);
        const contentStream = await this._extractPageContentStream(pageBody);
        const lines = this._parseContentStreamToLines(contentStream, fontMap);

        pages.push({
          page: pageNum,
          lines,
          text: lines.map((l) => l.text).join('\n')
        });
      }

      return pages;
    }

    _parseAllObjects(rawStr, rawBytes) {
      const objRe = /(\d+)\s+\d+\s+obj\b/g;
      let m;
      let searchFrom = 0;

      while (true) {
        objRe.lastIndex = searchFrom;
        m = objRe.exec(rawStr);
        if (!m) break;

        const objId = parseInt(m[1], 10);
        const startPos = m.index + m[0].length;
        const endPos = rawStr.indexOf('endobj', startPos);
        if (endPos === -1) break;

        const body = rawStr.slice(startPos, endPos);
        this.objects.set(objId, body);

        const streamMatch = /(?:>>|\s)stream(?:\r\n|\n|\r)/.exec(body);
        if (streamMatch) {
          const sStartRel = streamMatch.index + streamMatch[0].length;
          const sEndRel = body.lastIndexOf('endstream');
          if (sEndRel !== -1 && sEndRel >= sStartRel) {
            let absStart = startPos + sStartRel;
            let absEnd = startPos + sEndRel;
            // Remover salto de línea previo a endstream
            if (absEnd >= absStart + 2 && rawBytes[absEnd - 2] === 13 && rawBytes[absEnd - 1] === 10) {
              absEnd -= 2;
            } else if (absEnd >= absStart + 1 && (rawBytes[absEnd - 1] === 10 || rawBytes[absEnd - 1] === 13)) {
              absEnd -= 1;
            }
            this.rawStreams.set(objId, rawBytes.subarray(absStart, absEnd));
          }
        }

        searchFrom = endPos + 6;
      }
    }

    async _unpackObjectStreams() {
      const latin = new TextDecoder('latin1');
      for (const [id, body] of this.objects.entries()) {
        if (!body.includes('/ObjStm') || !this.rawStreams.has(id)) continue;
        const dataBytes = await this._decompressStreamBytes(id);
        if (!dataBytes) continue;

        const fm = /\/First\s+(\d+)/.exec(body);
        if (!fm) continue;
        const first = parseInt(fm[1], 10);

        const dataStr = latin.decode(dataBytes);
        const header = dataStr.slice(0, first).trim();
        const content = dataStr.slice(first);

        const tokens = header.split(/\s+/);
        const entries = [];
        for (let i = 0; i + 1 < tokens.length; i += 2) {
          entries.push([parseInt(tokens[i], 10), parseInt(tokens[i + 1], 10)]);
        }

        for (let i = 0; i < entries.length; i++) {
          const subId = entries[i][0];
          const subStart = entries[i][1];
          const subEnd = i + 1 < entries.length ? entries[i + 1][1] : content.length;
          if (!this.objects.has(subId)) {
            this.objects.set(subId, content.slice(subStart, subEnd).trim());
          }
        }
      }
    }

    async _decompressStreamBytes(objId) {
      const raw = this.rawStreams.get(objId);
      if (!raw) return null;
      const body = this.objects.get(objId) || '';

      if (!body.includes('/FlateDecode')) {
        return raw;
      }

      const tryDecompress = async (format, inputBytes) => {
        const ds = new DecompressionStream(format);
        const writer = ds.writable.getWriter();
        writer.write(inputBytes);
        writer.close().catch(() => {});

        const reader = ds.readable.getReader();
        const chunks = [];
        let total = 0;
        let streamFailed = false;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              chunks.push(value);
              total += value.length;
            }
          }
        } catch (_) {
          streamFailed = true;
        }
        if (total > 0 && (!streamFailed || chunks.length > 0)) {
          const out = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) {
            out.set(c, off);
            off += c.length;
          }
          return out;
        }
        return null;
      };

      let out = await tryDecompress('deflate', raw);
      if (!out && raw.length > 2) {
        out = await tryDecompress('deflate-raw', raw.subarray(2));
      }
      if (!out) {
        out = await tryDecompress('deflate-raw', raw);
      }
      return out;
    }

    async _decompressStreamText(objId) {
      const bytes = await this._decompressStreamBytes(objId);
      if (!bytes) return null;
      return new TextDecoder('latin1').decode(bytes);
    }

    _findPageObjectIds() {
      let rootPagesId = null;
      for (const body of this.objects.values()) {
        if (/\/Type\s*\/Catalog\b/.test(body)) {
          const m = /\/Pages\s+(\d+)\s+\d+\s+R/.exec(body);
          if (m) {
            rootPagesId = parseInt(m[1], 10);
            break;
          }
        }
      }

      const pages = [];
      if (rootPagesId !== null) {
        this._collectPagesRecursive(rootPagesId, pages, 0);
      }

      if (pages.length === 0) {
        for (const [id, body] of this.objects.entries()) {
          if (/\/Type\s*\/Page\b(?!s)/.test(body)) {
            pages.push(id);
          }
        }
      }
      return pages;
    }

    _collectPagesRecursive(nodeId, pages, depth) {
      if (depth > 20 || !this.objects.has(nodeId)) return;
      const body = this.objects.get(nodeId);
      const km = /\/Kids\s*\[([\s\S]*?)\]/.exec(body);
      if (km) {
        const refRe = /(\d+)\s+\d+\s+R/g;
        let rm;
        while ((rm = refRe.exec(km[1])) !== null) {
          this._collectPagesRecursive(parseInt(rm[1], 10), pages, depth + 1);
        }
        return;
      }
      if (/\/Type\s*\/Page\b(?!s)/.test(body)) {
        pages.push(nodeId);
      }
    }

    async _extractPageFonts(pageBody) {
      let resDict = '';
      let rm = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(pageBody);
      if (rm) {
        resDict = this.objects.get(parseInt(rm[1], 10)) || '';
      } else {
        rm = /\/Resources\s*<<([\s\S]*?)>>/.exec(pageBody);
        if (rm) resDict = rm[1];
      }

      if (!resDict) {
        const pm = /\/Parent\s+(\d+)\s+\d+\s+R/.exec(pageBody);
        if (pm) {
          const parentBody = this.objects.get(parseInt(pm[1], 10)) || '';
          const prm = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(parentBody);
          if (prm) resDict = this.objects.get(parseInt(prm[1], 10)) || '';
        }
      }

      let fontDictStr = '';
      let fm = /\/Font\s+(\d+)\s+\d+\s+R/.exec(resDict);
      if (fm) {
        fontDictStr = this.objects.get(parseInt(fm[1], 10)) || '';
      } else {
        fm = /\/Font\s*<<([\s\S]*?)>>/.exec(resDict);
        if (fm) fontDictStr = fm[1];
      }

      const fonts = {};
      const fRe = /\/([A-Za-z0-9_]+)\s+(\d+)\s+\d+\s+R/g;
      let match;
      while ((match = fRe.exec(fontDictStr)) !== null) {
        fonts[match[1]] = await this._loadFontInfo(parseInt(match[2], 10));
      }
      return fonts;
    }

    async _loadFontInfo(fontObjId) {
      const body = this.objects.get(fontObjId) || '';
      const isCid = body.includes('/Type0') || body.includes('/Identity-H') || body.includes('/DescendantFonts');
      let cmap = null;
      const tm = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(body);
      if (tm) {
        cmap = await this._parseToUnicodeCMap(parseInt(tm[1], 10));
      }
      return {
        id: fontObjId,
        is_cid: isCid || (cmap !== null && cmap.bytes === 2),
        cmap,
        is_bold: /Bold/i.test(body)
      };
    }

    async _parseToUnicodeCMap(cmapObjId) {
      if (this.cmapCache.has(cmapObjId)) {
        return this.cmapCache.get(cmapObjId);
      }
      const stream = await this._decompressStreamText(cmapObjId);
      if (!stream) return null;

      const map = new Map();
      let bytes = 1;

      const csMatch = /begincodespacerange\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/.exec(stream);
      if (csMatch) {
        bytes = Math.max(1, Math.floor(csMatch[1].length / 2));
      }

      const bfCharRe = /beginbfchar([\s\S]*?)endbfchar/g;
      let blk;
      while ((blk = bfCharRe.exec(stream)) !== null) {
        const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
        let p;
        while ((p = pairRe.exec(blk[1])) !== null) {
          const src = parseInt(p[1], 16);
          map.set(src, this._hexUtf16ToStr(p[2]));
          if (p[1].length >= 4) bytes = 2;
        }
      }

      const bfRangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
      while ((blk = bfRangeRe.exec(stream)) !== null) {
        const scalarRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
        let r;
        while ((r = scalarRe.exec(blk[1])) !== null) {
          const start = parseInt(r[1], 16);
          const end = parseInt(r[2], 16);
          const dstStart = parseInt(r[3], 16);
          if (r[1].length >= 4) bytes = 2;
          const limit = Math.min(end, start + 4096);
          for (let code = start; code <= limit; code++) {
            map.set(code, BiblioWorker.Utf8Helper.codePointToUtf8Str(dstStart + (code - start)));
          }
        }

        const arrRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g;
        while ((r = arrRe.exec(blk[1])) !== null) {
          const start = parseInt(r[1], 16);
          if (r[1].length >= 4) bytes = 2;
          const hexRe = /<([0-9A-Fa-f]+)>/g;
          let h;
          let idx = 0;
          while ((h = hexRe.exec(r[3])) !== null) {
            map.set(start + idx, this._hexUtf16ToStr(h[1]));
            idx++;
          }
        }
      }

      const res = { bytes, map };
      this.cmapCache.set(cmapObjId, res);
      return res;
    }

    _hexUtf16ToStr(hex) {
      if (hex.length % 4 !== 0) {
        return BiblioWorker.Utf8Helper.codePointToUtf8Str(parseInt(hex, 16));
      }
      let out = '';
      for (let i = 0; i < hex.length; i += 4) {
        let cp = parseInt(hex.slice(i, i + 4), 16);
        if (cp >= 0xd800 && cp <= 0xdbff && i + 4 < hex.length) {
          const low = parseInt(hex.slice(i + 4, i + 8), 16);
          if (low >= 0xdc00 && low <= 0xdfff) {
            cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
            i += 4;
          }
        }
        out += BiblioWorker.Utf8Helper.codePointToUtf8Str(cp);
      }
      return out;
    }

    async _extractPageContentStream(pageBody) {
      const streams = [];
      const single = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(pageBody);
      if (single) {
        const s = await this._decompressStreamText(parseInt(single[1], 10));
        if (s !== null) streams.push(s);
      } else {
        const arr = /\/Contents\s*\[([\s\S]*?)\]/.exec(pageBody);
        if (arr) {
          const refRe = /(\d+)\s+\d+\s+R/g;
          let rm;
          while ((rm = refRe.exec(arr[1])) !== null) {
            const s = await this._decompressStreamText(parseInt(rm[1], 10));
            if (s !== null) streams.push(s);
          }
        }
      }
      return streams.join('\n');
    }

    _parseContentStreamToLines(stream, fontMap) {
      if (!stream) return [];
      const runs = [];
      let currentFont = '';
      let currentSize = 12.0;
      let pos = 0;
      const len = stream.length;

      while (pos < len) {
        const btPos = this._findOperator(stream, 'BT', pos);
        if (btPos === -1) break;
        const etPos = this._findOperator(stream, 'ET', btPos + 2);
        if (etPos === -1) break;

        const block = stream.slice(btPos + 2, etPos);
        pos = etPos + 2;

        let tx = 0.0, ty = 0.0, tl = 0.0;
        let blockFont = currentFont;
        let blockSize = currentSize;

        const tokens = this._tokenizePdfStream(block);
        let operands = [];
        let lineText = '';
        let lineX = null;
        let lineY = null;
        let lineFont = blockFont;
        let lineSize = blockSize;

        const flushRun = () => {
          const norm = BiblioWorker.Utf8Helper.normalizeNfc(lineText);
          if (norm.trim() !== '') {
            runs.push({
              text: norm,
              x: lineX !== null ? lineX : 0.0,
              y: lineY !== null ? lineY : 0.0,
              font: lineFont,
              size: lineSize
            });
          }
          lineText = '';
          lineX = null;
          lineY = null;
        };

        for (const tok of tokens) {
          if (tok.type !== 'op') {
            operands.push(tok);
            continue;
          }

          const op = tok.val;
          if (op === 'Tf' && operands.length >= 2) {
            const fTok = operands[operands.length - 2];
            const sTok = operands[operands.length - 1];
            blockFont = String(fTok.val).replace(/^\/+/, '');
            blockSize = Number(sTok.val) || 12;
            currentFont = blockFont;
            currentSize = blockSize;
          } else if (op === 'TL' && operands.length >= 1) {
            tl = Number(operands[operands.length - 1].val) || 0;
          } else if ((op === 'Td' || op === 'TD') && operands.length >= 2) {
            const dx = Number(operands[operands.length - 2].val) || 0;
            const dy = Number(operands[operands.length - 1].val) || 0;
            if (op === 'TD') tl = -dy;
            if (lineText !== '' && Math.abs(dy) > 1.0) flushRun();
            tx += dx;
            ty += dy;
          } else if (op === 'Tm' && operands.length >= 6) {
            const nx = Number(operands[operands.length - 2].val) || 0;
            const ny = Number(operands[operands.length - 1].val) || 0;
            if (lineText !== '' && Math.abs(ny - ty) > 1.0) flushRun();
            tx = nx;
            ty = ny;
          } else if (op === 'T*') {
            if (lineText !== '') flushRun();
            ty -= tl;
          } else if (op === 'Tj' || op === "'" || op === '"') {
            if (op === "'" || op === '"') {
              if (lineText !== '') flushRun();
              ty -= tl;
            }
            if (operands.length > 0) {
              const strTok = operands[operands.length - 1];
              const decoded = this._decodeTextToken(strTok, fontMap[blockFont] || null);
              if (lineX === null) {
                lineX = tx; lineY = ty; lineFont = blockFont; lineSize = blockSize;
              }
              lineText += decoded;
            }
          } else if (op === 'TJ' && operands.length > 0) {
            const arrTok = operands[operands.length - 1];
            if (arrTok.type === 'array') {
              if (lineX === null) {
                lineX = tx; lineY = ty; lineFont = blockFont; lineSize = blockSize;
              }
              for (const item of arrTok.val) {
                if (item.type === 'str' || item.type === 'hex') {
                  lineText += this._decodeTextToken(item, fontMap[blockFont] || null);
                } else if (item.type === 'num' && Number(item.val) < -180) {
                  lineText += ' ';
                }
              }
            }
          }
          operands = [];
        }
        flushRun();
      }

      runs.sort((a, b) => {
        if (Math.abs(a.y - b.y) > 4.0) return b.y - a.y;
        return a.x - b.x;
      });

      const lines = [];
      for (const run of runs) {
        const last = lines[lines.length - 1];
        if (last && Math.abs(last.y - run.y) <= 4.0) {
          const prev = last.text;
          const next = run.text;
          if (prev && !prev.endsWith(' ') && next && !next.startsWith(' ')) {
            last.text += ' ' + next;
          } else {
            last.text += next;
          }
        } else {
          lines.push({ ...run });
        }
      }

      return lines
        .map((l) => ({ ...l, text: l.text.replace(/[ \t]+/g, ' ').trim() }))
        .filter((l) => l.text !== '');
    }

    _isSpace(ch) {
      return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\x00';
    }

    _findOperator(stream, op, offset) {
      const len = stream.length;
      const opLen = op.length;
      let inStr = false;
      let parenDepth = 0;

      for (let i = offset; i < len; i++) {
        const ch = stream[i];
        if (inStr) {
          if (ch === '\\') { i++; continue; }
          if (ch === '(') parenDepth++;
          else if (ch === ')') {
            parenDepth--;
            if (parenDepth <= 0) inStr = false;
          }
          continue;
        }
        if (ch === '(') {
          inStr = true;
          parenDepth = 1;
          continue;
        }
        if (stream.startsWith(op, i)) {
          const before = i === 0 ? ' ' : stream[i - 1];
          const after = i + opLen >= len ? ' ' : stream[i + opLen];
          if (this._isSpace(before) && this._isSpace(after)) return i;
        }
      }
      return -1;
    }

    _tokenizePdfStream(s) {
      const tokens = [];
      const len = s.length;
      let i = 0;

      while (i < len) {
        const c = s[i];
        if (this._isSpace(c)) { i++; continue; }
        if (c === '%') {
          while (i < len && s[i] !== '\n' && s[i] !== '\r') i++;
          continue;
        }
        if (c === '(') {
          i++;
          let depth = 1;
          let buf = '';
          while (i < len && depth > 0) {
            const ch = s[i];
            if (ch === '\\' && i + 1 < len) {
              const next = s[i + 1];
              if (next === '\r' || next === '\n') {
                i += 2;
                if (next === '\r' && i < len && s[i] === '\n') i++;
                continue;
              }
              if (next >= '0' && next <= '7') {
                let oct = next;
                i += 2;
                for (let k = 0; k < 2 && i < len && s[i] >= '0' && s[i] <= '7'; k++) {
                  oct += s[i++];
                }
                buf += String.fromCharCode(parseInt(oct, 8) & 0xff);
                continue;
              }
              const escMap = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
              buf += escMap[next] !== undefined ? escMap[next] : next;
              i += 2;
              continue;
            }
            if (ch === '(') { depth++; buf += ch; }
            else if (ch === ')') {
              depth--;
              if (depth > 0) buf += ch;
            } else {
              buf += ch;
            }
            i++;
          }
          tokens.push({ type: 'str', val: buf });
          continue;
        }
        if (c === '<' && (i + 1 >= len || s[i + 1] !== '<')) {
          const end = s.indexOf('>', i + 1);
          if (end === -1) break;
          const hex = s.slice(i + 1, end).replace(/\s+/g, '');
          tokens.push({ type: 'hex', val: hex });
          i = end + 1;
          continue;
        }
        if (c === '[') {
          i++;
          let depth = 1, inLit = false, pDepth = 0;
          const startArr = i;
          while (i < len && depth > 0) {
            const ch = s[i];
            if (inLit) {
              if (ch === '\\') { i += 2; continue; }
              if (ch === '(') pDepth++;
              else if (ch === ')') {
                pDepth--;
                if (pDepth <= 0) inLit = false;
              }
              i++;
              continue;
            }
            if (ch === '(') { inLit = true; pDepth = 1; }
            else if (ch === '[') depth++;
            else if (ch === ']') {
              depth--;
              if (depth === 0) break;
            }
            i++;
          }
          const subBuf = s.slice(startArr, i);
          tokens.push({ type: 'array', val: this._tokenizePdfStream(subBuf) });
          i++;
          continue;
        }
        if (c === '/') {
          const start = i++;
          while (i < len && !this._isSpace(s[i]) && !'()<>[]{}/%'.includes(s[i])) i++;
          tokens.push({ type: 'name', val: s.slice(start, i) });
          continue;
        }

        const start = i;
        while (i < len && !this._isSpace(s[i]) && !'()<>[]{}/%'.includes(s[i])) i++;
        const word = s.slice(start, i);
        const num = Number(word);
        if (word !== '' && !Number.isNaN(num) && /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(word)) {
          tokens.push({ type: 'num', val: num });
        } else {
          tokens.push({ type: 'op', val: word });
        }
      }
      return tokens;
    }

    _decodeTextToken(tok, fontInfo) {
      let rawBytes;
      if (tok.type === 'hex') {
        let hex = tok.val;
        if (hex.length % 2 === 1) hex += '0';
        rawBytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < rawBytes.length; i++) {
          rawBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
        }
      } else if (tok.type === 'str') {
        rawBytes = new Uint8Array(tok.val.length);
        for (let i = 0; i < tok.val.length; i++) {
          rawBytes[i] = tok.val.charCodeAt(i) & 0xff;
        }
      } else {
        return '';
      }

      if (fontInfo && fontInfo.cmap) {
        const cmap = fontInfo.cmap;
        const map = cmap.map;
        let out = '';
        if (cmap.bytes === 2) {
          for (let i = 0; i + 1 < rawBytes.length; i += 2) {
            const code = (rawBytes[i] << 8) | rawBytes[i + 1];
            if (map.has(code)) out += map.get(code);
            else if (code === 0x0003) out += ' ';
            else if (code >= 0x20 && code <= 0x7e) out += String.fromCharCode(code);
          }
          return out;
        }
        for (let i = 0; i < rawBytes.length; i++) {
          const code = rawBytes[i];
          if (map.has(code)) out += map.get(code);
          else if (code >= 0x20 && code <= 0x7e) out += String.fromCharCode(code);
        }
        return out;
      }

      return this.winAnsiDecoder.decode(rawBytes);
    }
  }

  BiblioWorker.PdfParser = PdfParser;
})(self);
