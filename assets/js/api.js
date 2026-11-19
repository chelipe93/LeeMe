/**
 * Cliente REST Vanilla JS para BiblioML API.
 */
const BiblioAPI = {
  base: 'api/index.php',

  async request(action, options = {}) {
    const params = new URLSearchParams({ action, ...(options.query || {}) });
    const url = `${this.base}?${params.toString()}`;
    const fetchOpts = { method: options.method || 'GET', headers: {} };

    if (options.json !== undefined) {
      fetchOpts.headers['Content-Type'] = 'application/json';
      fetchOpts.body = JSON.stringify(options.json);
    } else if (options.formData !== undefined) {
      fetchOpts.body = options.formData;
    }

    const res = await fetch(url, fetchOpts);
    const data = await res.json().catch(() => ({ ok: false, error: `Error HTTP ${res.status}` }));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Error de servidor (${res.status})`);
    }
    return data;
  },

  health() { return this.request('health'); },
  saveDbConfig(cfg) { return this.request('save_db_config', { method: 'POST', json: cfg }); },
  listBooks() { return this.request('books'); },
  uploadBook(formData) { return this.request('upload', { method: 'POST', formData }); },
  importSample() { return this.request('import_sample', { method: 'POST' }); },
  deleteBook(bookId) { return this.request('delete_book', { method: 'POST', query: { book_id: bookId } }); },
  getBookDetail(bookId) { return this.request('book_detail', { query: { book_id: bookId } }); },
  getChapterContent(chapterId) { return this.request('chapter_content', { query: { chapter_id: chapterId } }); },
  saveProgress(payload) { return this.request('save_progress', { method: 'POST', json: payload }); },
  coverUrl(file) { return file ? `${this.base}?action=cover&file=${encodeURIComponent(file)}` : null; }
};
