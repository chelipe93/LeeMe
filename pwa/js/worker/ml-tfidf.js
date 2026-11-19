/**
 * Motor TF-IDF (1 + log(tf)) + IDF suavizado + normalización L2.
 */
(function (root) {
  const BiblioWorker = (root.BiblioWorker = root.BiblioWorker || {});

  class TfIdf {
    constructor() {
      this.idf = new Map();
      this.docCount = 0;
    }

    fit(tokenizedDocs) {
      this.docCount = tokenizedDocs.length;
      const df = new Map();
      for (const tokens of tokenizedDocs) {
        const seen = new Set();
        for (const t of tokens) {
          if (!seen.has(t)) {
            seen.add(t);
            df.set(t, (df.get(t) || 0) + 1);
          }
        }
      }
      this.idf.clear();
      const n = this.docCount;
      for (const [term, count] of df.entries()) {
        this.idf.set(term, Math.log((n + 1.0) / (count + 1.0)) + 1.0);
      }
    }

    transform(tokens) {
      if (!tokens || tokens.length === 0) return {};
      const tf = new Map();
      for (const t of tokens) {
        tf.set(t, (tf.get(t) || 0) + 1);
      }
      const vec = {};
      let normSq = 0.0;
      const fallbackIdf = Math.log(this.docCount + 1.0) + 1.0;

      for (const [term, count] of tf.entries()) {
        const idfVal = this.idf.has(term) ? this.idf.get(term) : fallbackIdf;
        const w = (1.0 + Math.log(count)) * idfVal;
        vec[term] = w;
        normSq += w * w;
      }

      if (normSq > 0.0) {
        const inv = 1.0 / Math.sqrt(normSq);
        for (const term of Object.keys(vec)) {
          vec[term] *= inv;
        }
      }
      return vec;
    }

    static cosine(a, b) {
      const keysA = Object.keys(a || {});
      const keysB = Object.keys(b || {});
      if (keysA.length === 0 || keysB.length === 0) return 0.0;

      let small = a, large = b, keys = keysA;
      if (keysA.length > keysB.length) {
        small = b; large = a; keys = keysB;
      }
      let dot = 0.0;
      for (const k of keys) {
        if (large[k] !== undefined) dot += small[k] * large[k];
      }
      return dot;
    }

    static centroid(vectors) {
      const sum = {};
      for (const vec of vectors) {
        for (const [k, v] of Object.entries(vec)) {
          sum[k] = (sum[k] || 0.0) + v;
        }
      }
      let normSq = 0.0;
      for (const v of Object.values(sum)) normSq += v * v;
      if (normSq > 0.0) {
        const inv = 1.0 / Math.sqrt(normSq);
        for (const k of Object.keys(sum)) sum[k] *= inv;
      }
      return sum;
    }

    getVocabularySize() {
      return this.idf.size;
    }
  }

  BiblioWorker.TfIdf = TfIdf;
})(self);
