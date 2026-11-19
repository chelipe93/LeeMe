/**
 * Web Worker dedicado para análisis literario 100% offline (sin LLM).
 * Ejecuta PdfParser, KindleNotesParser, alineación de notas al EPUB y los 7 modelos ML.
 */
importScripts(
  './spanish-nlp.js',
  './pdf-parser.js',
  './kindle-parser.js',
  './ml-tfidf.js',
  './ml-summarizer.js',
  './ml-concepts.js',
  './ml-kmeans.js',
  './ml-characters.js',
  './ml-graph.js'
);

function alignNotesToChapters(notes, chapters) {
  const { Utf8Helper } = self.BiblioWorker;
  if (!notes.length || !chapters.length) return [];

  const chapNorm = new Map();
  const chapTitlesNorm = new Map();
  for (const ch of chapters) {
    chapNorm.set(ch.chapter_index, Utf8Helper.normalizeForMatch(ch.plain_text));
    chapTitlesNorm.set(ch.chapter_index, Utf8Helper.normalizeForMatch(ch.title));
  }

  for (const n of notes) {
    n.matched_chapter_index = null;
    n.match_confidence = 0.0;
    if (!n.highlight_text) continue;

    const hlNorm = Utf8Helper.normalizeForMatch(n.highlight_text);
    if (hlNorm.length < 6) continue;

    const probes = hlNorm.length <= 90
      ? [hlNorm]
      : [
          hlNorm.slice(0, 56),
          hlNorm.slice(Math.max(0, Math.floor(hlNorm.length / 2) - 24), Math.max(0, Math.floor(hlNorm.length / 2) - 24) + 48),
          hlNorm.slice(-48)
        ];

    let bestIdx = null;
    let bestScore = 0.0;

    for (const [chIdx, cText] of chapNorm.entries()) {
      if (!cText) continue;
      let hits = 0;
      for (const pr of probes) {
        if (pr.length >= 6 && cText.includes(pr)) hits++;
      }
      if (hits > 0) {
        const sc = 0.85 + 0.15 * (hits / probes.length);
        if (sc > bestScore) {
          bestScore = sc;
          bestIdx = chIdx;
        }
      }
    }

    if (bestIdx === null) {
      const words = hlNorm.split(' ');
      if (words.length >= 4) {
        const ngrams = [];
        for (let i = 0; i <= words.length - 3; i++) {
          ngrams.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
        }
        for (const [chIdx, cText] of chapNorm.entries()) {
          if (!cText) continue;
          let matched = 0;
          for (const ng of ngrams) {
            if (cText.includes(ng)) matched++;
          }
          const ratio = matched / Math.max(1, ngrams.length);
          if (ratio >= 0.45 && ratio > bestScore) {
            bestScore = ratio;
            bestIdx = chIdx;
          }
        }
      }
    }

    if (bestIdx !== null) {
      n.matched_chapter_index = bestIdx;
      n.match_confidence = Number(bestScore.toFixed(4));
    }
  }

  for (let i = 0; i < notes.length; i++) {
    if (notes[i].matched_chapter_index !== null) continue;
    const pdfLbl = Utf8Helper.normalizeForMatch(notes[i].pdf_chapter_label || '');

    let prevMatched = null;
    for (let p = i - 1; p >= 0; p--) {
      if (notes[p].matched_chapter_index !== null) { prevMatched = notes[p].matched_chapter_index; break; }
    }
    let nextMatched = null;
    for (let q = i + 1; q < notes.length; q++) {
      if (notes[q].matched_chapter_index !== null) { nextMatched = notes[q].matched_chapter_index; break; }
    }

    if (prevMatched !== null && nextMatched !== null && prevMatched === nextMatched) {
      notes[i].matched_chapter_index = prevMatched;
      notes[i].match_confidence = 0.7;
      continue;
    }

    if (pdfLbl) {
      for (const [chIdx, tNorm] of chapTitlesNorm.entries()) {
        if (tNorm === pdfLbl) {
          if (prevMatched !== null && chIdx < prevMatched) continue;
          notes[i].matched_chapter_index = chIdx;
          notes[i].match_confidence = 0.65;
          break;
        }
      }
    }

    if (notes[i].matched_chapter_index === null && (prevMatched !== null || nextMatched !== null)) {
      notes[i].matched_chapter_index = prevMatched !== null ? prevMatched : nextMatched;
      notes[i].match_confidence = 0.5;
    }
  }

  return notes;
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'parse_kindle') {
    try {
      const { KindleNotesParser } = self.BiblioWorker;
      const kp = new KindleNotesParser();
      const parsedNotes = await kp.parse(msg.pdfBuffer);
      const chapters = (msg.chapters || []).map((c) => ({
        ...c,
        plain_text: c.plain_text || String(c.html_content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      }));
      const alignedNotes = alignNotesToChapters(parsedNotes.items || [], chapters);
      self.postMessage({ type: 'kindle_parsed', notes: alignedNotes, stats: parsedNotes.stats });
    } catch (err) {
      self.postMessage({ type: 'error', message: err?.message || 'Error leyendo PDF Kindle.' });
    }
    return;
  }

  if (msg.type !== 'analyze') return;

  const progress = (pct, text) => self.postMessage({ type: 'progress', pct, message: text });

  try {
    const t0 = performance.now();
    const { epubData, pdfBuffer } = msg;
    const {
      KindleNotesParser, CharacterExtractor, RelationshipGraph,
      ConceptExtractor, KMeansClusterer, Summarizer
    } = self.BiblioWorker;

    const chapters = epubData.chapters || [];
    const narrativeChapters = {};
    for (const ch of chapters) {
      if (Number(ch.is_front_matter) === 0) {
        narrativeChapters[ch.chapter_index] = ch;
      }
    }
    if (Object.keys(narrativeChapters).length === 0) {
      for (const ch of chapters) {
        if (ch.word_count > 20) narrativeChapters[ch.chapter_index] = ch;
      }
    }
    const narrKeys = Object.keys(narrativeChapters).sort((a, b) => Number(a) - Number(b));

    let kindleStats = { total_declared: 0, highlights: 0, notes: 0, bookmarks: 0, pages_pdf: 0 };
    let kindleItems = [];
    if (pdfBuffer) {
      progress(28, 'Extrayendo subrayados y notas del PDF Kindle…');
      const kp = new KindleNotesParser();
      const parsedNotes = await kp.parse(pdfBuffer);
      kindleStats = parsedNotes.stats;
      kindleItems = parsedNotes.items;
    }

    progress(40, 'Alineando subrayados Kindle con los capítulos del EPUB…');
    const alignedNotes = alignNotesToChapters(kindleItems, chapters);
    const notesByChapter = {};
    for (const note of alignedNotes) {
      if (note.matched_chapter_index !== null) {
        if (!notesByChapter[note.matched_chapter_index]) notesByChapter[note.matched_chapter_index] = [];
        notesByChapter[note.matched_chapter_index].push(note);
      }
    }

    progress(52, 'Extrayendo personajes (NER estadístico + alias)…');
    const charResult = new CharacterExtractor().extract(narrativeChapters);
    let characters = charResult.characters;

    progress(64, 'Construyendo grafo de relaciones (PMI + Louvain + PageRank)…');
    const graphResult = new RelationshipGraph().build(narrativeChapters, characters);
    characters = graphResult.characters;
    const edges = graphResult.edges;

    progress(74, 'Extrayendo conceptos clave (TF-IDF + RAKE + Bigramas PMI)…');
    const conceptResult = new ConceptExtractor().extract(
      narrativeChapters,
      notesByChapter,
      charResult.lower_names
    );

    progress(82, 'Agrupando capítulos temáticamente (Spherical K-Means++)…');
    const clusterResult = new KMeansClusterer().cluster(
      conceptResult.chapter_vectors,
      conceptResult.best_surface
    );

    progress(88, 'Generando resúmenes extractivos (TextRank + Kindle Boost + MMR)…');
    const summarizer = new Summarizer();
    const chapterSummaries = {};
    let totalTextRankIters = 0;
    let totalKindleBoosted = 0;

    for (const k of narrKeys) {
      const sum = summarizer.summarizeChapter(narrativeChapters[k].plain_text, notesByChapter[k] || [], 5);
      chapterSummaries[k] = sum;
      totalTextRankIters += sum.metrics.iterations || 0;
      totalKindleBoosted += sum.metrics.kindle_boosted || 0;
    }
    const globalSummary = summarizer.summarizeGlobal(
      narrKeys.map((k) => chapterSummaries[k]),
      alignedNotes,
      7
    );

    const elapsedMs = Number((performance.now() - t0).toFixed(1));
    const matchedCount = alignedNotes.filter((n) => n.matched_chapter_index !== null).length;

    const mlStats = {
      elapsed_ms: elapsedMs,
      narrative_chapters: narrKeys.length,
      total_sections: chapters.length,
      total_words: epubData.total_words,
      vocabulary_size: conceptResult.vocabulary_size,
      textrank_avg_iters: narrKeys.length ? Number((totalTextRankIters / narrKeys.length).toFixed(1)) : 0,
      kindle_boosted_sents: totalKindleBoosted,
      kmeans_k: clusterResult.k,
      kmeans_silhouette: clusterResult.silhouette,
      kmeans_iterations: clusterResult.iterations,
      character_count: characters.length,
      relation_edges: edges.length,
      graph_modularity: graphResult.modularity,
      communities_count: new Set(characters.map((c) => c.community_id)).size,
      kindle_stats: kindleStats,
      kindle_items_aligned: matchedCount,
      kindle_items_total: alignedNotes.length,
      algorithms: {
        'Resumen': 'TextRank (PageRank d=0.85) + TF-IDF + Kindle Boost + MMR (λ=0.72)',
        'Conceptos': 'TF-IDF Corpus + RAKE + Colocaciones Bigramas PMI',
        'Agrupación Temática': 'Spherical K-Means++ (Distancia Coseno)',
        'Personajes': 'NER Estadístico por Características (Logístico) + Resolución de Alias + Rasgos TF-IDF',
        'Grafo Relaciones': 'Co-ocurrencia Ventana Deslizante + PMI + Léxico Afectivo + PageRank + Louvain (Modularidad)'
      }
    };

    // Limpiar plain_text de capítulos para ahorrar memoria en IndexedDB
    const cleanChapters = chapters.map(({ plain_text, ...rest }) => rest);

    self.postMessage({
      type: 'done',
      result: {
        metadata: epubData.metadata,
        total_words: epubData.total_words,
        chapters: cleanChapters,
        narrative_indices: narrKeys.map((k) => Number(k)),
        aligned_notes: alignedNotes,
        chapter_summaries: chapterSummaries,
        chapter_keywords: conceptResult.chapter_keywords,
        global_summary: globalSummary,
        global_keywords: {
          concepts: conceptResult.global_concepts,
          bigrams: conceptResult.global_bigrams
        },
        clusters: clusterResult.clusters,
        characters,
        edges,
        ml_stats: mlStats
      }
    });
  } catch (err) {
    self.postMessage({ type: 'error', error: err && err.message ? err.message : String(err) });
  }
};
