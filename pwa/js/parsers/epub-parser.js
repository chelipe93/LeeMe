/**
 * Parser completo de archivos EPUB (EPUB 2 y EPUB 3) en Vanilla JS (hilo principal).
 * Utiliza ZipReader + DOMParser nativo para extraer metadatos, portada, imágenes,
 * HTML saneado y texto plano por capítulo.
 */
class EpubParser {
  constructor() {
    this.frontMatterPatterns = [
      /^cubierta$/i, /^cover$/i, /^portada$/i, /^t[ií]tulo$/i,
      /^sinopsis$/i, /^dedicatoria$/i, /^informaci[oó]n$/i, /^cr[eé]ditos$/i,
      /^sobre\s+el\s+autor/i, /^sobre\s+la\s+autora/i, /^biograf[ií]a$/i,
      /^notas\s+del\s+editor/i, /^ex\s+libris/i, /^copyright/i, /^colof[oó]n$/i
    ];
  }

  async parse(arrayBuffer) {
    const zip = await ZipReader.fromBuffer(arrayBuffer);

    const containerXml = await zip.getText('META-INF/container.xml');
    if (!containerXml) {
      throw new Error('EPUB inválido: falta META-INF/container.xml');
    }

    const opfPath = this._findOpfPath(containerXml);
    const opfXml = await zip.getText(opfPath);
    if (!opfXml) {
      throw new Error(`EPUB inválido: no se encontró el archivo OPF (${opfPath})`);
    }

    const opfDir = this._dirname(opfPath);
    const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml');

    const metadata = this._extractMetadata(opfDoc);
    const manifest = this._extractManifest(opfDoc, opfDir);
    const spine = this._extractSpine(opfDoc, manifest);
    const tocMap = await this._extractTocMap(zip, opfDoc, manifest);

    // Extraer portada e imágenes como Blobs
    const coverBlob = await this._extractCoverBlob(zip, opfDoc, manifest);
    const assets = await this._extractImageAssets(zip, manifest);

    // Parsear capítulos en orden del spine
    const chapters = [];
    let currentPart = null;
    let chapterIdx = 0;
    let totalWords = 0;

    for (const item of spine) {
      const zipEntry = item.full_path;
      const xhtml = await zip.getText(zipEntry);
      if (xhtml === null) continue;

      chapterIdx++;
      const href = item.href;
      const tocLabel = tocMap[href] || tocMap[zipEntry] || null;

      const parsedDoc = this._parseChapterHtml(xhtml, this._dirnameRaw(zipEntry));
      const rawTitle = this._cleanWhitespace(tocLabel || parsedDoc.heading || parsedDoc.title || `Sección ${chapterIdx}`);
      const plainText = parsedDoc.plain_text;
      const wordCount = this._countWords(plainText);

      const isPartDivider = wordCount > 0 && wordCount <= 25 &&
        /^(?:parte\s+|libro\s+|uno|dos|tres|cuatro|cinco|primera|segunda|tercera)/i.test(rawTitle);
      if (isPartDivider) {
        currentPart = this._ucfirst(rawTitle.toLowerCase());
      }

      let isFrontMatter = this._isFrontMatter(rawTitle, href, wordCount, metadata.title);
      if (isPartDivider) isFrontMatter = true;

      let displayTitle = rawTitle;
      const isEpilogue = /^(?:ep[ií]logo|pr[oó]logo|introducci[oó]n|anexo|ap[eé]ndice)/i.test(rawTitle);
      if (!isFrontMatter && !isEpilogue && currentPart !== null) {
        const startsWithPart = rawTitle.toLowerCase().startsWith(currentPart.toLowerCase());
        if (!startsWithPart) {
          displayTitle = rawTitle.length <= 12
            ? `Parte ${currentPart} · Capítulo ${rawTitle}`
            : `${currentPart} · ${rawTitle}`;
        }
      }

      totalWords += wordCount;

      chapters.push({
        chapter_index: chapterIdx,
        part_title: isFrontMatter ? null : currentPart,
        title: rawTitle,
        display_title: displayTitle,
        href: zipEntry,
        is_front_matter: isFrontMatter ? 1 : 0,
        word_count: wordCount,
        html_content: parsedDoc.body_html,
        plain_text: plainText
      });
    }

    return {
      metadata,
      cover_blob: coverBlob,
      assets,
      chapters,
      total_words: totalWords
    };
  }

  _findOpfPath(containerXml) {
    const doc = new DOMParser().parseFromString(containerXml, 'application/xml');
    const rf = doc.querySelector('rootfile');
    const fullPath = rf ? rf.getAttribute('full-path') : '';
    if (!fullPath) {
      throw new Error('No se encontró rootfile en container.xml');
    }
    return fullPath;
  }

