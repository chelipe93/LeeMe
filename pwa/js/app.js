/**
 * Controlador principal SPA para LeeMe PWA (100% Offline · IndexedDB + Web Worker).
 */
(() => {
  const state = {
    books: [],
    currentBook: null,
    activeTab: 'overview',
    graph: null,
    reader: null,
    deferredInstallPrompt: null
  };

  const els = {
    globalAlert: document.getElementById('globalAlert'),
    offlinePill: document.getElementById('offlineStatusPill'),
    offlineText: document.getElementById('offlineStatusText'),
    btnThemeToggle: document.getElementById('btnThemeToggle'),
    btnInstallApp: document.getElementById('btnInstallApp'),
    btnHelpInstall: document.getElementById('btnHelpInstall'),
    btnHomeBrand: document.getElementById('btnHomeBrand'),
    btnBackLibrary: document.getElementById('btnBackLibrary'),
    viewLibrary: document.getElementById('viewLibrary'),
    viewWorkspace: document.getElementById('viewWorkspace'),
    uploadForm: document.getElementById('uploadForm'),
    inputEpub: document.getElementById('inputEpub'),
    inputPdf: document.getElementById('inputPdf'),
    inputBackup: document.getElementById('inputBackupFile'),
    btnImportBackup: document.getElementById('btnImportBackup'),
    dzEpub: document.getElementById('dzEpub'),
    dzPdf: document.getElementById('dzPdf'),
    labelEpub: document.getElementById('labelEpub'),
    labelPdf: document.getElementById('labelPdf'),
    btnImportSample: document.getElementById('btnImportSample'),
    booksGrid: document.getElementById('booksGrid'),
    booksCountLabel: document.getElementById('booksCountLabel'),
    storageUsageLabel: document.getElementById('storageUsageLabel'),
    loadingOverlay: document.getElementById('loadingOverlay'),
    loadingText: document.getElementById('loadingText'),
    loadingProgressFill: document.getElementById('loadingProgressFill'),
    loadingProgressPct: document.getElementById('loadingProgressPct'),
    installModal: document.getElementById('installModal'),
    btnInstallModalClose: document.getElementById('btnInstallModalClose'),
    techInfoModal: document.getElementById('techInfoModal')
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));

  function showLoading(msg, pct = 5) {
    els.loadingText.textContent = msg || 'Procesando…';
    els.loadingProgressFill.style.width = `${pct}%`;
    els.loadingProgressPct.textContent = `${Math.round(pct)}%`;
    els.loadingOverlay.classList.remove('hidden');
  }

  function updateProgress(pct, msg) {
    if (msg) els.loadingText.textContent = msg;
    els.loadingProgressFill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    els.loadingProgressPct.textContent = `${Math.round(pct)}%`;
  }

  function hideLoading() {
    els.loadingOverlay.classList.add('hidden');
  }

  function showAlert(msg, type = 'warn') {
    els.globalAlert.className = `alert ${type}`;
    els.globalAlert.innerHTML = `<div>${msg}</div>`;
    els.globalAlert.classList.remove('hidden');
  }

  function hideAlert() {
    els.globalAlert.classList.add('hidden');
  }

  function applyGlobalTheme(theme) {
    const t = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = t;
    if (els.btnThemeToggle) {
      els.btnThemeToggle.textContent = t === 'dark' ? '☀️' : '🌙';
      els.btnThemeToggle.title = t === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro';
    }
    try { localStorage.setItem('leeme_ui_theme', t); } catch (_) {}
  }

  // ==================== INICIALIZACIÓN Y SERVICE WORKER ====================
  async function init() {
    let savedTheme = 'light';
    try {
      savedTheme = localStorage.getItem('leeme_ui_theme') ||
        (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    } catch (_) {}
    applyGlobalTheme(savedTheme);

    state.graph = new CharacterGraphRenderer(document.getElementById('graphCanvas'), {
      onSelectNode: renderGraphNodeInspector,
      onSelectEdge: renderGraphEdgeInspector
    });
    const refreshBookNotes = async (reopenChapter = true) => {
      if (!state.currentBook?.book?.id) return;
      const fresh = await BiblioAPI.getBookDetail(state.currentBook.book.id);
      state.currentBook = fresh;
      const curCh = state.reader.currentChapterId;
      state.reader.bookData = fresh;
      state.reader._renderToc();
      if (reopenChapter && curCh) {
        await state.reader.openChapter(curCh, { preserveScroll: true });
      }
      renderNotesTab();
      renderOverview();
    };

    state.reader = new EpubReaderController({
      onNavigateCharacter: (charId) => {
        switchTab('characters');
        setTimeout(() => state.graph.focusCharacter(charId), 120);
      },
      onCreateNote: async ({ chapter_id, highlight_text, user_note }) => {
        if (!state.currentBook?.book?.id) return;
        await BiblioAPI.addUserNote({
          book_id: state.currentBook.book.id,
          chapter_id,
          highlight_text,
          user_note
        });
        await refreshBookNotes(true);
      },
      onUpdateNote: async (noteId, patch) => {
        await BiblioAPI.updateNote(noteId, patch);
        await refreshBookNotes(true);
      },
      onDeleteNote: async (noteId) => {
        await BiblioAPI.deleteNote(noteId);
        await refreshBookNotes(true);
      }
    });

    bindEvents();
    registerServiceWorker();
    await checkEnvironmentAndLoad();
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js', { scope: './' })
        .then(() => updateConnectivityBadge())
        .catch(() => updateConnectivityBadge());
    }
    window.addEventListener('online', updateConnectivityBadge);
    window.addEventListener('offline', updateConnectivityBadge);

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.deferredInstallPrompt = e;
      els.btnInstallApp.classList.remove('hidden');
    });
    window.addEventListener('appinstalled', () => {
      state.deferredInstallPrompt = null;
      els.btnInstallApp.classList.add('hidden');
    });
  }

  function updateConnectivityBadge() {
    const isOnline = navigator.onLine;
    const swActive = Boolean(navigator.serviceWorker && navigator.serviceWorker.controller);
    if (!isOnline) {
      els.offlinePill.className = 'status-pill ok';
      els.offlineText.textContent = 'Sin conexión · 100% Local';
    } else if (swActive) {
      els.offlinePill.className = 'status-pill ok';
      els.offlineText.textContent = 'PWA Offline Lista · IndexedDB';
    } else {
      els.offlinePill.className = 'status-pill warn';
      els.offlineText.textContent = 'Modo Local · IndexedDB';
    }
  }

  function bindEvents() {
    els.btnHomeBrand.addEventListener('click', showLibraryView);
    els.btnBackLibrary.addEventListener('click', showLibraryView);
    els.offlinePill.addEventListener('click', () => els.installModal.classList.remove('hidden'));
    els.btnHelpInstall.addEventListener('click', () => els.installModal.classList.remove('hidden'));
    els.btnInstallModalClose.addEventListener('click', () => els.installModal.classList.add('hidden'));

    els.btnThemeToggle?.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyGlobalTheme(next);
    });

    els.btnInstallApp.addEventListener('click', async () => {
      if (!state.deferredInstallPrompt) return;
      state.deferredInstallPrompt.prompt();
      await state.deferredInstallPrompt.userChoice;
      state.deferredInstallPrompt = null;
      els.btnInstallApp.classList.add('hidden');
    });

    document.getElementById('btnQuickRead').addEventListener('click', () => switchTab('reader'));
    document.getElementById('btnQuickGraph').addEventListener('click', () => switchTab('characters'));
    document.getElementById('btnExitReaderFullscreen')?.addEventListener('click', () => switchTab('overview'));

    const btnSyncPdf = document.getElementById('btnSyncKindlePdf');
    const inpSyncPdf = document.getElementById('inputSyncKindlePdf');
    btnSyncPdf?.addEventListener('click', () => inpSyncPdf?.click());
    inpSyncPdf?.addEventListener('change', async () => {
      const f = inpSyncPdf.files[0];
      if (!f || !state.currentBook?.book?.id) return;
      showLoading('Sincronizando subrayados y notas de Kindle…', 55);
      try {
        const res = await BiblioAPI.syncKindlePdf(state.currentBook.book.id, f);
        inpSyncPdf.value = '';
        const fresh = await BiblioAPI.getBookDetail(state.currentBook.book.id);
        state.currentBook = fresh;
        state.reader.loadBook(fresh);
        renderOverview();
        renderNotesTab();
        showAlert(`Sincronización Kindle lista: ${res.added} nueva(s) y ${res.merged} combinada(s) con tus notas.`, 'ok');
      } catch (err) {
        showAlert(`Error sincronizando PDF Kindle: ${esc(err.message)}`, 'err');
      } finally {
        hideLoading();
      }
    });

    const openTechModal = () => els.techInfoModal?.classList.remove('hidden');
    const closeTechModal = () => els.techInfoModal?.classList.add('hidden');
    document.getElementById('btnOpenTechModal')?.addEventListener('click', openTechModal);
    document.getElementById('btnOpenTechCard')?.addEventListener('click', openTechModal);
    document.getElementById('btnTechModalClose')?.addEventListener('click', closeTechModal);
    document.getElementById('btnTechModalCloseX')?.addEventListener('click', closeTechModal);
    els.techInfoModal?.addEventListener('click', (e) => {
      if (e.target === els.techInfoModal) closeTechModal();
    });
    const setTechMode = (mode) => {
      const isSimple = mode !== 'technical';
      document.getElementById('btnTechSimple')?.classList.toggle('active', isSimple);
      document.getElementById('btnTechAdvanced')?.classList.toggle('active', !isSimple);
      document.getElementById('techPanelSimple')?.classList.toggle('hidden', !isSimple);
      document.getElementById('techPanelTechnical')?.classList.toggle('hidden', isSimple);
    };
    document.getElementById('btnTechSimple')?.addEventListener('click', () => setTechMode('simple'));
    document.getElementById('btnTechAdvanced')?.addEventListener('click', () => setTechMode('technical'));

    document.querySelectorAll('#workspaceTabs .tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    const setupDropzone = (dz, input, label) => {
      input.addEventListener('change', () => {
        const f = input.files[0];
        if (f) {
          dz.classList.add('has-file');
          label.textContent = `${f.name} (${(f.size / 1024 / 1024).toFixed(2)} MB)`;
        } else {
          dz.classList.remove('has-file');
        }
      });
      ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
        e.preventDefault();
        dz.classList.add('dragover');
      }));
      ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
        e.preventDefault();
        dz.classList.remove('dragover');
      }));
      dz.addEventListener('drop', (e) => {
        const files = e.dataTransfer.files;
        if (files && files.length) {
          input.files = files;
          input.dispatchEvent(new Event('change'));
        }
      });
    };
    setupDropzone(els.dzEpub, els.inputEpub, els.labelEpub);
    setupDropzone(els.dzPdf, els.inputPdf, els.labelPdf);

    els.uploadForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!els.inputEpub.files.length) {
        showAlert('Debes seleccionar al menos un archivo .epub.', 'warn');
        return;
      }
      const epubFile = els.inputEpub.files[0];
      const pdfFile = els.inputPdf.files.length ? els.inputPdf.files[0] : null;

      showLoading('Iniciando análisis offline con Machine Learning…', 4);
      hideAlert();
      try {
        const res = await BiblioAPI.uploadBook(epubFile, pdfFile, updateProgress);
        els.uploadForm.reset();
        els.dzEpub.classList.remove('has-file');
        els.dzPdf.classList.remove('has-file');
        els.labelEpub.textContent = 'Toca para elegir tu .epub';
        els.labelPdf.textContent = 'Toca para elegir tu Bloc .pdf';
        await loadBooks();
        await openBook(res.book_id);
      } catch (err) {
        showAlert(`Error analizando libro: ${esc(err.message)}`, 'err');
      } finally {
        hideLoading();
      }
    });

    els.btnImportSample.addEventListener('click', async () => {
      showLoading('Importando y analizando libro de muestra en el navegador…', 4);
      hideAlert();
      try {
        const res = await BiblioAPI.importSample(updateProgress);
        await loadBooks();
        await openBook(res.book_id);
      } catch (err) {
        showAlert(`Error importando muestra: ${esc(err.message)}`, 'err');
      } finally {
        hideLoading();
      }
    });

    els.btnImportBackup.addEventListener('click', () => els.inputBackup.click());

    document.getElementById('btnBackupLibrary').addEventListener('click', async () => {
      hideAlert();
      showLoading('Preparando el respaldo de toda tu biblioteca…', 60);
      try {
        const data = await BiblioAPI.exportLibraryBackup();
        const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        const stamp = new Date().toISOString().slice(0, 10);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `biblioteca-leeme-${stamp}.leeme.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        showAlert(`Respaldo listo: ${data.book_count} libro(s). Guarda el archivo en un lugar seguro (Drive, correo o tu PC) y usa «Restaurar respaldo» para recuperarlo.`, 'ok');
      } catch (err) {
        showAlert(`No se pudo crear el respaldo: ${esc(err.message)}`, 'err');
      } finally {
        hideLoading();
      }
    });
    els.inputBackup.addEventListener('change', async () => {
      const f = els.inputBackup.files[0];
      if (!f) return;
      showLoading('Restaurando respaldo LeeMe en IndexedDB…', 50);
      try {
        const res = await BiblioAPI.importBookBackup(f);
        els.inputBackup.value = '';
        await loadBooks();
        if (res.library) {
          showAlert(`Biblioteca restaurada: ${res.count} libro(s) recuperados.`, 'ok');
        } else {
          await openBook(res.book_id);
        }
      } catch (err) {
        showAlert(`Error importando respaldo: ${esc(err.message)}`, 'err');
      } finally {
        hideLoading();
      }
    });

    document.getElementById('inputSummarySearch').addEventListener('input', renderSummaries);

    // Grafo y personajes
    const rWeight = document.getElementById('rangeGraphWeight');
    const lWeight = document.getElementById('labelGraphWeight');
    const sGraphCh = document.getElementById('selectGraphChapter');
    const iGraphSearch = document.getElementById('inputGraphSearch');
    const updateGraphFilters = () => {
      lWeight.textContent = rWeight.value;
      state.graph.applyFilters({
        minWeight: Number(rWeight.value),
        chapterFilter: sGraphCh.value,
        searchTerm: iGraphSearch.value
      });
    };
    rWeight.addEventListener('input', updateGraphFilters);
    sGraphCh.addEventListener('change', updateGraphFilters);
    iGraphSearch.addEventListener('input', updateGraphFilters);
    document.getElementById('btnGraphReset').addEventListener('click', () => state.graph.resetCamera());
    document.getElementById('btnGraphRelayout').addEventListener('click', () => state.graph.relayout());
    document.getElementById('btnGraphExport').addEventListener('click', () => {
      const slug = (state.currentBook?.book?.title || 'libro').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      state.graph.exportPng(`grafo-leeme-${slug}.png`);
    });
    document.getElementById('selectCharSort').addEventListener('change', renderCharactersDirectory);

    document.getElementById('inputNoteSearch').addEventListener('input', renderNotesTab);
    document.getElementById('selectNoteChapter').addEventListener('change', renderNotesTab);
    document.getElementById('selectNoteType').addEventListener('change', renderNotesTab);
  }

  async function checkEnvironmentAndLoad() {
    try {
      const h = await BiblioAPI.health();
      if (h.sample && h.sample.available) {
        els.btnImportSample.classList.remove('hidden');
      }
      if (h.storage && h.storage.usage !== undefined) {
        const usedMb = (h.storage.usage / (1024 * 1024)).toFixed(1);
        els.storageUsageLabel.textContent = `Almacenamiento local: ${usedMb} MB usados`;
      }
      updateConnectivityBadge();
      await loadBooks();
    } catch (err) {
      showAlert(`Error inicializando almacenamiento offline: ${esc(err.message)}`, 'err');
    }
  }

  async function loadBooks() {
    const res = await BiblioAPI.listBooks();
    state.books = res.books || [];
    els.booksCountLabel.textContent = `${state.books.length} ${state.books.length === 1 ? 'libro' : 'libros'}`;

    const est = await BiblioAPI.db.getStorageEstimate();
    if (est && est.usage !== undefined) {
      els.storageUsageLabel.textContent = `Almacenamiento local: ${(est.usage / (1024 * 1024)).toFixed(1)} MB usados`;
    }

    if (state.books.length === 0) {
      els.booksGrid.innerHTML = `
        <div class="card" style="grid-column: 1 / -1; text-align:center; padding:32px;">
          <div style="font-size:34px; margin-bottom:8px;">📱📚</div>
          <h3 style="margin:0 0 6px;">Tu biblioteca en LeeMe está vacía</h3>
          <p class="muted" style="margin:0;">Sube un EPUB y tu PDF de notas Kindle arriba, o importa un respaldo <code>.leeme.json</code>. Todo queda guardado en este dispositivo sin servidores.</p>
        </div>`;
      return;
    }

    els.booksGrid.innerHTML = state.books.map((b) => {
      const cover = BiblioAPI.coverUrl(b);
      const coverEl = cover
        ? `<img class="book-cover" src="${cover}" alt="Portada">`
        : `<div class="book-cover">${esc((b.title || 'L').slice(0, 1).toUpperCase())}</div>`;

      return `
        <div class="book-card">
          <div class="book-card-top">
            ${coverEl}
            <div class="book-meta">
              <h3>${esc(b.title)}</h3>
              <div class="author">${esc(b.author)}</div>
              <div class="book-stats-mini">
                <span>📑 ${b.total_chapters} caps</span>
                <span>📝 ${Number(b.total_words).toLocaleString('es')} pal.</span>
                <span>🖍️ ${b.total_highlights} subr.</span>
                <span>💬 ${b.total_notes} notas</span>
                <span>👥 ${b.total_characters} pers.</span>
              </div>
            </div>
          </div>
          <div class="book-card-actions">
            <div style="display:flex; gap:6px; flex:1;">
              <button class="btn btn-primary btn-sm" data-read-book="${b.id}" style="flex:1;">📖 Leer</button>
              <button class="btn btn-outline btn-sm" data-open-book="${b.id}" style="flex:1;">📊 Análisis</button>
            </div>
            <div style="display:flex; gap:6px;">
              <button class="btn btn-outline btn-sm" data-export-book="${b.id}" title="Exportar respaldo portable">💾</button>
              <button class="btn btn-danger btn-sm" data-del-book="${b.id}" title="Eliminar libro">🗑️</button>
            </div>
          </div>
        </div>`;
    }).join('');

    els.booksGrid.querySelectorAll('[data-open-book]').forEach((btn) => {
      btn.addEventListener('click', () => openBook(Number(btn.dataset.openBook), 'overview'));
    });
    els.booksGrid.querySelectorAll('[data-read-book]').forEach((btn) => {
      btn.addEventListener('click', () => openBook(Number(btn.dataset.readBook), 'reader'));
    });
    els.booksGrid.querySelectorAll('[data-export-book]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        showLoading('Empaquetando respaldo portable…', 65);
        try {
          const data = await BiblioAPI.exportBookBackup(Number(btn.dataset.exportBook));
          const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
          const slug = (data.book.title || 'libro').toLowerCase().replace(/[^a-z0-9]+/g, '-');
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `${slug}.leeme.json`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        } catch (err) {
          showAlert(`Error exportando: ${esc(err.message)}`, 'err');
        } finally {
          hideLoading();
        }
      });
    });
    els.booksGrid.querySelectorAll('[data-del-book]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('¿Eliminar este libro y todos sus análisis de este dispositivo?')) return;
        try {
          await BiblioAPI.deleteBook(Number(btn.dataset.delBook));
          await loadBooks();
        } catch (err) {
          showAlert(`Error eliminando: ${esc(err.message)}`, 'err');
        }
      });
    });
  }

  function showLibraryView() {
    state.reader?.closeAllSheets();
    document.body.classList.remove('reader-immersive');
    els.viewWorkspace.classList.add('hidden');
    els.viewLibrary.classList.remove('hidden');
    els.btnBackLibrary.classList.add('hidden');
  }

  async function openBook(bookId, initialTab = 'overview') {
    showLoading('Abriendo libro desde IndexedDB…', 75);
    try {
      const detail = await BiblioAPI.getBookDetail(bookId);
      state.currentBook = detail;

      document.getElementById('wsTitle').textContent = detail.book.title;
      document.getElementById('wsAuthor').textContent = `${detail.book.author}${detail.book.publisher ? ' · ' + detail.book.publisher : ''}`;
      const wsCover = document.getElementById('wsCover');
      const coverUrl = BiblioAPI.coverUrl(detail.book);
      if (coverUrl) {
        wsCover.src = coverUrl;
        wsCover.classList.remove('hidden');
      } else {
        wsCover.classList.add('hidden');
      }

      const narrative = (detail.chapters || []).filter((c) => Number(c.is_front_matter) === 0);
      const chOptions = narrative.map((c) => `<option value="${c.id}">${esc(c.display_title)}</option>`).join('');
      document.getElementById('selectGraphChapter').innerHTML = `<option value="all">Todos los capítulos (Grafo Global)</option>${chOptions}`;
      document.getElementById('selectNoteChapter').innerHTML = `<option value="all">Todos los capítulos</option>` +
        (detail.chapters || []).map((c) => `<option value="${c.id}">${esc(c.display_title)}</option>`).join('');

      renderOverview();
      state.reader.loadBook(detail);
      renderSummaries();
      renderCharactersSection();
      renderNotesTab();

      els.viewLibrary.classList.add('hidden');
      els.viewWorkspace.classList.remove('hidden');
      els.btnBackLibrary.classList.remove('hidden');
      switchTab(initialTab);
    } catch (err) {
      showAlert(`Error cargando libro: ${esc(err.message)}`, 'err');
    } finally {
      hideLoading();
    }
  }

  function switchTab(tabName) {
    state.reader?.closeAllSheets();
    state.activeTab = tabName;
    document.body.classList.toggle('reader-immersive', tabName === 'reader');
    document.querySelectorAll('#workspaceTabs .tab-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-pane').forEach((p) => {
      p.classList.toggle('hidden', p.id !== `tab-${tabName}`);
    });
    if (tabName === 'characters') {
      setTimeout(() => {
        state.graph._resize();
        state.graph.alpha = Math.max(state.graph.alpha, 0.35);
      }, 40);
    }
  }

  // ==================== TAB 1: OVERVIEW ====================
  function renderOverview() {
    const d = state.currentBook;
    const stats = d.analysis?.stats || {};
    const kStats = stats.kindle_stats || {};

    const kpis = [
      { val: Number(d.book.total_words).toLocaleString('es'), label: 'Palabras Analizadas', sub: `${stats.narrative_chapters || d.book.total_chapters} capítulos narrativos` },
      { val: `${kStats.highlights || d.book.total_highlights} / ${kStats.notes || d.book.total_notes}`, label: 'Subrayados / Notas Kindle', sub: `${stats.kindle_items_aligned || 0}/${stats.kindle_items_total || 0} alineados` },
      { val: stats.character_count || d.characters.length, label: 'Personajes Extraídos', sub: `${stats.relation_edges || d.relations.length} vínculos · ${stats.communities_count || 0} comunidades` },
      { val: Number(stats.graph_modularity || 0).toFixed(3), label: 'Modularidad Louvain (Q)', sub: 'Cohesión de círculos narrativos' },
      { val: `${stats.kmeans_k || 0} clústeres`, label: 'Spherical K-Means++', sub: `Silhouette: ${Number(stats.kmeans_silhouette || 0).toFixed(3)}` },
      { val: `${((stats.elapsed_ms || 0) / 1000).toFixed(2)}s`, label: 'Tiempo ML Offline', sub: `Vocabulario: ${Number(stats.vocabulary_size || 0).toLocaleString('es')} stems` }
    ];

    document.getElementById('overviewKpis').innerHTML = kpis.map((k) => `
      <div class="kpi-card">
        <div class="kpi-val">${esc(k.val)}</div>
        <div class="kpi-label">${esc(k.label)}</div>
        <div class="kpi-sub">${esc(k.sub)}</div>
      </div>`).join('');

    document.getElementById('overviewSummary').textContent = d.book.global_summary || 'Sin resumen global disponible.';

    const clusters = d.analysis?.clusters || [];
    const chById = new Map(d.chapters.map((c) => [Number(c.id), c]));
    document.getElementById('overviewClusters').innerHTML = clusters.length
      ? clusters.map((cl, i) => {
          const chTags = (cl.member_chapter_ids || []).map((cid) => {
            const ch = chById.get(Number(cid));
            return ch ? `<span class="chip" style="cursor:pointer;" data-jump-ch="${ch.id}">${esc(ch.display_title)}</span>` : '';
          }).join('');
          return `
            <div style="padding:12px 14px; border:1px solid var(--border); border-radius:9px; margin-bottom:10px; background:var(--surface-soft);">
              <div style="font-weight:700; color:var(--primary); margin-bottom:4px;">Clúster ${i + 1}: ${esc(cl.label)}</div>
              <div class="muted" style="margin-bottom:8px;">Términos del centroide: ${esc((cl.top_terms || []).join(', '))}</div>
              <div class="ml-badges" style="margin-top:0;">${chTags}</div>
            </div>`;
        }).join('')
      : '<p class="muted">Sin clústeres disponibles.</p>';

    document.querySelectorAll('#overviewClusters [data-jump-ch]').forEach((el) => {
      el.addEventListener('click', () => jumpToReaderChapter(Number(el.dataset.jumpCh)));
    });

    const gkw = d.analysis?.global_keywords || {};
    const conceptChips = [
      ...(gkw.concepts || []).slice(0, 18).map((c) => `<span class="chip primary" title="TF-IDF Global: ${c.score}">${esc(c.term)}</span>`),
      ...(gkw.bigrams || []).slice(0, 10).map((b) => `<span class="chip accent" title="Bigrama PMI: ${b.score}">${esc(b.term)}</span>`)
    ];
    document.getElementById('overviewConcepts').innerHTML = conceptChips.join('') || '<span class="muted">Sin conceptos.</span>';

    const narrative = d.chapters.filter((c) => Number(c.is_front_matter) === 0);
    const maxWords = Math.max(1, ...narrative.map((c) => Number(c.word_count)));
    document.getElementById('overviewChapterBars').innerHTML = narrative.map((c) => {
      const pct = Math.max(4, Math.round((Number(c.word_count) / maxWords) * 100));
      const nc = Number(c.notes_count || 0);
      return `
        <div class="bar-row">
          <div class="bar-label" data-jump-ch="${c.id}" title="${esc(c.display_title)}">${esc(c.display_title)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
          <div class="bar-notes-tag">${nc > 0 ? `🖍️ ${nc} notas` : `${Number(c.word_count).toLocaleString('es')} p.`}</div>
        </div>`;
    }).join('');

    document.querySelectorAll('#overviewChapterBars [data-jump-ch]').forEach((el) => {
      el.addEventListener('click', () => jumpToReaderChapter(Number(el.dataset.jumpCh)));
    });

    const algos = stats.algorithms || {};
    document.getElementById('overviewAlgorithms').innerHTML = Object.entries(algos).map(([k, v]) => `
      <div style="padding:8px 10px; border-radius:7px; background:var(--surface-alt);">
        <strong style="color:var(--primary);">${esc(k)}:</strong> ${esc(v)}
      </div>`).join('');
  }

  // ==================== TAB 4: SUMMARIES ====================
  function renderSummaries() {
    const d = state.currentBook;
    if (!d) return;
    const q = (document.getElementById('inputSummarySearch').value || '').trim().toLowerCase();
    const narrative = d.chapters.filter((c) => Number(c.is_front_matter) === 0);
    const notesByCh = new Map();
    for (const n of d.notes || []) {
      const k = Number(n.chapter_id || 0);
      if (!notesByCh.has(k)) notesByCh.set(k, []);
      notesByCh.get(k).push(n);
    }

    const filtered = narrative.filter((c) => {
      if (!q) return true;
      const blob = `${c.display_title} ${c.summary_text || ''} ${(c.keywords?.tfidf_terms || []).map((t) => t.term).join(' ')}`.toLowerCase();
      return blob.includes(q);
    });

    const container = document.getElementById('summariesContainer');
    if (!filtered.length) {
      container.innerHTML = '<div class="card"><p class="muted">No hay capítulos que coincidan con el filtro.</p></div>';
      return;
    }

    container.innerHTML = filtered.map((c) => {
      const sents = c.summary?.sentences || [];
      const metrics = c.summary?.metrics || {};
      const kw = c.keywords || {};
      const chNotes = notesByCh.get(Number(c.id)) || [];
      const readerNotes = chNotes.filter((n) => n.user_note);

      return `
        <article class="summary-card">
          <div class="summary-card-head">
            <div>
              <h3>${esc(c.display_title)}</h3>
              <span class="muted">
                ${Number(c.word_count).toLocaleString('es')} palabras ·
                TextRank: ${metrics.iterations || 0} iteraciones ·
                ${chNotes.length} notas Kindle
              </span>
            </div>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              <button class="btn btn-primary btn-sm" data-open-read="${c.id}">📖 Leer EPUB</button>
            </div>
          </div>

          <div class="summary-prose">${esc(c.summary_text || 'Sin resumen disponible.')}</div>

          <div class="ml-badges" style="margin-top:12px;">
            ${(kw.tfidf_terms || []).slice(0, 7).map((t) => `<span class="chip primary">${esc(t.term)}</span>`).join('')}
            ${(kw.rake_phrases || []).slice(0, 3).map((p) => `<span class="chip accent">${esc(p.term)}</span>`).join('')}
          </div>

          ${readerNotes.length ? `
            <div style="margin-top:12px; padding:10px 12px; background:var(--accent-soft); border-radius:8px; font-size:13px;">
              <strong>Tus ideas clave en Kindle (${readerNotes.length}):</strong>
              ${readerNotes.slice(0, 6).map((rn) => `<span class="chip" style="background:var(--surface); margin:3px 4px 0 0;">${esc(rn.user_note)}</span>`).join('')}
            </div>` : ''}

          <details style="margin-top:12px;">
            <summary style="cursor:pointer; font-size:12.5px; font-weight:700; color:var(--primary);">
              Ver desglose ML de oraciones seleccionadas (${sents.length} frases · TextRank + TF-IDF + MMR)
            </summary>
            <div class="sent-breakdown">
              ${sents.map((s) => `
                <div class="sent-row">
                  <div>${esc(s.text)}</div>
                  <div class="sent-meta">
                    <span><strong>Score compuesto:</strong> ${s.score}</span>
                    <span><strong>TextRank:</strong> ${s.textrank}</span>
                    <span><strong>Sim. Centroide:</strong> ${s.centroid_sim}</span>
                    ${s.kindle_match ? `<span class="chip accent" style="padding:1px 7px;">★ Coincide con subrayado Kindle</span>` : ''}
                  </div>
                </div>`).join('')}
            </div>
          </details>
        </article>`;
    }).join('');

    container.querySelectorAll('[data-open-read]').forEach((b) => {
      b.addEventListener('click', () => jumpToReaderChapter(Number(b.dataset.openRead)));
    });
  }

  // ==================== TAB 5: CHARACTERS & GRAPH ====================
  function renderCharactersSection() {
    const d = state.currentBook;
    if (!d) return;

    const maxW = Math.max(20, ...d.relations.map((r) => Math.round(r.weight)));
    const slider = document.getElementById('rangeGraphWeight');
    slider.max = String(Math.min(120, Math.max(20, Math.round(maxW * 0.45))));
    const defaultMin = d.relations.length > 60 ? 12 : 4;
    slider.value = String(defaultMin);
    document.getElementById('labelGraphWeight').textContent = String(defaultMin);

    state.graph.minWeight = defaultMin;
    state.graph.chapterFilter = 'all';
    state.graph.searchTerm = '';
    state.graph.setData(d.characters || [], d.relations || []);

    const commIds = [...new Set((d.characters || []).map((c) => c.community_id))].sort((a, b) => a - b);
    document.getElementById('graphLegend').innerHTML = `
      <div style="font-size:12px; font-weight:700; margin-bottom:6px; color:var(--primary);">Comunidades Louvain</div>
      <div class="legend-row" style="margin-bottom:12px;">
        ${commIds.map((cid) => `
          <span class="legend-item">
            <span class="comm-dot" style="background:${state.graph.getCommunityColor(cid)}"></span>
            Círculo ${cid + 1}
          </span>`).join('')}
      </div>
      <div style="font-size:12px; font-weight:700; margin-bottom:6px; color:var(--primary);">Tono de Aristas (Léxico Afectivo)</div>
      <div class="legend-row">
        <span class="legend-item"><span class="comm-dot" style="background:#34d399"></span>Afinidad</span>
        <span class="legend-item"><span class="comm-dot" style="background:#f87171"></span>Tensión</span>
        <span class="legend-item"><span class="comm-dot" style="background:#fbbf24"></span>Ambivalente</span>
        <span class="legend-item"><span class="comm-dot" style="background:#94a3b8"></span>Neutral</span>
      </div>`;

    renderCharactersDirectory();
  }

  function renderGraphNodeInspector(node, incidentEdges) {
    const d = state.currentBook;
    const charById = new Map(d.characters.map((c) => [Number(c.id), c]));
    const chById = new Map(d.chapters.map((c) => [Number(c.id), c]));
    const firstCh = node.first_chapter_id ? chById.get(Number(node.first_chapter_id)) : null;

    const topLinks = incidentEdges.slice(0, 8).map((e) => {
      const otherId = e.source === node.id ? e.target : e.source;
      const other = charById.get(otherId);
      if (!other) return '';
      const toneClass = e.relation_tone === 'afinidad' ? 'success' : (e.relation_tone === 'tensión' ? 'danger' : 'accent');
      return `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 8px; border-radius:6px; background:var(--surface-soft); border:1px solid var(--border); cursor:pointer;" data-focus-char="${other.id}">
          <span style="font-size:13px; font-weight:600;">${esc(other.canonical_name)}</span>
          <span class="chip ${toneClass}" style="padding:1px 7px; font-size:11px;">${esc(e.relation_tone)} · ${e.weight}</span>
        </div>`;
    }).join('');

    const panel = document.getElementById('graphInspector');
    panel.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
        <span class="comm-dot" style="width:14px; height:14px; background:${state.graph.getCommunityColor(node.community_id)}"></span>
        <h3 style="margin:0; font-size:18px;">${esc(node.canonical_name)}</h3>
      </div>
      ${node.aliases?.length ? `<div class="muted" style="margin-bottom:8px;">Alias: ${esc(node.aliases.join(', '))}</div>` : ''}

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin:10px 0;">
        <div style="background:var(--surface-alt); padding:8px; border-radius:7px; text-align:center;">
          <div style="font-weight:800; font-size:17px; color:var(--primary);">${node.mention_count}</div>
          <div style="font-size:11px; color:var(--ink-soft);">Menciones</div>
        </div>
        <div style="background:var(--surface-alt); padding:8px; border-radius:7px; text-align:center;">
          <div style="font-weight:800; font-size:17px; color:var(--primary);">${(node.pagerank * 100).toFixed(1)}%</div>
          <div style="font-size:11px; color:var(--ink-soft);">PageRank</div>
        </div>
      </div>

      <div style="font-size:12.5px; color:var(--ink-soft); margin-bottom:10px;">
        Aparece en <strong>${node.chapter_count}</strong> capítulos · Círculo narrativo <strong>#${node.community_id + 1}</strong>
        ${firstCh ? `<br>Primera aparición: <a href="#" id="lnkFirstCh" style="color:var(--primary);">${esc(firstCh.display_title)}</a>` : ''}
      </div>

      ${node.traits?.length ? `
        <div style="margin-bottom:12px;">
          <div style="font-size:12px; font-weight:700; color:var(--primary); margin-bottom:5px;">Rasgos / Contexto (TF-IDF)</div>
          <div class="ml-badges" style="margin:0;">
            ${node.traits.map((t) => `<span class="chip primary">${esc(t)}</span>`).join('')}
          </div>
        </div>` : ''}

      <div style="margin-bottom:12px;">
        <div style="font-size:12px; font-weight:700; color:var(--primary); margin-bottom:6px;">Relaciones más fuertes (${incidentEdges.length})</div>
        <div style="display:flex; flex-direction:column; gap:5px;">${topLinks || '<span class="muted">Sin conexiones con el filtro actual.</span>'}</div>
      </div>

      ${node.sample_mentions?.length ? `
        <div>
          <div style="font-size:12px; font-weight:700; color:var(--primary); margin-bottom:6px;">Menciones en el Texto</div>
          ${node.sample_mentions.slice(0, 2).map((sm) => `
            <blockquote style="margin:0 0 8px; padding:8px 10px; border-left:3px solid var(--accent); background:var(--surface-soft); font-family:var(--font-serif); font-size:12.5px;">
              «${esc(sm.text)}»
            </blockquote>`).join('')}
        </div>` : ''}
    `;

    panel.querySelector('#lnkFirstCh')?.addEventListener('click', (e) => {
      e.preventDefault();
      jumpToReaderChapter(Number(node.first_chapter_id));
    });
    panel.querySelectorAll('[data-focus-char]').forEach((el) => {
      el.addEventListener('click', () => state.graph.focusCharacter(Number(el.dataset.focusChar)));
    });
  }

  function renderGraphEdgeInspector(edge, srcNode, tgtNode) {
    const chById = new Map(state.currentBook.chapters.map((c) => [Number(c.id), c]));
    const sharedTags = (edge.shared_chapters || []).map((cid) => {
      const ch = chById.get(Number(cid));
      return ch ? `<span class="chip" style="cursor:pointer;" data-jump-ch="${ch.id}">${esc(ch.display_title)}</span>` : '';
    }).join('');

    const panel = document.getElementById('graphInspector');
    panel.innerHTML = `
      <span class="chip accent" style="margin-bottom:8px;">Relación · ${esc(edge.relation_tone)}</span>
      <h3 style="margin:0 0 10px; font-size:16px;">${esc(srcNode?.canonical_name)} ↔ ${esc(tgtNode?.canonical_name)}</h3>

      <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; margin-bottom:12px;">
        <div style="background:var(--surface-alt); padding:7px; border-radius:7px; text-align:center;">
          <div style="font-weight:800; color:var(--primary);">${edge.weight}</div>
          <div style="font-size:10.5px;">Peso</div>
        </div>
        <div style="background:var(--surface-alt); padding:7px; border-radius:7px; text-align:center;">
          <div style="font-weight:800; color:var(--primary);">${edge.cooccurrence_count}</div>
          <div style="font-size:10.5px;">Co-ocurr.</div>
        </div>
        <div style="background:var(--surface-alt); padding:7px; border-radius:7px; text-align:center;">
          <div style="font-weight:800; color:var(--primary);">${Number(edge.pmi_score).toFixed(2)}</div>
          <div style="font-size:10.5px;">PMI</div>
        </div>
      </div>

      ${edge.context_words?.length ? `
        <div style="margin-bottom:12px;">
          <div style="font-size:12px; font-weight:700; color:var(--primary); margin-bottom:5px;">Vocabulario de Interacción</div>
          <div class="ml-badges" style="margin:0;">${edge.context_words.map((w) => `<span class="chip primary">${esc(w)}</span>`).join('')}</div>
        </div>` : ''}

      <div style="margin-bottom:12px;">
        <div style="font-size:12px; font-weight:700; color:var(--primary); margin-bottom:5px;">Capítulos Compartidos</div>
        <div class="ml-badges" style="margin:0;">${sharedTags}</div>
      </div>

      ${edge.evidence?.length ? `
        <div>
          <div style="font-size:12px; font-weight:700; color:var(--primary); margin-bottom:6px;">Evidencia Textual</div>
          ${edge.evidence.map((ev) => `
            <blockquote style="margin:0 0 8px; padding:8px 10px; border-left:3px solid var(--primary); background:var(--surface-soft); font-family:var(--font-serif); font-size:12.5px;">
              «${esc(ev.text)}»
            </blockquote>`).join('')}
        </div>` : ''}
    `;

    panel.querySelectorAll('[data-jump-ch]').forEach((el) => {
      el.addEventListener('click', () => jumpToReaderChapter(Number(el.dataset.jumpCh)));
    });
  }

  function renderCharactersDirectory() {
    const d = state.currentBook;
    if (!d) return;
    const sortBy = document.getElementById('selectCharSort').value;
    const narrative = d.chapters.filter((c) => Number(c.is_front_matter) === 0);
    const chars = [...(d.characters || [])];

    chars.sort((a, b) => {
      if (sortBy === 'pagerank') return b.pagerank - a.pagerank;
      if (sortBy === 'chapters') return b.chapter_count - a.chapter_count;
      if (sortBy === 'community') return (a.community_id - b.community_id) || (b.mention_count - a.mention_count);
      return b.mention_count - a.mention_count;
    });

    const grid = document.getElementById('charactersGrid');
    grid.innerHTML = chars.map((c) => {
      const counts = narrative.map((ch) => Number(c.chapters?.[String(ch.id)] || 0));
      const maxC = Math.max(1, ...counts);
      const spark = counts.map((v, i) => {
        const h = v > 0 ? Math.max(18, Math.round((v / maxC) * 100)) : 8;
        return `<div class="spark-bar ${v > 0 ? 'active' : ''}" style="height:${h}%" title="${esc(narrative[i].display_title)}: ${v} menciones"></div>`;
      }).join('');

      return `
        <div class="char-card" data-char-card="${c.id}">
          <div class="char-head">
            <div class="char-name">
              <span class="comm-dot" style="background:${state.graph.getCommunityColor(c.community_id)}"></span>
              ${esc(c.canonical_name)}
            </div>
            <span class="chip">${c.mention_count} menc.</span>
          </div>
          <div class="muted" style="font-size:12px;">
            PageRank: <strong>${(c.pagerank * 100).toFixed(1)}%</strong> ·
            ${c.chapter_count} caps · Círculo #${c.community_id + 1}
          </div>
          ${c.aliases?.length ? `<div class="muted" style="font-size:11.5px; margin-top:3px;">Alias: ${esc(c.aliases.join(', '))}</div>` : ''}
          <div class="ml-badges" style="margin-top:8px;">
            ${(c.traits || []).slice(0, 4).map((t) => `<span class="chip primary" style="font-size:11px; padding:2px 8px;">${esc(t)}</span>`).join('')}
          </div>
          <div class="sparkline" title="Presencia del personaje a lo largo de los capítulos">${spark}</div>
        </div>`;
    }).join('');

    grid.querySelectorAll('[data-char-card]').forEach((card) => {
      card.addEventListener('click', () => {
        state.graph.focusCharacter(Number(card.dataset.charCard));
        document.getElementById('tab-characters').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  // ==================== TAB 6: KINDLE NOTES ====================
  function renderNotesTab() {
    const d = state.currentBook;
    if (!d) return;
    const q = (document.getElementById('inputNoteSearch').value || '').trim().toLowerCase();
    const chFilter = document.getElementById('selectNoteChapter').value;
    const typeFilter = document.getElementById('selectNoteType').value;
    const chById = new Map(d.chapters.map((c) => [Number(c.id), c]));

    const filtered = (d.notes || []).filter((n) => {
      if (chFilter !== 'all' && String(n.chapter_id) !== chFilter) return false;
      if (typeFilter === 'with_note' && !n.user_note) return false;
      if (typeFilter === 'highlight' && n.note_type !== 'highlight') return false;
      if (typeFilter === 'note' && n.note_type !== 'note') return false;
      if (typeFilter === 'bookmark' && n.note_type !== 'bookmark') return false;
      if (q) {
        const blob = `${n.highlight_text || ''} ${n.user_note || ''} ${n.pdf_chapter_label || ''}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });

    document.getElementById('notesStatsBar').textContent = `Mostrando ${filtered.length} de ${(d.notes || []).length} notas y subrayados (Kindle + LeeMe).`;

    const container = document.getElementById('notesContainer');
    if (!filtered.length) {
      container.innerHTML = '<div class="card"><p class="muted">No hay notas que coincidan con los filtros seleccionados.</p></div>';
      return;
    }

    container.innerHTML = filtered.map((n) => {
      const ch = n.chapter_id ? chById.get(Number(n.chapter_id)) : null;
      const typeLabel = n.note_type === 'bookmark'
        ? `🔖 Marcador${n.highlight_color ? ' (' + n.highlight_color + ')' : ''}`
        : (n.note_type === 'note' ? '📝 Nota Personal' : `🖍️ Subrayado${n.highlight_color ? ' (' + n.highlight_color + ')' : ''}`);

      return `
        <div class="note-card type-${esc(n.note_type)}">
          <div class="note-meta">
            <div>
              <strong>${esc(typeLabel)}</strong>
              ${n.page_number ? ` · Página ${n.page_number}` : ''}
              ${ch ? ` · <span class="chip primary" style="padding:1px 8px;">${esc(ch.display_title)}</span>` : (n.pdf_chapter_label ? ` · Sección PDF: ${esc(n.pdf_chapter_label)}` : '')}
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              ${n.note_date ? `<span>${esc(n.note_date)}</span>` : ''}
              ${ch ? `<button class="btn btn-outline btn-sm" data-note-jump-ch="${ch.id}" data-note-jump-id="${n.id}">Ver en EPUB →</button>` : ''}
            </div>
          </div>
          ${n.highlight_text ? `<div class="note-quote">«${esc(n.highlight_text)}»</div>` : ''}
          ${n.user_note ? `<div class="note-user"><strong>Tu nota:</strong> ${esc(n.user_note)}</div>` : ''}
        </div>`;
    }).join('');

    container.querySelectorAll('[data-note-jump-ch]').forEach((btn) => {
      btn.addEventListener('click', () => {
        jumpToReaderChapter(Number(btn.dataset.noteJumpCh), Number(btn.dataset.noteJumpId));
      });
    });
  }

  function jumpToReaderChapter(chapterId, focusNoteId = null) {
    switchTab('reader');
    state.reader.openChapter(chapterId, { focusNoteId });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
