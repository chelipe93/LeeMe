/**
 * Constructor de Mapas Mentales jerárquicos (Global Estructural, Global Temático K-Means++,
 * y Mapa Mental por Capítulo).
 */
(function (root) {
  const BiblioWorker = (root.BiblioWorker = root.BiblioWorker || {});

  function shortHash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  class MindMapBuilder {
    buildGlobalStructural(bookTitle, author, chaptersMap, chapterKeywords, characters, notesByChapter) {
      const keys = Object.keys(chaptersMap).sort((a, b) => Number(a) - Number(b));
      const byPart = new Map();

      for (const k of keys) {
        const part = chaptersMap[k].part_title || 'Desarrollo Principal';
        if (!byPart.has(part)) byPart.set(part, []);
        byPart.get(part).push(k);
      }

      const partNodes = [];
      let pIdx = 0;
      for (const [partName, chKeys] of byPart.entries()) {
        pIdx++;
        const chapterNodes = [];
        for (const k of chKeys) {
          const ch = chaptersMap[k];
          const kw = chapterKeywords[k] || { tfidf_terms: [], rake_phrases: [], reader_topics: [] };
          const chNotes = notesByChapter[k] || [];
          const leafChildren = [];

          for (const t of (kw.tfidf_terms || []).slice(0, 3)) {
            leafChildren.push({
              id: `g_ch_${k}_kw_${shortHash(t.term)}`,
              label: t.term,
              type: 'concept',
              meta: `Score TF-IDF: ${t.score} (${t.method})`,
              chapter_id: ch.chapter_index
            });
          }

          for (const cc of this._getTopCharsForChapter(characters, k, 2)) {
            leafChildren.push({
              id: `g_ch_${k}_char_${shortHash(cc.name)}`,
              label: cc.name,
              type: 'character',
              meta: `${cc.mentions} menciones en este capítulo`,
              chapter_id: ch.chapter_index
            });
          }

          for (const rt of (kw.reader_topics || []).slice(0, 2)) {
            leafChildren.push({
              id: `g_ch_${k}_note_${shortHash(rt.term)}`,
              label: `Nota: ${rt.term}`,
              type: 'note',
              meta: rt.full + (rt.page ? ` (Pág. ${rt.page})` : ''),
              chapter_id: ch.chapter_index
            });
          }

          chapterNodes.push({
            id: `g_ch_${k}`,
            label: ch.display_title,
            type: 'chapter',
            chapter_id: ch.chapter_index,
            meta: `${ch.word_count} palabras · ${chNotes.length} notas Kindle`,
            children: leafChildren
          });
        }

        partNodes.push({
          id: `g_part_${pIdx}`,
          label: (byPart.size > 1 && partName !== 'Desarrollo Principal') ? `Parte ${partName}` : partName,
          type: 'part',
          meta: `${chKeys.length} capítulos`,
          children: chapterNodes
        });
      }

      return {
        id: 'root_structural',
        label: bookTitle,
        subtitle: author,
        type: 'root',
        meta: 'Mapa Mental Global · Estructura Narrativa + ML',
        children: partNodes
      };
    }

    buildGlobalThematic(bookTitle, author, clusterResult, chaptersMap, chapterKeywords, notesByChapter, characters) {
      const clusterNodes = [];
      for (const cl of (clusterResult.clusters || [])) {
        const cid = cl.cluster_id;
        const children = [];

        const conceptChildren = (cl.top_terms || []).map((term) => ({
          id: `cl_${cid}_t_${shortHash(term)}`,
          label: term,
          type: 'concept',
          meta: 'Término dominante del centroide K-Means++'
        }));
        if (conceptChildren.length) {
          children.push({
            id: `cl_${cid}_concepts`,
            label: 'Conceptos del Clúster',
            type: 'group',
            children: conceptChildren
          });
        }

        const chChildren = [];
        const clusterNotes = [];
        for (const chKey of cl.members) {
          const ch = chaptersMap[chKey];
          if (!ch) continue;
          const kw = chapterKeywords[chKey] || {};
          for (const rt of (kw.reader_topics || [])) clusterNotes.push(rt);
          chChildren.push({
            id: `cl_${cid}_ch_${chKey}`,
            label: ch.display_title,
            type: 'chapter',
            chapter_id: ch.chapter_index,
            meta: `${ch.word_count} palabras · ${(notesByChapter[chKey] || []).length} notas Kindle`
          });
        }
        if (chChildren.length) {
          children.push({
            id: `cl_${cid}_chapters`,
            label: `Capítulos Asociados (${chChildren.length})`,
            type: 'group',
            children: chChildren
          });
        }

        if (clusterNotes.length) {
          children.push({
            id: `cl_${cid}_notes`,
            label: 'Notas Kindle Vinculadas',
            type: 'group',
            children: clusterNotes.slice(0, 5).map((rn, idx) => ({
              id: `cl_${cid}_rn_${idx}`,
              label: rn.term,
              type: 'note',
              meta: rn.full + (rn.page ? ` (Pág. ${rn.page})` : '')
            }))
          });
        }

        clusterNodes.push({
          id: `cl_${cid}`,
          label: cl.label,
          type: 'cluster',
          meta: `Clúster temático K-Means++ · ${cl.members.length} capítulos`,
          children
        });
      }

      const topChars = [...characters].sort((a, b) => (b.pagerank || 0) - (a.pagerank || 0)).slice(0, 8);
      if (topChars.length) {
        clusterNodes.push({
          id: 'global_characters_branch',
          label: 'Personajes Centrales (PageRank)',
          type: 'part',
          meta: 'Top personajes por centralidad en el grafo de co-ocurrencia',
          children: topChars.map((ch, idx) => ({
            id: `global_char_${idx}`,
            label: ch.canonical_name,
            type: 'character',
            meta: `Menciones: ${ch.mention_count} · PageRank: ${((ch.pagerank || 0) * 100).toFixed(1)}% · Rasgos: ${(ch.traits || []).slice(0, 3).join(', ')}`
          }))
        });
      }

      return {
        id: 'root_thematic',
        label: bookTitle,
        subtitle: `Clústeres ML (Spherical K-Means++) · Silhouette: ${clusterResult.silhouette || 0}`,
        type: 'root',
        meta: author,
        children: clusterNodes
      };
    }

    buildChapterMindMap(chKey, chapter, summaryData, keywordsData, characters, chapterNotes) {
      const branches = [];

      const conceptChildren = [];
      (keywordsData.tfidf_terms || []).slice(0, 6).forEach((t, idx) => {
        conceptChildren.push({
          id: `ch_${chKey}_tfidf_${idx}`,
          label: t.term,
          type: 'concept',
          meta: `Relevancia ${t.method}: ${t.score}`
        });
      });
      (keywordsData.rake_phrases || []).slice(0, 4).forEach((p, idx) => {
        conceptChildren.push({
          id: `ch_${chKey}_rake_${idx}`,
          label: p.term,
          type: 'phrase',
          meta: `Frase clave RAKE (score ${p.score})`
        });
      });
      if (conceptChildren.length) {
        branches.push({
          id: `ch_${chKey}_b_concepts`,
          label: 'Conceptos Clave (TF-IDF / RAKE)',
          type: 'cluster',
          children: conceptChildren
        });
      }

      const chChars = this._getTopCharsForChapter(characters, chKey, 7);
      if (chChars.length) {
        branches.push({
          id: `ch_${chKey}_b_chars`,
          label: 'Personajes del Capítulo',
          type: 'part',
          children: chChars.map((cc, idx) => ({
            id: `ch_${chKey}_char_${idx}`,
            label: `${cc.name} (${cc.mentions})`,
            type: 'character',
            meta: `Menciones en capítulo: ${cc.mentions} · Rasgos: ${(cc.traits || []).slice(0, 3).join(', ')}`
          }))
        });
      }

      if (summaryData && Array.isArray(summaryData.sentences) && summaryData.sentences.length) {
        branches.push({
          id: `ch_${chKey}_b_summary`,
          label: 'Núcleos Narrativos (TextRank)',
          type: 'group',
          children: summaryData.sentences.slice(0, 4).map((s, idx) => ({
            id: `ch_${chKey}_tr_${idx}`,
            label: s.text.length > 78 ? `${s.text.slice(0, 75)}…` : s.text,
            type: 'summary',
            meta: `${s.text} [TextRank: ${s.textrank}, Score: ${s.score}]`
          }))
        });
      }

      if (chapterNotes.length) {
        branches.push({
          id: `ch_${chKey}_b_notes`,
          label: `Tus Notas Kindle (${chapterNotes.length})`,
          type: 'note_group',
          children: chapterNotes.slice(0, 8).map((n, idx) => {
            const label = n.user_note || n.highlight_text || `Marcador pág. ${n.page_number || '?'}`;
            const short = label.length > 64 ? `${label.slice(0, 61)}…` : label;
            const meta = [
              n.page_number ? `Pág. ${n.page_number}` : '',
              n.highlight_text ? `«${n.highlight_text}»` : '',
              n.user_note ? `Nota: ${n.user_note}` : ''
            ].filter(Boolean).join(' · ');
            return {
              id: `ch_${chKey}_kn_${idx}`,
              label: short,
              type: 'note',
              meta
            };
          })
        });
      }

      return {
        id: `root_ch_${chKey}`,
        label: chapter.display_title,
        subtitle: `${chapter.word_count} palabras · ${chapterNotes.length} notas Kindle`,
        type: 'root',
        chapter_id: chapter.chapter_index,
        children: branches
      };
    }

    _getTopCharsForChapter(characters, chKey, limit) {
      const list = [];
      for (const c of characters) {
        const cnt = c.chapters[chKey] || 0;
        if (cnt > 0) {
          list.push({ name: c.canonical_name, mentions: cnt, traits: c.traits || [] });
        }
      }
      list.sort((a, b) => b.mentions - a.mentions);
      return list.slice(0, limit);
    }
  }

  BiblioWorker.MindMapBuilder = MindMapBuilder;
})(self);