  _extractMetadata(opfDoc) {
    const getDc = (tag) => {
      const nodes = opfDoc.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', tag);
      if (nodes.length > 0 && nodes[0].textContent) {
        return this._cleanWhitespace(nodes[0].textContent);
      }
      const fallback = opfDoc.querySelector(tag);
      return fallback ? this._cleanWhitespace(fallback.textContent || '') : '';
    };

    return {
      title: getDc('title') || 'Libro sin título',
      author: getDc('creator') || 'Autor desconocido',
      language: getDc('language') || 'es',
      publisher: getDc('publisher') || null,
      description: getDc('description') || null
    };
  }

  _extractManifest(opfDoc, opfDir) {
    const manifest = {};
    const items = opfDoc.querySelectorAll('manifest > item');
    for (const item of items) {
      const id = item.getAttribute('id') || '';
      let href = item.getAttribute('href') || '';
      try { href = decodeURIComponent(href); } catch (_) {}
      const mediaType = item.getAttribute('media-type') || '';
      const properties = item.getAttribute('properties') || '';
      manifest[id] = {
        id,
        href,
        full_path: this._normalizeZipPath(opfDir + href),
        media_type: mediaType,
        properties
      };
    }
    return manifest;
  }

  _extractSpine(opfDoc, manifest) {
    const spine = [];
    const refs = opfDoc.querySelectorAll('spine > itemref');
    for (const ref of refs) {
      const idref = ref.getAttribute('idref') || '';
      if (manifest[idref]) {
        spine.push(manifest[idref]);
      }
    }
    return spine;
  }

  async _extractTocMap(zip, opfDoc, manifest) {
    const map = {};
    const spineEl = opfDoc.querySelector('spine');
    const ncxId = spineEl ? spineEl.getAttribute('toc') : '';

    if (ncxId && manifest[ncxId]) {
      const ncxPath = manifest[ncxId].full_path;
      const ncxXml = await zip.getText(ncxPath);
      if (ncxXml) {
        const ncxDir = this._dirname(ncxPath);
        const doc = new DOMParser().parseFromString(ncxXml, 'application/xml');
        const navPoints = doc.querySelectorAll('navPoint');
        for (const np of navPoints) {
          const txtEl = np.querySelector('navLabel > text');
          const contentEl = np.querySelector('content');
          const label = txtEl ? txtEl.textContent.trim() : '';
          let src = contentEl ? (contentEl.getAttribute('src') || '') : '';
          try { src = decodeURIComponent(src); } catch (_) {}
          const srcNoFrag = src.split('#')[0];
          if (label && srcNoFrag) {
            const full = this._normalizeZipPath(ncxDir + srcNoFrag);
            if (!map[srcNoFrag]) map[srcNoFrag] = label;
            if (!map[full]) map[full] = label;
          }
        }
      }
    }

    if (Object.keys(map).length === 0) {
      for (const item of Object.values(manifest)) {
        if (item.properties.includes('nav')) {
          const navHtml = await zip.getText(item.full_path);
          if (navHtml) {
            const navDir = this._dirname(item.full_path);
            const doc = new DOMParser().parseFromString(navHtml, 'text/html');
            for (const a of doc.querySelectorAll('a')) {
              let href = a.getAttribute('href') || '';
              try { href = decodeURIComponent(href); } catch (_) {}
              const srcNoFrag = href.split('#')[0];
              const label = (a.textContent || '').trim();
              if (srcNoFrag && label) {
                const full = this._normalizeZipPath(navDir + srcNoFrag);
                if (!map[full]) map[full] = label;
              }
            }
          }
          break;
        }
      }
    }
    return map;
  }

  async _extractCoverBlob(zip, opfDoc, manifest) {
    let coverItem = null;
    for (const item of Object.values(manifest)) {
      if (item.properties.includes('cover-image')) {
        coverItem = item;
        break;
      }
    }
    if (!coverItem) {
      for (const meta of opfDoc.querySelectorAll('metadata > meta')) {
        if ((meta.getAttribute('name') || '').toLowerCase() === 'cover') {
          const cid = meta.getAttribute('content') || '';
          if (manifest[cid]) {
            coverItem = manifest[cid];
            break;
          }
        }
      }
    }
    if (!coverItem) {
      for (const item of Object.values(manifest)) {
        if (item.media_type.startsWith('image/') && item.href.toLowerCase().includes('cover')) {
          coverItem = item;
          break;
        }
      }
    }
    if (!coverItem) return null;
    const bytes = await zip.getBytes(coverItem.full_path);
    if (!bytes) return null;
    return new Blob([bytes], { type: coverItem.media_type || 'image/jpeg' });
  }

