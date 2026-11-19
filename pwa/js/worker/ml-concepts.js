/**
 * Extracción de conceptos clave y frases temáticas mediante ML clásico:
 * TF-IDF corpus + RAKE + Colocaciones Bigramas PMI + Temas de notas Kindle.
 */
(function (root) {
  const BiblioWorker = (root.BiblioWorker = root.BiblioWorker || {});

  class ConceptExtractor {
    extract(chaptersMap, notesByChapter = {}, characterNamesLower = new Set()) {
      const { SpanishNLP, Utf8Helper, TfIdf } = BiblioWorker;
      const keys = Object.keys(chaptersMap).sort((a, b) => Number(a) - Number(b));

      const chapterTokens = {};
      const stemToSurface = new Map();
      const globalTokenFreq = new Map();
      const bigramFreq = new Map();
      let totalTokens = 0;

      for (const k of keys) {
        const ch = chaptersMap[k];
        const rawWords = SpanishNLP.tokenizeRaw(ch.plain_text);
        const stems = [];
        let prevClean = null;

        for (const w of rawWords) {
          const low = w.toLowerCase();
          if (low.length < 4 || SpanishNLP.isStopword(low) || characterNamesLower.has(low)) {
            prevClean = null;
            continue;
          }
          const stem = SpanishNLP.stem(low);
          stems.push(stem);

          if (!stemToSurface.has(stem)) stemToSurface.set(stem, new Map());
          const fMap = stemToSurface.get(stem);
          fMap.set(low, (fMap.get(low) || 0) + 1);

          globalTokenFreq.set(low, (globalTokenFreq.get(low) || 0) + 1);
          totalTokens++;

          if (prevClean !== null && prevClean !== low) {
            const bg = `${prevClean} ${low}`;
            bigramFreq.set(bg, (bigramFreq.get(bg) || 0) + 1);
          }
          prevClean = low;
        }
        chapterTokens[k] = stems;
      }

      const bestSurface = {};
      for (const [stem, forms] of stemToSurface.entries()) {
        let bestW = stem;
        let bestCnt = -1;
        for (const [form, cnt] of forms.entries()) {
          if (cnt > bestCnt) {
            bestCnt = cnt;
            bestW = form;
          }
        }
        bestSurface[stem] = bestW;
      }

      // Filtrado por DF / TF
      const numDocs = keys.length;
      const stemDf = new Map();
      for (const k of keys) {
        const seen = new Set();
        for (const st of chapterTokens[k]) {
          if (!seen.has(st)) {
            seen.add(st);
            stemDf.set(st, (stemDf.get(st) || 0) + 1);
          }
        }
      }

      const filteredChapterTokens = {};
      for (const k of keys) {
        const stems = chapterTokens[k];
        const chCounts = new Map();
        for (const st of stems) chCounts.set(st, (chCounts.get(st) || 0) + 1);

        const kept = [];
        for (const st of stems) {
          const df = stemDf.get(st) || 1;
          const tf = chCounts.get(st) || 1;
          if ((tf >= 2 || df >= 2) && (numDocs < 5 || df / numDocs <= 0.85)) {
            kept.push(st);
          }
        }
        filteredChapterTokens[k] = kept.length > 0 ? kept : stems;
      }

      const tfidf = new TfIdf();
      tfidf.fit(keys.map((k) => filteredChapterTokens[k]));

      const chapterVectors = {};
      const chapterKeywords = {};
      const globalTermScores = new Map();

      for (const k of keys) {
        const ch = chaptersMap[k];
        const vec = tfidf.transform(filteredChapterTokens[k]);
        chapterVectors[k] = vec;

        const boosted = { ...vec };
        const chNotes = notesByChapter[k] || [];
        const noteBoostStems = new Map();
        for (const n of chNotes) {
          const txt = `${n.user_note || ''} ${n.highlight_text || ''}`.trim();
          for (const st of SpanishNLP.tokenizeClean(txt, true)) {
            noteBoostStems.set(st, (noteBoostStems.get(st) || 0) + 1);
          }
        }
        for (const [st, cnt] of noteBoostStems.entries()) {
          if (boosted[st] !== undefined) {
            boosted[st] *= 1.0 + Math.min(0.6, 0.15 * cnt);
          }
        }

        const sortedStems = Object.entries(boosted).sort((a, b) => b[1] - a[1]);
        const topTerms = [];
        const usedLabels = new Set();

        for (const [stem, score] of sortedStems) {
          const label = bestSurface[stem] || stem;
          if (characterNamesLower.has(label) || usedLabels.has(label)) continue;
          usedLabels.add(label);
          topTerms.push({
            term: Utf8Helper.ucfirst(label),
            stem,
            score: Number(score.toFixed(4)),
            method: noteBoostStems.has(stem) ? 'TF-IDF + Kindle' : 'TF-IDF'
          });
          globalTermScores.set(stem, (globalTermScores.get(stem) || 0.0) + score);
          if (topTerms.length >= 10) break;
        }

        const rakePhrases = this._extractRakePhrases(ch.plain_text, characterNamesLower, 5);
        const readerTopics = this._extractReaderNoteTopics(chNotes);

        chapterKeywords[k] = {
          tfidf_terms: topTerms,
          rake_phrases: rakePhrases,
          reader_topics: readerTopics
        };
      }

      const globalConcepts = [];
      for (const [stem, score] of Array.from(globalTermScores.entries()).sort((a, b) => b[1] - a[1])) {
        const label = bestSurface[stem] || stem;
        if (characterNamesLower.has(label)) continue;
        globalConcepts.push({
          term: Utf8Helper.ucfirst(label),
          stem,
          score: Number(score.toFixed(4)),
          method: 'TF-IDF Global'
        });
        if (globalConcepts.length >= 24) break;
      }

      const pmiScores = [];
      if (totalTokens > 0) {
        for (const [bg, cnt] of bigramFreq.entries()) {
          if (cnt < 3) continue;
          const [w1, w2] = bg.split(' ');
          const f1 = globalTokenFreq.get(w1) || 1;
          const f2 = globalTokenFreq.get(w2) || 1;
          const pmi = Math.log((cnt * totalTokens) / (f1 * f2));
          if (pmi > 2.2) {
            pmiScores.push([bg, pmi * Math.log(1.0 + cnt)]);
          }
        }
        pmiScores.sort((a, b) => b[1] - a[1]);
      }

      const globalBigrams = pmiScores.slice(0, 14).map(([bg, sc]) => ({
        term: Utf8Helper.ucfirst(bg),
        score: Number(sc.toFixed(4)),
        method: 'Bigrama PMI'
      }));

      return {
        chapter_vectors: chapterVectors,
        chapter_keywords: chapterKeywords,
        global_concepts: globalConcepts,
        global_bigrams: globalBigrams,
        vocabulary_size: tfidf.getVocabularySize(),
        best_surface: bestSurface
      };
    }

    _extractRakePhrases(text, characterNamesLower, limit = 5) {
      const { SpanishNLP, Utf8Helper } = BiblioWorker;
      const chunks = String(text || '').split(/[.,;:!?¿¡()[\]"'«»“”—\-\n]+/);
      const phrases = [];

      for (const chunk of chunks) {
        const words = SpanishNLP.tokenizeRaw(chunk);
        let current = [];
        for (const w of words) {
          const low = w.toLowerCase();
          if (low.length < 3 || SpanishNLP.isStopword(low) || characterNamesLower.has(low)) {
            if (current.length >= 2 && current.length <= 3) phrases.push(current);
            current = [];
          } else {
            current.push(low);
          }
        }
        if (current.length >= 2 && current.length <= 3) phrases.push(current);
      }

      if (phrases.length === 0) return [];

      const wordFreq = new Map();
      const wordDeg = new Map();
      const phraseCounts = new Map();

      for (const p of phrases) {
        const key = p.join(' ');
        phraseCounts.set(key, (phraseCounts.get(key) || 0) + 1);
        const deg = p.length;
        for (const w of p) {
          wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
          wordDeg.set(w, (wordDeg.get(w) || 0) + deg);
        }
      }

      const phraseScores = [];
      for (const [key, cnt] of phraseCounts.entries()) {
        const words = key.split(' ');
        let sc = 0.0;
        for (const w of words) {
          sc += wordDeg.get(w) / Math.max(1, wordFreq.get(w));
        }
        phraseScores.push([key, sc * (1.0 + 0.5 * Math.log(cnt))]);
      }
      phraseScores.sort((a, b) => b[1] - a[1]);

      return phraseScores.slice(0, limit).map(([phrase, sc]) => ({
        term: Utf8Helper.ucfirst(phrase),
        score: Number(sc.toFixed(3)),
        method: 'RAKE'
      }));
    }

    _extractReaderNoteTopics(notes) {
      const { Utf8Helper } = BiblioWorker;
      const topics = [];
      const seen = new Set();
      for (const n of notes) {
        if (!n.user_note) continue;
        const txt = n.user_note.trim().replace(/[. ]+$/, '');
        if (!txt) continue;
        const short = txt.length > 55 ? `${txt.slice(0, 52)}…` : txt;
        const norm = Utf8Helper.normalizeForMatch(short);
        if (norm && !seen.has(norm)) {
          seen.add(norm);
          topics.push({
            term: short,
            page: n.page_number || null,
            full: txt
          });
        }
      }
      return topics;
    }
  }

  BiblioWorker.ConceptExtractor = ConceptExtractor;
})(self);
