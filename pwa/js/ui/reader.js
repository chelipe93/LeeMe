/**
 * Lector EPUB Integrado Offline (LeeMe): resuelve imágenes desde IndexedDB Blobs,
 * inyecta subrayados/notas Kindle con popover táctil y bottom-sheets móviles.
 */
class EpubReaderController {
  constructor(callbacks = {}) {
    this.onNavigateCharacter = callbacks.onNavigateCharacter || (() => {});
    this.bookData = null;
    this.currentChapterId = null;
    this.currentChapterNotes = [];
    this.fontSize = 18;
    this.fontSans = false;
    this.theme = 'paper';
    this.showHighlights = true;
    this.progressTimer = null;

    this.els = {
      sheetBackdrop: document.getElementById('sheetBackdrop'),
      tocPanel: document.getElementById('readerTocPanel'),
      inspPanel: document.getElementById('readerInspectorPanel'),
      appearanceSheet: document.getElementById('readerAppearanceSheet'),
      btnOpenToc: document.getElementById('btnMobileOpenToc'),
      btnCloseToc: document.getElementById('btnMobileCloseToc'),
      btnOpenInsp: document.getElementById('btnMobileOpenInsp'),
      btnCloseInsp: document.getElementById('btnMobileCloseInsp'),
      btnOpenAppearanceMobile: document.getElementById('btnReaderAppearanceMobile'),
      btnCloseAppearance: document.getElementById('btnCloseAppearance'),
      tocList: document.getElementById('readerTocList'),
      title: document.getElementById('readerChapterTitle'),
      viewport: document.getElementById('readerViewport'),
      progressFill: document.getElementById('readerProgressFill'),
      progressText: document.getElementById('readerProgressText'),
      btnPrev: document.getElementById('btnPrevChapter'),
      btnNext: document.getElementById('btnNextChapter'),
      btnDec: document.getElementById('btnFontDec'),
      btnInc: document.getElementById('btnFontInc'),
      btnFontToggle: document.getElementById('btnFontToggle'),
      themeSelect: document.getElementById('selectReaderTheme'),
      chkHighlights: document.getElementById('chkShowHighlights'),
      btnSheetDec: document.getElementById('btnSheetFontDec'),
      btnSheetInc: document.getElementById('btnSheetFontInc'),
      btnSheetFontToggle: document.getElementById('btnSheetFontToggle'),
      chkSheetHighlights: document.getElementById('chkSheetShowHighlights'),
      sheetFontLabel: document.getElementById('sheetFontSizeLabel'),
      noteToast: document.getElementById('kindleNoteToast'),
      toastNoteMeta: document.getElementById('toastNoteMeta'),
      toastNoteQuote: document.getElementById('toastNoteQuote'),
      toastNoteBody: document.getElementById('toastNoteBody'),
      btnCloseNoteToast: document.getElementById('btnCloseNoteToast'),
      inspSummary: document.getElementById('readerInspectorSummary'),
      inspKeywords: document.getElementById('readerInspectorKeywords'),
      inspChars: document.getElementById('readerInspectorChars'),
      inspNotes: document.getElementById('readerInspectorNotes')
    };

    this._bindControls();
  }

  _openSheet(panel) {
    this.closeAllSheets();
    if (!panel) return;
    panel.classList.remove('hidden');
    panel.classList.add('mobile-open');
    this.els.sheetBackdrop?.classList.remove('hidden');
  }

  closeAllSheets() {
    this.els.tocPanel?.classList.remove('mobile-open');
    this.els.inspPanel?.classList.remove('mobile-open');
    if (this.els.appearanceSheet) {
      this.els.appearanceSheet.classList.remove('mobile-open');
      this.els.appearanceSheet.classList.add('hidden');
    }
    this.els.sheetBackdrop?.classList.add('hidden');
  }

