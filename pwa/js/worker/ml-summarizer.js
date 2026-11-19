/**
 * Resumen extractivo por capítulo y global con ML clásico (sin LLM):
 * TF-IDF + Grafo coseno + TextRank (d=0.85) + Kindle Salience Boost + MMR (λ=0.72).
 */
(function (root) {
  const BiblioWorker = (root.BiblioWorker = root.BiblioWorker || {});

  class Summarizer {
    summarizeChapter(plainText, chapterNotes = [], numSentences = 5) {
      const { SpanishNLP, Utf8Helper, TfIdf } = BiblioWorker;
      const rawSentences = SpanishNLP.splitSentences(plainText);

      if (rawSentences.length === 0) {
        return {
          summary_text: '',
          sentences: [],
          metrics: { total_sentences: 0, iterations: 0, kindle_boosted: 0 }
        };
      }

      const candidates = [];
      rawSentences.forEach((s, idx) => {
        if (s.length < 40 && rawSentences.length > 10) return;
        const tokens = SpanishNLP.tokenizeClean(s, true);
        if (tokens.length < 4 && rawSentences.length > 10) return;
        candidates.push({
          orig_index: idx,
          text: s,
          tokens,
          norm: Utf8Helper.normalizeForMatch(s)
        });
      });

      if (candidates.length === 0) {
        const first = rawSentences.slice(0, Math.min(numSentences, rawSentences.length));
        return {
          summary_text: first.join(' '),
          sentences: first.map((t, i) => ({
            index: i, text: t, score: 1.0, textrank: 1.0, centroid_sim: 1.0, kindle_match: false
          })),
          metrics: { total_sentences: rawSentences.length, iterations: 0, kindle_boosted: 0 }
        };
      }

      const noteNorms = [];
      const noteTokensAll = [];
      for (const n of chapterNotes) {
        if (n.highlight_text) {
          noteNorms.push(Utf8Helper.normalizeForMatch(n.highlight_text));
          noteTokensAll.push(...SpanishNLP.tokenizeClean(n.highlight_text, true));
        }
        if (n.user_note) {
          noteTokensAll.push(...SpanishNLP.tokenizeClean(n.user_note, true));
        }
      }

      const tfidf = new TfIdf();
      tfidf.fit(candidates.map((c) => c.tokens));
      const vectors = candidates.map((c) => tfidf.transform(c.tokens));
      const centroid = TfIdf.centroid(vectors);
      const kindleVec = noteTokensAll.length > 0 ? tfidf.transform(noteTokensAll) : {};

      const totalCand = candidates.length;
      const prelim = candidates.map((c, i) => {
        const centSim = TfIdf.cosine(vectors[i], centroid);
        let kOverlap = 0.0;
        let directKindle = false;

        for (const nn of noteNorms) {
          if (nn.length >= 20) {
            const p1 = nn.slice(0, Math.min(40, nn.length));
            const p2 = c.norm.slice(0, Math.min(40, c.norm.length));
            if (c.norm.includes(p1) || nn.includes(p2)) {
              directKindle = true;
              kOverlap = 1.0;
              break;
            }
          }
        }
        if (!directKindle && noteTokensAll.length > 0) {
          kOverlap = TfIdf.cosine(vectors[i], kindleVec);
        }

        const posRatio = totalCand > 1 ? i / (totalCand - 1) : 0.0;
        const posPrior = posRatio < 0.12
          ? (1.0 - posRatio * 4.0)
          : (posRatio > 0.88 ? ((posRatio - 0.88) * 4.0) : 0.25);

        const charLen = c.text.length;
        const lenFactor = charLen > 480 ? Math.max(0.55, 480.0 / charLen) : (charLen < 70 ? 0.80 : 1.0);

        return {
          idx: i,
          centroid_sim: centSim,
          kindle_score: kOverlap,
          direct_kindle: directKindle,
          pos_prior: posPrior,
          len_factor: lenFactor,
          pre_score: (centSim * 0.65 + kOverlap * 0.25 + posPrior * 0.10) * lenFactor
        };
      });

      const maxGraphNodes = 140;
      let graphIndices = prelim.map((_, i) => i);
      if (graphIndices.length > maxGraphNodes) {
        graphIndices.sort((a, b) => prelim[b].pre_score - prelim[a].pre_score);
        graphIndices = graphIndices.slice(0, maxGraphNodes).sort((a, b) => a - b);
      }

      const m = graphIndices.length;
      const adj = Array.from({ length: m }, () => []);
      const weightSum = new Float64Array(m);

      for (let a = 0; a < m; a++) {
        const va = vectors[graphIndices[a]];
        for (let b = a + 1; b < m; b++) {
          const sim = TfIdf.cosine(va, vectors[graphIndices[b]]);
          if (sim > 0.06) {
            adj[a].push([b, sim]);
            adj[b].push([a, sim]);
            weightSum[a] += sim;
            weightSum[b] += sim;
          }
        }
      }

      const damping = 0.85;
      let pr = new Float64Array(m).fill(1.0 / Math.max(1, m));
      let iterations = 0;

      for (let iter = 1; iter <= 35; iter++) {
        iterations = iter;
        const newPr = new Float64Array(m).fill((1.0 - damping) / Math.max(1, m));
        for (let u = 0; u < m; u++) {
          if (weightSum[u] <= 0.0) continue;
          const share = (damping * pr[u]) / weightSum[u];
          for (const [v, w] of adj[u]) {
            newPr[v] += share * w;
          }
        }
        let diff = 0.0;
        for (let u = 0; u < m; u++) diff += Math.abs(newPr[u] - pr[u]);
        pr = newPr;
        if (diff < 1e-5) break;
      }

      let maxPr = 0.0;
      for (let u = 0; u < m; u++) if (pr[u] > maxPr) maxPr = pr[u];
      if (maxPr <= 0.0) maxPr = 1.0;

      const scores = new Map();
      graphIndices.forEach((candIdx, localIdx) => {
        const trNorm = pr[localIdx] / maxPr;
        const p = prelim[candIdx];
        const composite = (
          0.52 * trNorm +
          0.26 * p.centroid_sim +
          0.08 * p.pos_prior +
          0.14 * p.kindle_score
        ) * p.len_factor;

        scores.set(candIdx, {
          cand_idx: candIdx,
          composite,
          textrank: trNorm,
          centroid_sim: p.centroid_sim,
          kindle_score: p.kindle_score,
          direct_kindle: p.direct_kindle
        });
      });

      const targetK = Math.min(numSentences, scores.size);
      const lambda = 0.72;
      const selected = [];
      const remaining = new Set(scores.keys());

      while (selected.length < targetK && remaining.size > 0) {
        let bestIdx = null;
        let bestMmr = -Infinity;

        for (const cIdx of remaining) {
          const rel = scores.get(cIdx).composite;
          let maxRed = 0.0;
          for (const sIdx of selected) {
            const sim = TfIdf.cosine(vectors[cIdx], vectors[sIdx]);
            if (sim > maxRed) maxRed = sim;
          }
          const mmr = lambda * rel - (1.0 - lambda) * maxRed;
          if (mmr > bestMmr) {
            bestMmr = mmr;
            bestIdx = cIdx;
          }
        }
        if (bestIdx === null) break;
        selected.push(bestIdx);
        remaining.delete(bestIdx);
      }

      selected.sort((a, b) => a - b);

      let kindleBoostedCount = 0;
      const resultSentences = selected.map((cIdx) => {
        const sc = scores.get(cIdx);
        if (sc.direct_kindle || sc.kindle_score > 0.18) kindleBoostedCount++;
        return {
          index: candidates[cIdx].orig_index,
          text: candidates[cIdx].text,
          score: Number(sc.composite.toFixed(4)),
          textrank: Number(sc.textrank.toFixed(4)),
          centroid_sim: Number(sc.centroid_sim.toFixed(4)),
          kindle_match: sc.direct_kindle
        };
      });

      return {
        summary_text: resultSentences.map((s) => s.text).join(' '),
        sentences: resultSentences,
        metrics: {
          total_sentences: rawSentences.length,
          graph_nodes: m,
          iterations,
          kindle_boosted: kindleBoostedCount
        }
      };
    }

    summarizeGlobal(chapterSummariesList, allNotes = [], numSentences = 7) {
      const pool = [];
      for (const ch of chapterSummariesList) {
        if (ch && Array.isArray(ch.sentences)) {
          for (const s of ch.sentences.slice(0, 2)) {
            pool.push(s.text);
          }
        }
      }
      if (pool.length === 0) return '';
      const res = this.summarizeChapter(pool.join('\n\n'), allNotes, numSentences);
      return res.summary_text;
    }
  }

  BiblioWorker.Summarizer = Summarizer;
})(self);
