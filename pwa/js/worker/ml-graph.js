/**
 * Construcción del grafo de relaciones entre personajes (sin LLM):
 * Co-ocurrencia en ventana deslizante + PMI + Léxico afectivo + PageRank + Louvain (Modularidad).
 */
(function (root) {
  const BiblioWorker = (root.BiblioWorker = root.BiblioWorker || {});

  const POSITIVE_LEXICON = new Set([
    'amor','amar','amaba','cariño','ternura','amistad','amiga','amigo','compasión','placer','alegría',
    'feliz','felicidad','apoyo','cuidado','cuidar','comprensión','respeto','sabiduría','libertad',
    'libre','confianza','sonrisa','sonrió','abrazó','besó','dulce','dulzura','proteger','calma',
    'paz','belleza','inteligencia','admiración','risa','reía','esperanza','solidaridad','honesto',
    'noble','bondad','afecto','complicidad','entusiasmo','armonía','equilibrio','generosidad'
  ]);

  const NEGATIVE_LEXICON = new Set([
    'odio','odiar','odiaba','violencia','miedo','terror','cólera','ira','celos','engaño','engañó',
    'muerte','morir','murió','asesino','matar','golpe','latigazos','desprecio','culpa','culpabilidad',
    'represión','humillación','rencor','miserable','llanto','lloraba','tristeza','destruir','crueldad',
    'veneno','envenenó','traición','venganza','amenaza','amenazando','cárcel','locos','infierno',
    'frustración','agresividad','resentimiento','envidia','abyección','opresión','dominar','dominación',
    'explotar','explotación','sufrimiento','dolor','heridas','desesperación','derrumbó','vencida',
    'temía','temor','furia','rabia','salvajemente','gritó','insulto','castiga','maldad'
  ]);

  const GENERIC_CTX_WORDS = new Set([
    'casa','hombre','hombres','mujer','mujeres','años','año','vida',
    'haber','ojos','través','mundo','instante','tiempo','noche','tarde',
    'mañana','cuerpo','rostro','cara','manos','mano','cabeza','puerta',
    'cuarto','mesa','silla','cama','calle','ciudad','gente','persona',
    'personas','palabra','palabras','voz','historia','primera','última',
    'llegar','volver','seguir','dejar','quedar','parecer','sentir','pensar',
    'creer','mirar','oír','escuchar','encontrar','llevar','tomar','darle'
  ]);

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  class RelationshipGraph {
    build(chaptersMap, characters) {
      const { SpanishNLP, Utf8Helper } = BiblioWorker;
      const nChars = characters.length;
      if (nChars === 0) {
        return { characters: [], edges: [], communities: [], modularity: 0.0 };
      }

      const keys = Object.keys(chaptersMap).sort((a, b) => Number(a) - Number(b));
      const patterns = [];
      const charWordSet = new Set();

      for (const char of characters) {
        const forms = [char.canonical_name, ...char.aliases].sort((a, b) => b.length - a.length);
        const escaped = forms.map(escapeRegExp);
        patterns.push(new RegExp(`(?:^|[^\\p{L}])(?:${escaped.join('|')})(?![\\p{L}])`, 'iu'));
        for (const f of forms) {
          for (const tw of SpanishNLP.tokenizeRaw(f)) charWordSet.add(tw.toLowerCase());
        }
      }

      let totalSentences = 0;
      const charSentCount = new Int32Array(nChars);
      const pairData = new Map();

      const addPairObs = (u, v, weight, chKey, tokens, pos, neg, sentence) => {
        const key = `${u}:${v}`;
        if (!pairData.has(key)) {
          pairData.set(key, {
            u, v, weight: 0.0, cooc: 0,
            chapters: new Set(), words: new Map(), pos: 0, neg: 0, evidence: []
          });
        }
        const p = pairData.get(key);
        p.weight += weight;
        p.cooc++;
        p.chapters.add(Number(chKey));
        p.pos += pos;
        p.neg += neg;
        for (const t of tokens) p.words.set(t, (p.words.get(t) || 0) + 1);
        if (sentence !== null && p.evidence.length < 3 && sentence.length <= 320) {
          p.evidence.push({ chapter_key: Number(chKey), text: sentence });
        }
      };

      for (const chKey of keys) {
        const sentences = SpanishNLP.splitSentences(chaptersMap[chKey].plain_text);
        const sCount = sentences.length;
        totalSentences += sCount;

        const sentChars = [];
        for (let s = 0; s < sCount; s++) {
          const present = [];
          for (let idx = 0; idx < nChars; idx++) {
            if (!characters[idx].chapters[chKey]) continue;
            if (patterns[idx].test(sentences[s])) {
              present.push(idx);
              charSentCount[idx]++;
            }
          }
          sentChars.push(present);
        }

        for (let s = 0; s < sCount; s++) {
          const here = sentChars[s];
          if (here.length === 0) continue;

          if (here.length >= 2) {
            const tokens = this._extractContextWords(sentences[s], charWordSet);
            const [pos, neg] = this._scoreSentiment(sentences[s]);
            for (let a = 0; a < here.length; a++) {
              for (let b = a + 1; b < here.length; b++) {
                const u = Math.min(here[a], here[b]);
                const v = Math.max(here[a], here[b]);
                addPairObs(u, v, 3.0, chKey, tokens, pos, neg, sentences[s]);
              }
            }
          }

          for (const [offset, w] of [[1, 1.2], [2, 0.5]]) {
            if (s + offset >= sCount) continue;
            const there = sentChars[s + offset];
            if (there.length === 0) continue;
            const comb = `${sentences[s]} ${sentences[s + offset]}`;
            let tokens = null;
            let pol = null;

            for (const c1 of here) {
              for (const c2 of there) {
                if (c1 === c2) continue;
                const u = Math.min(c1, c2);
                const v = Math.max(c1, c2);
                if (tokens === null) {
                  tokens = this._extractContextWords(comb, charWordSet);
                  pol = this._scoreSentiment(comb);
                }
                addPairObs(u, v, w, chKey, tokens, pol[0], pol[1], null);
              }
            }
          }
        }
      }

      const edges = [];
      const adj = Array.from({ length: nChars }, () => new Map());
      const totalSentsSafe = Math.max(1.0, totalSentences);

      for (const pd of pairData.values()) {
        if (pd.weight < 2.2) continue;
        const { u, v } = pd;
        const pu = (charSentCount[u] + 1.0) / (totalSentsSafe + 2.0);
        const pv = (charSentCount[v] + 1.0) / (totalSentsSafe + 2.0);
        const puv = (pd.cooc + 0.5) / (totalSentsSafe + 2.0);
        const pmi = Math.log(puv / (pu * pv));

        const totalPol = pd.pos + pd.neg;
        const sentiment = totalPol > 0 ? (pd.pos - pd.neg) / totalPol : 0.0;
        let tone = 'neutral';
        if (totalPol >= 3 && pd.pos >= 2 && pd.neg >= 2 && Math.abs(sentiment) < 0.25) {
          tone = 'ambivalente';
        } else if (sentiment >= 0.22) {
          tone = 'afinidad';
        } else if (sentiment <= -0.22) {
          tone = 'tensión';
        }

        const topCtx = Array.from(pd.words.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([w]) => Utf8Helper.ucfirst(w));

        const sharedChapters = Array.from(pd.chapters).sort((a, b) => a - b);

        edges.push({
          source_idx: u,
          target_idx: v,
          weight: Number(pd.weight.toFixed(2)),
          cooccurrence: pd.cooc,
          pmi_score: Number(pmi.toFixed(4)),
          sentiment_score: Number(sentiment.toFixed(4)),
          relation_tone: tone,
          context_words: topCtx,
          shared_chapters: sharedChapters,
          evidence: pd.evidence
        });

        adj[u].set(v, pd.weight);
        adj[v].set(u, pd.weight);
      }

      edges.sort((a, b) => b.weight - a.weight);

      const pagerank = this._computePageRank(adj, nChars);
      const maxDeg = Math.max(1, nChars - 1);
      const communities = this._detectCommunities(adj, nChars);
      const modularity = this._computeModularity(adj, communities, nChars);

      const updatedChars = characters.map((c, idx) => ({
        ...c,
        pagerank: Number(pagerank[idx].toFixed(6)),
        degree_centrality: Number((adj[idx].size / maxDeg).toFixed(6)),
        community_id: communities[idx]
      }));

      return {
        characters: updatedChars,
        edges,
        communities,
        modularity: Number(modularity.toFixed(4))
      };
    }

    _extractContextWords(text, charWordSet) {
      const { SpanishNLP } = BiblioWorker;
      const out = [];
      for (const w of SpanishNLP.tokenizeRaw(text)) {
        const lw = w.toLowerCase();
        if (lw.length < 4 || SpanishNLP.isStopword(lw) || charWordSet.has(lw) || GENERIC_CTX_WORDS.has(lw)) continue;
        out.push(lw);
      }
      return out;
    }

    _scoreSentiment(text) {
      let pos = 0, neg = 0;
      for (const w of BiblioWorker.SpanishNLP.tokenizeRaw(text)) {
        const lw = w.toLowerCase();
        if (POSITIVE_LEXICON.has(lw)) pos++;
        else if (NEGATIVE_LEXICON.has(lw)) neg++;
      }
      return [pos, neg];
    }

    _computePageRank(adj, n) {
      const damping = 0.85;
      let pr = new Float64Array(n).fill(1.0 / n);
      const wSum = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (const w of adj[i].values()) s += w;
        wSum[i] = s;
      }

      for (let iter = 0; iter < 40; iter++) {
        const newPr = new Float64Array(n).fill((1.0 - damping) / n);
        for (let u = 0; u < n; u++) {
          if (wSum[u] <= 0.0) continue;
          const share = (damping * pr[u]) / wSum[u];
          for (const [v, w] of adj[u].entries()) {
            newPr[v] += share * w;
          }
        }
        let diff = 0.0;
        for (let i = 0; i < n; i++) diff += Math.abs(newPr[i] - pr[i]);
        pr = newPr;
        if (diff < 1e-6) break;
      }
      return pr;
    }

    _detectCommunities(adj, n) {
      const gamma = 1.15;
      const k = new Float64Array(n);
      let twoM = 0.0;
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (const w of adj[i].values()) s += w;
        k[i] = s;
        twoM += s;
      }
      if (twoM <= 0.0) return Array.from({ length: n }, (_, i) => i);

      const comm = Array.from({ length: n }, (_, i) => i);
      const sigmaTot = new Float64Array(k);
      const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => k[a] - k[b]);

      for (let pass = 0; pass < 25; pass++) {
        let moved = false;
        for (const u of order) {
          if (adj[u].size === 0) continue;
          const oldC = comm[u];
          const ku = k[u];

          const kIn = new Map();
          for (const [v, w] of adj[u].entries()) {
            const cv = comm[v];
            kIn.set(cv, (kIn.get(cv) || 0.0) + w);
          }

          sigmaTot[oldC] -= ku;
          let bestC = oldC;
          let bestGain = (kIn.get(oldC) || 0.0) - gamma * ((sigmaTot[oldC] * ku) / twoM);

          for (const [candC, wIn] of kIn.entries()) {
            if (candC === oldC) continue;
            const gain = wIn - gamma * ((sigmaTot[candC] * ku) / twoM);
            if (gain > bestGain + 1e-9) {
              bestGain = gain;
              bestC = candC;
            }
          }

          comm[u] = bestC;
          sigmaTot[bestC] += ku;
          if (bestC !== oldC) moved = true;
        }
        if (!moved) break;
      }

      const counts = new Map();
      for (const c of comm) counts.set(c, (counts.get(c) || 0) + 1);
      const remap = new Map();
      let cid = 0;
      for (const [old] of Array.from(counts.entries()).sort((a, b) => b[1] - a[1])) {
        remap.set(old, cid++);
      }
      return comm.map((old) => remap.get(old));
    }

    _computeModularity(adj, communities, n) {
      let twoM = 0.0;
      const k = new Float64Array(n);
      for (let u = 0; u < n; u++) {
        let s = 0;
        for (const w of adj[u].values()) s += w;
        k[u] = s;
        twoM += s;
      }
      if (twoM <= 0.0) return 0.0;

      let q = 0.0;
      for (let u = 0; u < n; u++) {
        for (let v = 0; v < n; v++) {
          if (communities[u] !== communities[v]) continue;
          const auv = adj[u].get(v) || 0.0;
          q += auv - (k[u] * k[v]) / twoM;
        }
      }
      return q / twoM;
    }
  }

  BiblioWorker.RelationshipGraph = RelationshipGraph;
})(self);
