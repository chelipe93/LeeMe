/**
 * Fachada 100% offline para LeeMe PWA.
 * Sustituye las llamadas HTTP PHP/MySQL por IndexedDB + EpubParser + Web Worker ML.
 */
class OfflineAPIImpl {
  constructor() {
    this.db = new BiblioDB();
    this.coverObjectUrls = new Map();
    this.activeChapterObjectUrls = [];
    this.sampleEpubRel = '../En diciembre llegaban las brisas/En diciembre llegaban las brisas -- Moreno, Marvel -- 2005 -- ePubLibre -- b609018def470cfb4ca11925665730e8 -- Anna\u2019s Archive.epub';
    this.samplePdfRel = '../En diciembre llegaban las brisas/Bloc de notas_ En diciembre llegaban las brisas -- Moreno, Marvel -- 2005 -- ePubLibre -- b609018def470cfb4ca11925665730e8 -- Anna\u2019s Archive.pdf';
  }

  async health() {
    await this.db.open();
    const estimate = await this.db.getStorageEstimate();
    let sampleAvailable = false;
    try {
      const resp = await fetch(encodeURI(this.sampleEpubRel), { method: 'HEAD' });
      sampleAvailable = resp.ok;
    } catch (_) {
      sampleAvailable = false;
    }
    return {
      ok: true,
      offline_ready: true,
      storage: estimate,
      sample: { available: sampleAvailable }
    };
  }

  async listBooks() {
    const books = await this.db.listBooks();
    return { ok: true, books };
  }

  coverUrl(book) {
    if (!book || !book.cover_blob) return null;
    if (this.coverObjectUrls.has(book.id)) {
      return this.coverObjectUrls.get(book.id);
    }
    const url = URL.createObjectURL(book.cover_blob);
    this.coverObjectUrls.set(book.id, url);
    return url;
  }

  async uploadBook(epubFile, pdfFile = null, onProgress = () => {}) {
    if (!epubFile) throw new Error('Debes seleccionar un archivo .epub.');
    const epubName = epubFile.name || 'libro.epub';
    if (!epubName.toLowerCase().endsWith('.epub')) {
      throw new Error('El archivo del libro debe tener extensión .epub');
    }
    if (pdfFile && pdfFile.name && !pdfFile.name.toLowerCase().endsWith('.pdf')) {
      throw new Error('El archivo de notas Kindle debe tener extensión .pdf');
    }

    onProgress(8, 'Leyendo y descomprimiendo archivo EPUB en el dispositivo…');
    const epubBuffer = await epubFile.arrayBuffer();
    const epubParser = new EpubParser();
    const epubData = await epubParser.parse(epubBuffer);

    let pdfBuffer = null;
    if (pdfFile) {
      onProgress(20, 'Preparando Bloc de Notas Kindle (PDF)…');
      pdfBuffer = await pdfFile.arrayBuffer();
    }

    const analysisResult = await this._runWorkerAnalysis(epubData, pdfBuffer, onProgress);

    onProgress(98, 'Guardando libro y análisis ML en IndexedDB…');
    const bookId = await this.db.saveFullBookAnalysis({
      ...analysisResult,
      cover_blob: epubData.cover_blob,
      assets: epubData.assets,
      epub_filename: epubName,
      pdf_filename: pdfFile ? pdfFile.name : null
    });

    onProgress(100, '¡Análisis completado!');
    return { ok: true, book_id: bookId };
  }

  async importSample(onProgress = () => {}) {
    onProgress(4, 'Cargando EPUB y notas Kindle de muestra…');
    const [epubRes, pdfRes] = await Promise.all([
      fetch(encodeURI(this.sampleEpubRel)),
      fetch(encodeURI(this.samplePdfRel)).catch(() => null)
    ]);
    if (!epubRes || !epubRes.ok) {
      throw new Error('Los archivos de muestra no están disponibles en este origen.');
    }

    const epubBlob = await epubRes.blob();
    const epubFile = new File([epubBlob], 'En diciembre llegaban las brisas.epub', { type: 'application/epub+zip' });

    let pdfFile = null;
    if (pdfRes && pdfRes.ok) {
      const pdfBlob = await pdfRes.blob();
      pdfFile = new File([pdfBlob], 'Bloc de notas_ En diciembre llegaban las brisas.pdf', { type: 'application/pdf' });
    }

    return this.uploadBook(epubFile, pdfFile, onProgress);
  }

  _runWorkerAnalysis(epubData, pdfBuffer, onProgress) {
    return new Promise((resolve, reject) => {
      const worker = new Worker('./js/worker/analyzer-worker.js');
      // Enviamos copia limpia sin Blobs ni buffers pesados al Worker
      const workerEpubPayload = {
        metadata: epubData.metadata,
        total_words: epubData.total_words,
        chapters: epubData.chapters
      };

      worker.onmessage = (e) => {
        const msg = e.data;
        if (!msg) return;
        if (msg.type === 'progress') {
          onProgress(msg.pct, msg.message);
        } else if (msg.type === 'done') {
          worker.terminate();
          resolve(msg.result);
        } else if (msg.type === 'error') {
          worker.terminate();
          reject(new Error(msg.error || 'Error en Web Worker de análisis ML.'));
        }
      };

      worker.onerror = (err) => {
        worker.terminate();
        reject(new Error(err.message || 'Fallo inesperado en el Web Worker.'));
      };

      const transferList = pdfBuffer ? [pdfBuffer] : [];
      worker.postMessage({ type: 'analyze', epubData: workerEpubPayload, pdfBuffer }, transferList);
    });
  }

  async deleteBook(bookId) {
    const id = Number(bookId);
    if (this.coverObjectUrls.has(id)) {
      URL.revokeObjectURL(this.coverObjectUrls.get(id));
      this.coverObjectUrls.delete(id);
    }
    return this.db.deleteBook(id);
  }

  async getBookDetail(bookId) {
    return this.db.getBookDetail(bookId);
  }

  async getChapterContent(chapterId) {
    this.revokeChapterAssets();
    return this.db.getChapterContent(chapterId);
  }

  createAssetObjectUrl(blob) {
    const url = URL.createObjectURL(blob);
    this.activeChapterObjectUrls.push(url);
    return url;
  }

  revokeChapterAssets() {
    for (const url of this.activeChapterObjectUrls) {
      URL.revokeObjectURL(url);
    }
    this.activeChapterObjectUrls = [];
  }

  async saveProgress(payload) {
    return this.db.saveProgress(payload);
  }

  async exportBookBackup(bookId) {
    return this.db.exportBookBackup(bookId);
  }

  async importBookBackup(file) {
    const text = await file.text();
    const json = JSON.parse(text);
    const bookId = await this.db.importBookBackup(json);
    return { ok: true, book_id: bookId };
  }
}

window.BiblioAPI = new OfflineAPIImpl();
