/**
 * Capa de persistencia local 100% offline sobre IndexedDB para LeeMe PWA.
 * Replica el esquema relacional de database/schema.sql incluyendo blobs de portada e imágenes.
 */
class BiblioDB {
  constructor() {
    this.dbName = 'leeme_offline_v1';
    this.version = 1;
    this.db = null;
  }

  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, this.version);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('books')) {
          db.createObjectStore('books', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('chapters')) {
          const st = db.createObjectStore('chapters', { keyPath: 'id', autoIncrement: true });
          st.createIndex('by_book', 'book_id', { unique: false });
        }
        if (!db.objectStoreNames.contains('notes')) {
          const st = db.createObjectStore('notes', { keyPath: 'id', autoIncrement: true });
          st.createIndex('by_book', 'book_id', { unique: false });
          st.createIndex('by_chapter', 'chapter_id', { unique: false });
        }
        if (!db.objectStoreNames.contains('characters')) {
          const st = db.createObjectStore('characters', { keyPath: 'id', autoIncrement: true });
          st.createIndex('by_book', 'book_id', { unique: false });
        }
        if (!db.objectStoreNames.contains('relations')) {
          const st = db.createObjectStore('relations', { keyPath: 'id', autoIncrement: true });
          st.createIndex('by_book', 'book_id', { unique: false });
        }
        if (!db.objectStoreNames.contains('analysis')) {
          db.createObjectStore('analysis', { keyPath: 'book_id' });
        }
        if (!db.objectStoreNames.contains('progress')) {
          db.createObjectStore('progress', { keyPath: 'book_id' });
        }
        if (!db.objectStoreNames.contains('assets')) {
          const st = db.createObjectStore('assets', { keyPath: 'key' });
          st.createIndex('by_book', 'book_id', { unique: false });
        }
      };
      req.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };
      req.onerror = () => reject(req.error || new Error('No se pudo abrir IndexedDB.'));
    });
  }

  _req(idbReq) {
    return new Promise((resolve, reject) => {
      idbReq.onsuccess = () => resolve(idbReq.result);
      idbReq.onerror = () => reject(idbReq.error);
    });
  }

  async listBooks() {
    const db = await this.open();
    const tx = db.transaction(['books'], 'readonly');
    const books = await this._req(tx.objectStore('books').getAll());
    books.sort((a, b) => Number(b.id) - Number(a.id));
    return books;
  }

  async getStorageEstimate() {
    if (navigator.storage && navigator.storage.estimate) {
      try {
        return await navigator.storage.estimate();
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  /**
   * Guarda libro completo + análisis ML en una única transacción IDB sin awaits externos
   * (compatible con Safari iOS, Android Chrome y Desktop).
   */
  async saveFullBookAnalysis(bundle) {
    const db = await this.open();
    const meta = bundle.metadata || {};
    const stats = bundle.ml_stats || {};
    const kStats = stats.kindle_stats || {};
    const nowIso = new Date().toISOString();

    return new Promise((resolve, reject) => {
      const storeNames = ['books', 'chapters', 'notes', 'characters', 'relations', 'analysis', 'progress', 'assets'];
      const tx = db.transaction(storeNames, 'readwrite');
      let finalBookId = null;

      tx.oncomplete = () => resolve(finalBookId);
      tx.onerror = () => reject(tx.error || new Error('Error guardando libro en IndexedDB.'));
      tx.onabort = () => reject(tx.error || new Error('Transacción abortada en IndexedDB.'));

      const bookRecord = {
        title: meta.title || 'Libro sin título',
        author: meta.author || 'Autor desconocido',
        language: meta.language || 'es',
        publisher: meta.publisher || null,
        description: meta.description || null,
        cover_path: bundle.cover_blob ? '__cover__' : null,
        cover_blob: bundle.cover_blob || null,
        epub_filename: bundle.epub_filename || 'libro.epub',
        pdf_filename: bundle.pdf_filename || null,
        total_chapters: Number(stats.narrative_chapters || 0),
        total_words: Number(bundle.total_words || 0),
        total_notes: Number(kStats.notes || 0),
        total_highlights: Number(kStats.highlights || 0),
        total_characters: Array.isArray(bundle.characters) ? bundle.characters.length : 0,
        global_summary: bundle.global_summary || '',
        created_at: nowIso,
        updated_at: nowIso
      };

      const booksStore = tx.objectStore('books');
      const addBookReq = booksStore.add(bookRecord);

      addBookReq.onsuccess = () => {
        const bookId = Number(addBookReq.result);
        finalBookId = bookId;

        const chStore = tx.objectStore('chapters');
        const notesStore = tx.objectStore('notes');
        const charsStore = tx.objectStore('characters');
        const relStore = tx.objectStore('relations');
        const analysisStore = tx.objectStore('analysis');
        const progressStore = tx.objectStore('progress');
        const assetsStore = tx.objectStore('assets');

        // 1. Guardar imágenes/recursos del EPUB
        for (const asset of (bundle.assets || [])) {
          assetsStore.put({
            key: `${bookId}::${asset.path}`,
            book_id: bookId,
            path: asset.path,
            mime: asset.mime,
            blob: asset.blob
          });
        }

        // 2. Insertar capítulos primero para mapear chapter_index -> chapter_id real
        const chapters = bundle.chapters || [];
        const chapterIdxToId = {};
        let pendingChapters = chapters.length;

        const afterChaptersInserted = () => {
          // 3. Notas Kindle alineadas + conteo por capítulo
          const notesCountByChapter = {};
          for (const note of (bundle.aligned_notes || [])) {
            const mIdx = note.matched_chapter_index;
            const mChId = (mIdx !== null && mIdx !== undefined && chapterIdxToId[mIdx]) ? chapterIdxToId[mIdx] : null;
            if (mChId !== null) {
              notesCountByChapter[mChId] = (notesCountByChapter[mChId] || 0) + 1;
            }
            notesStore.add({
              book_id: bookId,
              chapter_id: mChId,
              pdf_chapter_label: note.pdf_chapter_label || null,
              page_number: note.page_number ?? null,
              note_type: note.note_type || 'highlight',
              highlight_color: note.highlight_color || null,
              highlight_text: note.highlight_text || null,
              user_note: note.user_note || null,
              note_date: note.note_date || null,
              match_confidence: Number(note.match_confidence || 0),
              sort_order: Number(note.sort_order || 0)
            });
          }

          // 4. Insertar personajes para mapear idx -> charId
          const chars = bundle.characters || [];
          const charIdxToId = {};
          let pendingChars = chars.length;

          const afterCharsInserted = () => {
            // 5. Relaciones del grafo
            for (const e of (bundle.edges || [])) {
              const srcId = charIdxToId[e.source_idx];
              const tgtId = charIdxToId[e.target_idx];
              if (!srcId || !tgtId) continue;

              const sharedIds = (e.shared_chapters || [])
                .map((k) => chapterIdxToId[k])
                .filter(Boolean);
              const evidence = (e.evidence || []).map((ev) => ({
                chapter_id: chapterIdxToId[ev.chapter_key] || null,
                text: ev.text
              }));

              relStore.add({
                book_id: bookId,
                source_character_id: srcId,
                target_character_id: tgtId,
                source: srcId,
                target: tgtId,
                weight: Number(e.weight || 0),
                cooccurrence_count: Number(e.cooccurrence || 0),
                pmi_score: Number(e.pmi_score || 0),
                sentiment_score: Number(e.sentiment_score || 0),
                relation_tone: e.relation_tone || 'neutral',
                context_words: e.context_words || [],
                shared_chapters: sharedIds,
                evidence
              });
            }

            // 6. Análisis global (clústeres)
            const clustersMapped = (bundle.clusters || []).map((cl) => ({
              ...cl,
              member_chapter_ids: (cl.members || []).map((k) => chapterIdxToId[k]).filter(Boolean)
            }));

            analysisStore.put({
              book_id: bookId,
              global_keywords: bundle.global_keywords || { concepts: [], bigrams: [] },
              clusters: clustersMapped,
              stats: stats,
              analyzed_at: nowIso
            });

            // 7. Progreso inicial
            const narrIndices = bundle.narrative_indices || [];
            const firstIdx = narrIndices[0] ?? chapters[0]?.chapter_index;
            const firstChId = firstIdx !== undefined ? (chapterIdxToId[firstIdx] || null) : null;
            progressStore.put({
              book_id: bookId,
              current_chapter_id: firstChId,
              scroll_percent: 0,
              reader_theme: 'paper',
              font_size: 18,
              updated_at: nowIso
            });
          };

          if (pendingChars === 0) {
            afterCharsInserted();
          } else {
            chars.forEach((char, idx) => {
              const firstKey = char.first_chapter_key;
              const firstChId = (firstKey !== undefined && firstKey !== null) ? (chapterIdxToId[firstKey] || null) : null;
              const chaptersById = {};
              for (const [chKey, cnt] of Object.entries(char.chapters || {})) {
                const cid = chapterIdxToId[chKey];
                if (cid) chaptersById[String(cid)] = cnt;
              }
              const samples = (char.sample_mentions || []).map((sm) => ({
                chapter_id: chapterIdxToId[sm.chapter_key] || null,
                text: sm.text
              }));

              const cReq = charsStore.add({
                book_id: bookId,
                canonical_name: char.canonical_name,
                aliases: char.aliases || [],
                mention_count: Number(char.mention_count || 0),
                chapter_count: Number(char.chapter_count || 0),
                pagerank: Number(char.pagerank || 0),
                degree_centrality: Number(char.degree_centrality || 0),
                community_id: Number(char.community_id || 0),
                first_chapter_id: firstChId,
                chapters: chaptersById,
                traits: char.traits || [],
                sample_mentions: samples
              });
              cReq.onsuccess = () => {
                charIdxToId[idx] = Number(cReq.result);
                pendingChars--;
                if (pendingChars === 0) {
                  afterCharsInserted();
                }
              };
            });
          }
        };

        if (pendingChapters === 0) {
          afterChaptersInserted();
        } else {
          chapters.forEach((ch) => {
            const chIdx = ch.chapter_index;
            const sumData = bundle.chapter_summaries?.[chIdx] || null;
            const kwData = bundle.chapter_keywords?.[chIdx] || null;

            const chReq = chStore.add({
              book_id: bookId,
              chapter_index: chIdx,
              part_title: ch.part_title || null,
              title: ch.title,
              display_title: ch.display_title,
              href: ch.href,
              is_front_matter: Number(ch.is_front_matter ? 1 : 0),
              word_count: Number(ch.word_count || 0),
              html_content: ch.html_content || '',
              summary_text: sumData ? sumData.summary_text : null,
              summary: sumData,
              keywords: kwData
            });

            chReq.onsuccess = () => {
              const realId = Number(chReq.result);
              chapterIdxToId[chIdx] = realId;
              pendingChapters--;
              if (pendingChapters === 0) {
                afterChaptersInserted();
              }
            };
          });
        }
      };
    });
  }

  async getBookDetail(bookId) {
    const id = Number(bookId);
    const db = await this.open();
    const tx = db.transaction(['books', 'chapters', 'notes', 'characters', 'relations', 'analysis', 'progress'], 'readonly');

    const [book, chaptersRaw, notes, characters, relations, analysis, progress] = await Promise.all([
      this._req(tx.objectStore('books').get(id)),
      this._req(tx.objectStore('chapters').index('by_book').getAll(id)),
      this._req(tx.objectStore('notes').index('by_book').getAll(id)),
      this._req(tx.objectStore('characters').index('by_book').getAll(id)),
      this._req(tx.objectStore('relations').index('by_book').getAll(id)),
      this._req(tx.objectStore('analysis').get(id)),
      this._req(tx.objectStore('progress').get(id))
    ]);

    if (!book) throw new Error('Libro no encontrado en almacenamiento local.');

    const notesCountMap = new Map();
    for (const n of notes) {
      if (n.chapter_id) {
        notesCountMap.set(Number(n.chapter_id), (notesCountMap.get(Number(n.chapter_id)) || 0) + 1);
      }
    }

    chaptersRaw.sort((a, b) => a.chapter_index - b.chapter_index);
    const chapters = chaptersRaw.map((c) => {
      const { html_content, ...rest } = c;
      return {
        ...rest,
        notes_count: notesCountMap.get(Number(c.id)) || 0
      };
    });

    notes.sort((a, b) => a.sort_order - b.sort_order);
    characters.sort((a, b) => b.mention_count - a.mention_count);
    relations.sort((a, b) => b.weight - a.weight);

    return {
      ok: true,
      book,
      chapters,
      notes,
      characters,
      relations,
      analysis: analysis || null,
      progress: progress || null
    };
  }

  async getChapterContent(chapterId) {
    const id = Number(chapterId);
    const db = await this.open();
    const tx = db.transaction(['chapters', 'notes', 'assets'], 'readonly');
    const ch = await this._req(tx.objectStore('chapters').get(id));
    if (!ch) throw new Error('Capítulo no encontrado.');

    const [notes, bookAssets] = await Promise.all([
      this._req(tx.objectStore('notes').index('by_chapter').getAll(id)),
      this._req(tx.objectStore('assets').index('by_book').getAll(Number(ch.book_id)))
    ]);

    notes.sort((a, b) => a.sort_order - b.sort_order);
    return {
      ok: true,
      chapter: ch,
      notes,
      assets: bookAssets
    };
  }

  async saveProgress(payload) {
    const db = await this.open();
    const tx = db.transaction(['progress'], 'readwrite');
    await this._req(tx.objectStore('progress').put({
      book_id: Number(payload.book_id),
      current_chapter_id: payload.current_chapter_id ? Number(payload.current_chapter_id) : null,
      scroll_percent: Number(payload.scroll_percent || 0),
      reader_theme: payload.reader_theme || 'paper',
      font_size: Number(payload.font_size || 18),
      updated_at: new Date().toISOString()
    }));
    return { ok: true };
  }

  async deleteBook(bookId) {
    const id = Number(bookId);
    const db = await this.open();

    return new Promise((resolve, reject) => {
      const stores = ['books', 'chapters', 'notes', 'characters', 'relations', 'analysis', 'progress', 'assets'];
      const tx = db.transaction(stores, 'readwrite');
      tx.oncomplete = () => resolve({ ok: true });
      tx.onerror = () => reject(tx.error || new Error('Error eliminando libro.'));

      tx.objectStore('books').delete(id);
      tx.objectStore('analysis').delete(id);
      tx.objectStore('progress').delete(id);

      for (const sName of ['chapters', 'notes', 'characters', 'relations', 'assets']) {
        const idx = tx.objectStore(sName).index('by_book');
        const cursorReq = idx.openKeyCursor(IDBKeyRange.only(id));
        cursorReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            tx.objectStore(sName).delete(cursor.primaryKey);
            cursor.continue();
          }
        };
      }
    });
  }

  /**
   * Exporta un libro completo con análisis y blobs en formato JSON portable (.leeme.json).
   */
  async exportBookBackup(bookId) {
    const id = Number(bookId);
    const db = await this.open();
    const tx = db.transaction(['books', 'chapters', 'notes', 'characters', 'relations', 'analysis', 'progress', 'assets'], 'readonly');

    const [book, chapters, notes, characters, relations, analysis, progress, assets] = await Promise.all([
      this._req(tx.objectStore('books').get(id)),
      this._req(tx.objectStore('chapters').index('by_book').getAll(id)),
      this._req(tx.objectStore('notes').index('by_book').getAll(id)),
      this._req(tx.objectStore('characters').index('by_book').getAll(id)),
      this._req(tx.objectStore('relations').index('by_book').getAll(id)),
      this._req(tx.objectStore('analysis').get(id)),
      this._req(tx.objectStore('progress').get(id)),
      this._req(tx.objectStore('assets').index('by_book').getAll(id))
    ]);

    if (!book) throw new Error('Libro no encontrado para exportar.');

    const blobToBase64 = (blob) => new Promise((resolve) => {
      if (!blob) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => {
        const res = String(reader.result || '');
        const comma = res.indexOf(',');
        resolve({ mime: blob.type || 'application/octet-stream', data: comma >= 0 ? res.slice(comma + 1) : res });
      };
      reader.readAsDataURL(blob);
    });

    const { cover_blob, id: oldBookId, ...bookClean } = book;
    const coverEncoded = await blobToBase64(cover_blob);
    const assetsEncoded = [];
    for (const a of assets) {
      assetsEncoded.push({
        path: a.path,
        mime: a.mime,
        encoded: await blobToBase64(a.blob)
      });
    }

    return {
      format: 'leeme-backup-v1',
      exported_at: new Date().toISOString(),
      book: bookClean,
      cover: coverEncoded,
      chapters,
      notes,
      characters,
      relations,
      analysis,
      progress,
      assets: assetsEncoded
    };
  }

  /**
   * Importa un respaldo .leeme.json (o .biblioml.json) y reconstruye IDs e imágenes en IndexedDB.
   */
  async importBookBackup(backup) {
    const validFormats = ['leeme-backup-v1', 'biblioml-backup-v1'];
    if (!backup || !validFormats.includes(backup.format) || !backup.book) {
      throw new Error('Archivo de respaldo LeeMe inválido.');
    }

    const base64ToBlob = (enc) => {
      if (!enc || !enc.data) return null;
      const bin = atob(enc.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: enc.mime || 'application/octet-stream' });
    };

    const coverBlob = base64ToBlob(backup.cover);
    const assetBlobs = (backup.assets || []).map((a) => ({
      path: a.path,
      mime: a.mime || a.encoded?.mime || 'application/octet-stream',
      blob: base64ToBlob(a.encoded)
    })).filter((a) => a.blob);

    const db = await this.open();
    return new Promise((resolve, reject) => {
      const stores = ['books', 'chapters', 'notes', 'characters', 'relations', 'analysis', 'progress', 'assets'];
      const tx = db.transaction(stores, 'readwrite');
      let newBookId = null;
      tx.oncomplete = () => resolve(newBookId);
      tx.onerror = () => reject(tx.error || new Error('Error importando respaldo.'));

      const bookRec = {
        ...backup.book,
        cover_blob: coverBlob,
        cover_path: coverBlob ? '__cover__' : null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      const addBook = tx.objectStore('books').add(bookRec);
      addBook.onsuccess = () => {
        newBookId = Number(addBook.result);
        const assetsStore = tx.objectStore('assets');
        for (const a of assetBlobs) {
          assetsStore.put({ key: `${newBookId}::${a.path}`, book_id: newBookId, path: a.path, mime: a.mime, blob: a.blob });
        }

        const chMap = {};
        const oldChapters = backup.chapters || [];
        let remCh = oldChapters.length;
        const chStore = tx.objectStore('chapters');

        const afterCh = () => {
          const notesStore = tx.objectStore('notes');
          for (const n of (backup.notes || [])) {
            const { id, ...rest } = n;
            notesStore.add({
              ...rest,
              book_id: newBookId,
              chapter_id: n.chapter_id ? (chMap[n.chapter_id] || null) : null
            });
          }

          const charMap = {};
          const oldChars = backup.characters || [];
          let remC = oldChars.length;
          const charStore = tx.objectStore('characters');

          const afterChars = () => {
            const relStore = tx.objectStore('relations');
            for (const r of (backup.relations || [])) {
              const { id, ...rest } = r;
              const sId = charMap[r.source_character_id || r.source];
              const tId = charMap[r.target_character_id || r.target];
              if (!sId || !tId) continue;
              relStore.add({
                ...rest,
                book_id: newBookId,
                source_character_id: sId,
                target_character_id: tId,
                source: sId,
                target: tId,
                shared_chapters: (r.shared_chapters || []).map((cid) => chMap[cid]).filter(Boolean),
                evidence: (r.evidence || []).map((ev) => ({
                  ...ev,
                  chapter_id: ev.chapter_id ? (chMap[ev.chapter_id] || null) : null
                }))
              });
            }

            if (backup.analysis) {
              const a = backup.analysis;
              tx.objectStore('analysis').put({
                ...a,
                global_mindmap: undefined,
                cluster_mindmap: undefined,
                book_id: newBookId,
                clusters: (a.clusters || []).map((cl) => ({
                  ...cl,
                  member_chapter_ids: (cl.member_chapter_ids || []).map((cid) => chMap[cid]).filter(Boolean)
                }))
              });
            }

            const p = backup.progress || {};
            tx.objectStore('progress').put({
              book_id: newBookId,
              current_chapter_id: p.current_chapter_id ? (chMap[p.current_chapter_id] || null) : null,
              scroll_percent: Number(p.scroll_percent || 0),
              reader_theme: p.reader_theme || 'paper',
              font_size: Number(p.font_size || 18),
              updated_at: new Date().toISOString()
            });
          };

          if (remC === 0) afterChars();
          oldChars.forEach((c) => {
            const { id: oldCid, chapters: oldChCounts, ...rest } = c;
            const newChCounts = {};
            for (const [k, v] of Object.entries(oldChCounts || {})) {
              if (chMap[k]) newChCounts[String(chMap[k])] = v;
            }
            const reqC = charStore.add({
              ...rest,
              book_id: newBookId,
              first_chapter_id: c.first_chapter_id ? (chMap[c.first_chapter_id] || null) : null,
              chapters: newChCounts,
              sample_mentions: (c.sample_mentions || []).map((sm) => ({
                ...sm,
                chapter_id: sm.chapter_id ? (chMap[sm.chapter_id] || null) : null
              }))
            });
            reqC.onsuccess = () => {
              charMap[oldCid] = Number(reqC.result);
              remC--;
              if (remC === 0) afterChars();
            };
          });
        };

        if (remCh === 0) afterCh();
        oldChapters.forEach((c) => {
          const { id: oldId, mindmap: _mm, ...rest } = c;
          const reqCh = chStore.add({ ...rest, book_id: newBookId });
          reqCh.onsuccess = () => {
            const newId = Number(reqCh.result);
            chMap[oldId] = newId;
            remCh--;
            if (remCh === 0) afterCh();
          };
        });
      };
    });
  }
}

window.BiblioDB = BiblioDB;