  _bindControls() {
    this.els.btnOpenToc?.addEventListener('click', () => this._openSheet(this.els.tocPanel));
    this.els.btnCloseToc?.addEventListener('click', () => this.closeAllSheets());
    this.els.btnOpenInsp?.addEventListener('click', () => this._openSheet(this.els.inspPanel));
    this.els.btnCloseInsp?.addEventListener('click', () => this.closeAllSheets());
    this.els.btnOpenAppearanceMobile?.addEventListener('click', () => this._openSheet(this.els.appearanceSheet));
    this.els.btnCloseAppearance?.addEventListener('click', () => this.closeAllSheets());
    this.els.sheetBackdrop?.addEventListener('click', () => this.closeAllSheets());
    this.els.btnCloseNoteToast?.addEventListener('click', () => this.els.noteToast?.classList.add('hidden'));

    const stepFont = (delta) => {
      this.fontSize = Math.max(14, Math.min(28, this.fontSize + delta));
      this._applyReaderStyle();
      this._scheduleSaveProgress();
    };
    const toggleFontFamily = () => {
      this.fontSans = !this.fontSans;
      this.els.viewport.classList.toggle('font-sans', this.fontSans);
    };
    const setTheme = (t) => {
      this.theme = t;
      this._applyReaderStyle();
      this._scheduleSaveProgress();
    };
    const setHighlights = (checked) => {
      this.showHighlights = Boolean(checked);
      if (this.els.chkHighlights) this.els.chkHighlights.checked = this.showHighlights;
      if (this.els.chkSheetHighlights) this.els.chkSheetHighlights.checked = this.showHighlights;
      if (this.currentChapterId) this.openChapter(this.currentChapterId, { preserveScroll: true });
    };

    this.els.btnDec?.addEventListener('click', () => stepFont(-2));
    this.els.btnInc?.addEventListener('click', () => stepFont(2));
    this.els.btnSheetDec?.addEventListener('click', () => stepFont(-2));
    this.els.btnSheetInc?.addEventListener('click', () => stepFont(2));
    this.els.btnFontToggle?.addEventListener('click', toggleFontFamily);
    this.els.btnSheetFontToggle?.addEventListener('click', toggleFontFamily);

    this.els.themeSelect?.addEventListener('change', () => setTheme(this.els.themeSelect.value));
    document.querySelectorAll('[data-reader-theme]').forEach((btn) => {
      btn.addEventListener('click', () => setTheme(btn.dataset.readerTheme));
    });

    this.els.chkHighlights?.addEventListener('change', () => setHighlights(this.els.chkHighlights.checked));
    this.els.chkSheetHighlights?.addEventListener('change', () => setHighlights(this.els.chkSheetHighlights.checked));

    this.els.btnPrev?.addEventListener('click', () => this._stepChapter(-1));
    this.els.btnNext?.addEventListener('click', () => this._stepChapter(1));

    this.els.viewport.addEventListener('scroll', () => {
      const vp = this.els.viewport;
      const maxScroll = Math.max(1, vp.scrollHeight - vp.clientHeight);
      const pct = Math.min(100, Math.max(0, (vp.scrollTop / maxScroll) * 100));
      this.els.progressFill.style.width = `${pct.toFixed(1)}%`;
      this.els.progressText.textContent = `${Math.round(pct)}% leído`;
      this._scheduleSaveProgress(pct);
    });
  }

  loadBook(bookDetail) {
    this.bookData = bookDetail;
    this.els.noteToast?.classList.add('hidden');
    const prog = bookDetail.progress || {};
    this.theme = prog.reader_theme || 'paper';
    this.fontSize = Number(prog.font_size) || 18;
    this._applyReaderStyle();
    this._renderToc();

    const startChapterId = Number(prog.current_chapter_id)
      || (bookDetail.chapters.find((c) => Number(c.is_front_matter) === 0)?.id)
      || (bookDetail.chapters[0]?.id);

    if (startChapterId) {
      this.openChapter(startChapterId, { scrollPercent: Number(prog.scroll_percent) || 0 });
    }
  }