  async _extractImageAssets(zip, manifest) {
    const assets = [];
    for (const item of Object.values(manifest)) {
      if (!item.media_type.startsWith('image/')) continue;
      const bytes = await zip.getBytes(item.full_path);
      if (!bytes) continue;
      assets.push({
        path: item.full_path,
        mime: item.media_type,
        blob: new Blob([bytes], { type: item.media_type })
      });
    }
    return assets;
  }

  _parseChapterHtml(xhtml, chapterZipDir) {
    const doc = new DOMParser().parseFromString(xhtml, 'text/html');
    const titleEl = doc.querySelector('title');
    const title = titleEl ? titleEl.textContent.trim() : '';
    const body = doc.body || doc.documentElement;

    // Eliminar etiquetas no seguras
    for (const badTag of ['script', 'iframe', 'object', 'embed', 'style']) {
      for (const node of Array.from(doc.querySelectorAll(badTag))) {
        node.remove();
      }
    }

    const dirPrefix = (!chapterZipDir || chapterZipDir === '.') ? '' : `${chapterZipDir}/`;

    // Reescribir imágenes para resolverlas desde IndexedDB al abrir el lector
    for (const img of doc.querySelectorAll('img')) {
      let src = img.getAttribute('src') || '';
      try { src = decodeURIComponent(src); } catch (_) {}
      if (src && !/^(?:https?:|data:)/i.test(src)) {
        const resolved = this._normalizeZipPath(dirPrefix + src);
        img.setAttribute('data-epub-asset', resolved);
        img.setAttribute('src', '');
        img.setAttribute('loading', 'lazy');
      }
    }
    for (const img of doc.querySelectorAll('image')) {
      let href = img.getAttribute('xlink:href') || img.getAttribute('href') || '';
      try { href = decodeURIComponent(href); } catch (_) {}
      if (href && !/^(?:https?:|data:)/i.test(href)) {
        const resolved = this._normalizeZipPath(dirPrefix + href);
        img.setAttribute('data-epub-asset', resolved);
      }
    }

    let heading = '';
    for (const hTag of ['h1', 'h2', 'h3']) {
      const h = doc.querySelector(hTag);
      if (h && h.textContent.trim()) {
        heading = h.textContent.trim();
        break;
      }
    }

    const blocks = [];
    if (body) this._collectTextBlocks(body, blocks);
    let plainText = blocks.join('\n\n').normalize('NFC');
    if (!plainText.trim() && body) {
      plainText = this._cleanWhitespace(body.textContent || '');
    }

    return {
      title,
      heading,
      body_html: body ? body.innerHTML.trim() : '',
      plain_text: plainText
    };
  }

  _collectTextBlocks(node, blocks) {
    const blockTags = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'li']);
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.nodeName.toLowerCase();
      if (blockTags.has(tag)) {
        let hasBlockChild = false;
        for (const ch of node.children) {
          if (blockTags.has(ch.nodeName.toLowerCase())) {
            hasBlockChild = true;
            break;
          }
        }
        if (!hasBlockChild) {
          const txt = this._cleanWhitespace(node.textContent || '');
          if (txt) blocks.push(txt);
          return;
        }
      }
    }
    for (const ch of node.childNodes) {
      this._collectTextBlocks(ch, blocks);
    }
  }

  _isFrontMatter(title, href, wordCount, bookTitle) {
    if (wordCount < 60) return true;
    const norm = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (norm(title) === norm(bookTitle) && wordCount < 300) return true;
    for (const pat of this.frontMatterPatterns) {
      if (pat.test(title)) return true;
    }
    const base = (href.split('/').pop() || '').toLowerCase();
    if (/^(?:cubierta|cover|titulo|title|info|sinopsis|dedicatoria|autor|copyright|nav|toc)\./.test(base)) {
      return true;
    }
    return false;
  }

  _dirname(path) {
    const idx = path.lastIndexOf('/');
    return idx === -1 ? '' : path.slice(0, idx + 1);
  }

  _dirnameRaw(path) {
    const idx = path.lastIndexOf('/');
    return idx === -1 ? '' : path.slice(0, idx);
  }

  _normalizeZipPath(path) {
    const parts = path.replace(/\\/g, '/').split('/');
    const stack = [];
    for (const p of parts) {
      if (!p || p === '.') continue;
      if (p === '..') stack.pop();
      else stack.push(p);
    }
    return stack.join('/');
  }

  _cleanWhitespace(str) {
    return (str || '').replace(/\u00a0/g, ' ').replace(/[\t\r]/g, ' ').replace(/ {2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  _countWords(text) {
    const m = (text || '').match(/[\p{L}]+(?:-[\p{L}]+)*/gu);
    return m ? m.length : 0;
  }

  _ucfirst(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
  }
}

window.EpubParser = EpubParser;