  _applyReaderStyle() {
    const vp = this.els.viewport;
    vp.classList.remove('theme-paper', 'theme-sepia', 'theme-dark');
    vp.classList.add(`theme-${this.theme}`);
    vp.style.fontSize = `${this.fontSize}px`;
    if (this.els.themeSelect) this.els.themeSelect.value = this.theme;
    if (this.els.sheetFontLabel) this.els.sheetFontLabel.textContent = `${this.fontSize} px`;
    document.querySelectorAll('[data-reader-theme]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.readerTheme === this.theme);
    });
  }

  _renderToc() {
    const chapters = this.bookData.chapters || [];
    let html = '';
    let lastPart = null;

    for (const ch of chapters) {
      const part = ch.part_title || (Number(ch.is_front_matter) ? 'Preliminares / Otros' : 'Capítulos');
      if (part !== lastPart) {
        html += `<div class="toc-group-label">${this._esc(part)}</div>`;
        lastPart = part;
      }
      const nCount = Number(ch.notes_count || 0);
      html += `
        <button class="toc-item" data-chapter-id="${ch.id}">
          <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${this._esc(ch.display_title)}</span>
          ${nCount > 0 ? `<span class="note-dot" title="${nCount} notas Kindle">${nCount}</span>` : ''}
        </button>`;
    }
    this.els.tocList.innerHTML = html;

    this.els.tocList.querySelectorAll('.toc-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.closeAllSheets();
        this.openChapter(Number(btn.dataset.chapterId));
      });
    });
  }

  async openChapter(chapterId, opts = {}) {
    if (!this.bookData) return;
    this.els.noteToast?.classList.add('hidden');
    const prevScroll = opts.preserveScroll ? this.els.viewport.scrollTop : 0;

    this.currentChapterId = Number(chapterId);
    this.els.tocList.querySelectorAll('.toc-item').forEach((el) => {
      el.classList.toggle('active', Number(el.dataset.chapterId) === this.currentChapterId);
    });

    this.els.viewport.innerHTML = '<p class="muted" style="text-align:center; padding:40px 0;">Cargando capítulo del EPUB…</p>';

    try {
      const data = await BiblioAPI.getChapterContent(this.currentChapterId);
      const ch = data.chapter;
      this.currentChapterNotes = data.notes || [];

      this.els.title.textContent = ch.display_title;
      this.els.viewport.innerHTML = ch.html_content || '<p class="muted">(Sección sin texto)</p>';
      this._hydrateChapterImages(data.assets || []);

      if (this.showHighlights && this.currentChapterNotes.length > 0) {
        this._injectKindleHighlights(this.currentChapterNotes);
      }

      this._renderInspector(ch, this.currentChapterNotes);
      this._updateNavButtons();

      if (opts.focusNoteId) {
        this.scrollToNote(opts.focusNoteId);
      } else if (opts.preserveScroll) {
        this.els.viewport.scrollTop = prevScroll;
      } else if (opts.scrollPercent && opts.scrollPercent > 0) {
        const vp = this.els.viewport;
        const maxScroll = Math.max(0, vp.scrollHeight - vp.clientHeight);
        vp.scrollTop = (opts.scrollPercent / 100) * maxScroll;
      } else {
        this.els.viewport.scrollTop = 0;
      }

      this._scheduleSaveProgress();
    } catch (err) {
      this.els.viewport.innerHTML = `<div class="alert err">Error cargando capítulo: ${this._esc(err.message)}</div>`;
    }
  }

  _hydrateChapterImages(assets) {
    if (!assets.length) return;
    const assetMap = new Map();
    for (const a of assets) assetMap.set(a.path, a.blob);

    for (const img of this.els.viewport.querySelectorAll('[data-epub-asset]')) {
      const path = img.getAttribute('data-epub-asset');
      const blob = assetMap.get(path);
      if (!blob) continue;
      const url = BiblioAPI.createAssetObjectUrl(blob);
      if (img.tagName.toLowerCase() === 'img') {
        img.setAttribute('src', url);
      } else {
        img.setAttribute('href', url);
        try {
          img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', url);
        } catch (_) {}
      }
    }
  }

  _injectKindleHighlights(notes) {
    const vp = this.els.viewport;
    const normalizeWithMap = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      let norm = '';
      const map = [];
      let node;
      let prevSpace = true;

      while ((node = walker.nextNode())) {
        const val = node.nodeValue || '';
        for (let i = 0; i < val.length; i++) {
          const ch = val[i];
          const clean = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
          if (/[a-z0-9]/.test(clean)) {
            norm += clean;
            map.push({ node, offset: i });
            prevSpace = false;
          } else if (!prevSpace) {
            norm += ' ';
            map.push({ node, offset: i });
            prevSpace = true;
          }
        }
      }
      return { norm, map };
    };

    const normQuery = (str) =>
      (str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ').trim();

    for (const note of notes) {
      if (!note.highlight_text) continue;
      const q = normQuery(note.highlight_text);
      if (q.length < 10) continue;

      const { norm, map } = normalizeWithMap(vp);
      let idx = norm.indexOf(q);
      let matchLen = q.length;

      if (idx === -1 && q.length > 48) {
        const probe = q.slice(0, 45);
        idx = norm.indexOf(probe);
        if (idx !== -1) matchLen = Math.min(q.length, norm.length - idx);
      }
      if (idx === -1 || !map[idx] || !map[Math.min(map.length - 1, idx + matchLen - 1)]) continue;

      const startPos = map[idx];
      const endPos = map[Math.min(map.length - 1, idx + matchLen - 1)];

      try {
        const range = document.createRange();
        range.setStart(startPos.node, startPos.offset);
        range.setEnd(endPos.node, Math.min(endPos.node.nodeValue.length, endPos.offset + 1));

        if (startPos.node === endPos.node) {
          const mark = document.createElement('mark');
          mark.className = 'kindle-mark';
          mark.dataset.noteId = String(note.id);
          range.surroundContents(mark);
          if (note.user_note) {
            const badge = document.createElement('span');
            badge.className = 'kindle-inline-badge';
            badge.textContent = 'Nota';
            badge.addEventListener('click', (e) => {
              e.stopPropagation();
              this._showNoteToast(note);
            });
            mark.after(badge);
          }
          mark.addEventListener('click', (e) => {
            e.stopPropagation();
            this._showNoteToast(note);
          });
        } else {
          const r2 = document.createRange();
          r2.setStart(startPos.node, startPos.offset);
          r2.setEnd(startPos.node, startPos.node.nodeValue.length);
          const mark = document.createElement('mark');
          mark.className = 'kindle-mark';
          mark.dataset.noteId = String(note.id);
          r2.surroundContents(mark);
          mark.addEventListener('click', (e) => {
            e.stopPropagation();
            this._showNoteToast(note);
          });
        }
      } catch (_) {}
    }
  }

  _showNoteToast(note) {
    if (!this.els.noteToast) return;
    const typeLbl = note.user_note ? '🖍️ Subrayado + Nota' : '🖍️ Subrayado Kindle';
    this.els.toastNoteMeta.textContent = `${typeLbl}${note.page_number ? ` · Pág. ${note.page_number}` : ''}`;
    const qText = note.highlight_text || '';
    this.els.toastNoteQuote.textContent = qText ? `«${qText.slice(0, 200)}${qText.length > 200 ? '…' : ''}»` : '';
    if (note.user_note) {
      this.els.toastNoteBody.innerHTML = `<strong>Tu nota:</strong> ${this._esc(note.user_note)}`;
      this.els.toastNoteBody.classList.remove('hidden');
    } else {
      this.els.toastNoteBody.classList.add('hidden');
    }
    this.els.noteToast.classList.remove('hidden');

    // Resaltar tarjeta en inspector desktop si está visible
    const card = this.els.inspNotes?.querySelector(`[data-insp-note-id="${note.id}"]`);
    if (card && window.innerWidth > 860) {
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      card.style.boxShadow = '0 0 0 2px #c88a2b';
      setTimeout(() => { card.style.boxShadow = ''; }, 1800);
    }
  }

  scrollToNote(noteId) {
    const mark = this.els.viewport.querySelector(`mark.kindle-mark[data-note-id="${noteId}"]`);
    this.els.viewport.querySelectorAll('mark.active-focus').forEach((m) => m.classList.remove('active-focus'));
    if (mark) {
      mark.classList.add('active-focus');
      mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const note = this.currentChapterNotes.find((n) => Number(n.id) === Number(noteId));
      if (note) this._showNoteToast(note);
    }
  }

  _renderInspector(ch, notes) {
    this.els.inspSummary.textContent = ch.summary_text || 'Sección preliminar sin resumen narrativo.';

    const kw = ch.keywords || {};
    const terms = [...(kw.tfidf_terms || []).slice(0, 6), ...(kw.rake_phrases || []).slice(0, 3)];
    this.els.inspKeywords.innerHTML = terms.length
      ? terms.map((t) => `<span class="chip primary">${this._esc(t.term)}</span>`).join('')
      : '<span class="muted">Sin conceptos ML en esta sección.</span>';

    const chars = (this.bookData.characters || [])
      .filter((c) => c.chapters && c.chapters[String(ch.id)] > 0)
      .sort((a, b) => (b.chapters[String(ch.id)] || 0) - (a.chapters[String(ch.id)] || 0))
      .slice(0, 10);

    this.els.inspChars.innerHTML = chars.length
      ? chars.map((c) => `
          <span class="chip success" style="cursor:pointer;" data-char-id="${c.id}">
            ${this._esc(c.canonical_name)} (${c.chapters[String(ch.id)]})
          </span>`).join('')
      : '<span class="muted">Sin personajes detectados.</span>';

    this.els.inspChars.querySelectorAll('[data-char-id]').forEach((el) => {
      el.addEventListener('click', () => {
        this.closeAllSheets();
        this.onNavigateCharacter(Number(el.dataset.charId));
      });
    });

    if (!notes.length) {
      this.els.inspNotes.innerHTML = '<span class="muted">No hay notas Kindle asociadas a este capítulo.</span>';
    } else {
      this.els.inspNotes.innerHTML = notes.map((n) => `
        <div class="note-card type-${this._esc(n.note_type)}" data-insp-note-id="${n.id}" style="margin:0; padding:10px 12px; cursor:pointer;">
          <div style="font-size:11px; color:var(--ink-soft); font-weight:700;">
            ${n.page_number ? `Pág. ${n.page_number}` : ''} · ${n.note_type === 'bookmark' ? 'Marcador' : (n.note_type === 'note' ? 'Nota' : 'Subrayado')}
          </div>
          ${n.highlight_text ? `<div style="font-family:var(--font-serif); font-size:12.5px; margin-top:4px;">«${this._esc(n.highlight_text.slice(0, 160))}${n.highlight_text.length > 160 ? '…' : ''}»</div>` : ''}
          ${n.user_note ? `<div class="note-user" style="padding:5px 8px; font-size:12px; margin-top:5px;"><strong>Nota:</strong> ${this._esc(n.user_note)}</div>` : ''}
        </div>`).join('');

      this.els.inspNotes.querySelectorAll('[data-insp-note-id]').forEach((card) => {
        card.addEventListener('click', () => {
          this.closeAllSheets();
          this.scrollToNote(Number(card.dataset.inspNoteId));
        });
      });
    }
  }

  _stepChapter(delta) {
    const chs = this.bookData?.chapters || [];
    const idx = chs.findIndex((c) => Number(c.id) === this.currentChapterId);
    const next = chs[idx + delta];
    if (next) this.openChapter(Number(next.id));
  }

  _updateNavButtons() {
    const chs = this.bookData?.chapters || [];
    const idx = chs.findIndex((c) => Number(c.id) === this.currentChapterId);
    this.els.btnPrev.disabled = idx <= 0;
    this.els.btnNext.disabled = idx < 0 || idx >= chs.length - 1;
  }

  _scheduleSaveProgress(scrollPct = null) {
    if (!this.bookData || !this.currentChapterId) return;
    clearTimeout(this.progressTimer);
    this.progressTimer = setTimeout(() => {
      const vp = this.els.viewport;
      const pct = scrollPct !== null ? scrollPct
        : ((vp.scrollTop / Math.max(1, vp.scrollHeight - vp.clientHeight)) * 100);
      BiblioAPI.saveProgress({
        book_id: Number(this.bookData.book.id),
        current_chapter_id: this.currentChapterId,
        scroll_percent: Number(pct.toFixed(2)),
        reader_theme: this.theme,
        font_size: this.fontSize
      }).catch(() => {});
    }, 650);
  }

  _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  }
}

window.EpubReaderController = EpubReaderController;
