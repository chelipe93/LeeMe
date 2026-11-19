/**
 * Extractor clásico de personajes literarios (sin LLM):
 * NER estadístico por características (clasificador logístico), resolución de alias
 * y rasgos distintivos TF-IDF.
 */
(function (root) {
  const BiblioWorker = (root.BiblioWorker = root.BiblioWorker || {});

  const HONORIFICS = {
    'doña':'Doña','don':'Don','tía':'Tía','tío':'Tío','señor':'Señor','señora':'Señora','señorita':'Señorita',
    'doctor':'Doctor','doctora':'Doctora','padre':'Padre','madre':'Madre','hermana':'Hermana','hermano':'Hermano',
    'coronel':'Coronel','general':'General','capitán':'Capitán','profesor':'Profesor','profesora':'Profesora',
    'maestro':'Maestro','primo':'Primo','prima':'Prima','abuelo':'Abuelo','abuela':'Abuela',
    'míster':'Míster','monsieur':'Monsieur','madame':'Madame'
  };

  const PERSON_VERBS = new Set([
    'dijo','decía','preguntó','preguntaba','respondió','contestó','murmuró','gritó','susurró',
    'pensó','pensaba','miró','miraba','sonrió','sonreía','recordó','recordaba','oyó','oía',
    'sabía','supo','sentía','sintió','contó','contaba','contaría','escribió','escribía',
    'llamó','llamaba','habló','hablaba','lloró','lloraba','besó','abrazó','amaba','odiaba',
    'temía','quería','quiso','esperaba','esperó','decidió','había','estaba','fue','era',
    'tenía','tuvo','hizo','hacía','vio','veía','llegó','salió','entró','volvió','regresó',
    'caminó','levantó','acostó','mirándola','mirándolo','diciéndole','pidió','prometió',
    'explicó','afirmó','aseguró','confesó','gritaba','reía','rió','dormía','despertó',
    'comprendió','entendió','descubrió','sospechaba','imaginaba','soñaba','deseaba','buscaba',
    'encontró','conoció','conocía','casó','vivía','murió','falleció','nació','creció'
  ]);

  const NON_PERSON_TERMS = new Set([
    'barranquilla','cartagena','bogotá','medellín','cali','santa marta','colombia','parís','paris',
    'europa','américa','francia','españa','italia','alemania','inglaterra','rusia','méxico','argentina',
    'chile','perú','venezuela','cuba','roma','londres','madrid','barcelona','nueva york','venecia',
    'florencia','viena','berlín','ginebra','zurich','prado','el prado','san blas','caribe','atlántico',
    'magdalena','occidente','oriente','norte','sur','costa','interior','universidad','colegio',
    'iglesia','catedral','hospital','hotel','club','club cartagena','la enseñanza','enseñanza',
    'country','country club','bellavista','alto prado','bocas de ceniza','puerto colombia',
    'dios','señor dios','cristo','jesucristo','virgen','biblia','génesis','apocalipsis','evangelio',
    'iglesia católica','vaticano','cielo','infierno','paraíso','demonio','diablo','satanás',
    'navidad','carnaval','pascua','semana santa','cuaresma','ley','república','estado','patria',
    'partido','liberal','conservador','fascismo','nazismo','comunismo','marxismo','psicoanálisis',
    'guerra','segunda guerra','guerra mundial','violencia','bogotazo',
    'enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre',
    'noviembre','diciembre','lunes','martes','miércoles','jueves','viernes','sábado','domingo',
    'uno','dos','tres','cuatro','cinco','primera','segunda','tercera','epílogo','prólogo','capítulo',
    'parte','página','nota','notas','resaltar','amarillo','azul','marcador','kindle','cubierta',
    'sinopsis','dedicatoria','créditos','autor','autora','editorial','epublibre',
    'pero','porque','pues','aunque','cuando','mientras','entonces','donde','como','sobre','entre',
    'hacia','hasta','desde','para','contra','según','durante','mediante','sin','con','por','del',
    'las','los','una','unos','unas','este','esta','estos','estas','ese','esa','esos','esas',
    'aquel','aquella','aquellos','aquellas','ella','ellas','ellos','nosotros','vosotros','usted',
    'ustedes','quien','quienes','cual','cuales','todo','toda','todos','todas','nada','nadie',
    'algo','alguien','alguno','alguna','ninguno','ninguna','otro','otra','otros','otras','mismo',
    'tanto','tanta','mucho','mucha','poco','poca','cada','cualquier','siempre','nunca','jamás',
    'también','tampoco','todavía','ahora','después','antes','luego','aquí','allí','allá','así',
    'tal','solo','sólo','casi','quizá','quizás','acaso','incluso','además','apenas','pronto',
    'sí','no','ni','ya','yo','tú','él','mi','tu','su','sus','mis','tus','qué','cómo','cuándo',
    'dónde','porqué','hay','era','fue','son','ser','ver','dar','tan','muy','más','menos','bien',
    'mal','gran','tres','dos','uno','cien','mil','hoy','ayer','mañana','noche','tarde','día',
    'vida','muerte','amor','tiempo','mundo','casa','ciudad','calle','hombre','hombres','mujer',
    'mujeres','niña','niño','madre','padre','familia','gente','historia','guerra','tierra','agua',
    'fuego','aire','sol','luna','mar','río','flor','flores','árbol','luz','sombra','voz'
  ]);

  const LOCATION_PREPS = new Set(['en', 'hacia', 'desde', 'hasta', 'por']);
  const LOCATION_NOUNS = new Set([
    'ciudad','calle','plaza','avenida','barrio','pueblo','país','región',
    'club','colegio','escuela','universidad','iglesia','hotel','teatro',
    'café','bar','río','mar','océano','isla','montaña','aeropuerto',
    'puerto','viaje','viajes','oficina','parque','cementerio','hospital'
  ]);

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function buildEntityRegex(forms) {
    const sorted = [...forms].sort((a, b) => b.length - a.length);
    const escaped = sorted.map(escapeRegExp);
    return new RegExp(`(?:^|[^\\p{L}])(?:${escaped.join('|')})(?![\\p{L}])`, 'iu');
  }

  class CharacterExtractor {
    extract(chaptersMap) {
      const { SpanishNLP, Utf8Helper } = BiblioWorker;
      const keys = Object.keys(chaptersMap).sort((a, b) => Number(a) - Number(b));

      const lowerWordFreq = new Map();
      for (const k of keys) {
        for (const tok of SpanishNLP.tokenizeRaw(chaptersMap[k].plain_text)) {
          if (!Utf8Helper.isUpperStart(tok)) {
            const lw = tok.toLowerCase();
            lowerWordFreq.set(lw, (lowerWordFreq.get(lw) || 0) + 1);
          }
        }
      }

      const candidates = new Map();

      for (const chKey of keys) {
        const sentences = SpanishNLP.splitSentences(chaptersMap[chKey].plain_text);
        for (const sentence of sentences) {
          const tokens = this._tokenizeWithMeta(sentence);
          const n = tokens.length;
          let i = 0;

          while (i < n) {
            const tok = tokens[i];
            const low = tok.word.toLowerCase();
            let honPrefix = null;
            const startIdx = i;

            if (HONORIFICS[low] && i + 1 < n && tokens[i + 1].is_cap && !tokens[i + 1].after_punct) {
              honPrefix = HONORIFICS[low];
              i++;
            }

            if (i < n && tokens[i].is_cap && !this._isRoman(tokens[i].word) && !this._isAcronym(tokens[i].word)) {
              const parts = [tokens[i].word];
              let endIdx = i;
              let j = i + 1;

              while (j < n && parts.length < 3) {
                if (tokens[j].after_punct) break;
                if (tokens[j].is_cap && !this._isRoman(tokens[j].word) && !this._isAcronym(tokens[j].word)) {
                  parts.push(tokens[j].word);
                  endIdx = j;
                  j++;
                } else {
                  break;
                }
              }

              const nameOnly = parts.join(' ');
              const fullSurface = honPrefix ? `${honPrefix} ${nameOnly}` : nameOnly;
              const nameLower = nameOnly.toLowerCase();
              const fullLower = fullSurface.toLowerCase();

              if (nameOnly.length >= 3 && !NON_PERSON_TERMS.has(nameLower) && !NON_PERSON_TERMS.has(fullLower)) {
                const skipSingle = parts.length === 1 && SpanishNLP.isStopword(nameLower);
                if (!skipSingle) {
                  const isSentenceStart = startIdx === 0 || tokens[startIdx].after_sentence_end;
                  const prevLow = startIdx > 0 ? tokens[startIdx - 1].word.toLowerCase() : '';
                  const prev2Low = startIdx > 1 ? tokens[startIdx - 2].word.toLowerCase() : '';
                  const nextLow = endIdx + 1 < n ? tokens[endIdx + 1].word.toLowerCase() : '';
                  const next2Low = endIdx + 2 < n ? tokens[endIdx + 2].word.toLowerCase() : '';

                  const hasVerbCue = PERSON_VERBS.has(nextLow) || PERSON_VERBS.has(next2Low) || PERSON_VERBS.has(prevLow);
                  const hasLocationCue = (LOCATION_PREPS.has(prevLow) && LOCATION_NOUNS.has(prev2Low)) ||
                    LOCATION_NOUNS.has(prevLow) ||
                    (prevLow === 'en' && parts.length === 1 && honPrefix === null);

                  if (!candidates.has(fullLower)) {
                    candidates.set(fullLower, {
                      surface: fullSurface,
                      name_only: nameOnly,
                      honorific: honPrefix,
                      word_count: parts.length,
                      total: 0,
                      mid_sentence: 0,
                      verb_cues: 0,
                      honorific_cues: 0,
                      loc_cues: 0,
                      chapters: {}
                    });
                  }
                  const c = candidates.get(fullLower);
                  c.total++;
                  if (!isSentenceStart) c.mid_sentence++;
                  if (hasVerbCue) c.verb_cues++;
                  if (honPrefix !== null || HONORIFICS[prevLow]) c.honorific_cues++;
                  if (hasLocationCue) c.loc_cues++;
                  c.chapters[chKey] = (c.chapters[chKey] || 0) + 1;
                }
              }
              i = endIdx + 1;
              continue;
            }
            i = startIdx + 1;
          }
        }
      }

      const accepted = [];
      for (const [key, c] of candidates.entries()) {
        const minMentions = (c.word_count >= 2 || c.honorific !== null) ? 2 : 3;
        if (c.total < minMentions) continue;
        if (c.mid_sentence === 0 && c.honorific_cues === 0) continue;

        let lowFreq = 0;
        if (c.word_count === 1 && c.honorific === null) {
          lowFreq = lowerWordFreq.get(c.name_only.toLowerCase()) || 0;
          if (lowFreq > c.mid_sentence * 1.35) continue;
        }

        const total = c.total;
        const fMidRatio = c.mid_sentence / total;
        const fCapPurity = c.mid_sentence / Math.max(1.0, c.mid_sentence + lowFreq);
        const fVerbRatio = c.verb_cues / total;
        const fHonRatio = c.honorific_cues / total;
        const fLocRatio = c.loc_cues / total;
        const fMultiWord = c.word_count >= 2 ? 1.0 : 0.0;

        const z = -1.35 +
          1.60 * fMidRatio +
          1.45 * fCapPurity +
          1.70 * fVerbRatio +
          2.20 * fHonRatio +
          0.75 * fMultiWord -
          2.60 * fLocRatio;

        const prob = 1.0 / (1.0 + Math.exp(-z));
        if (fLocRatio > 0.42 && c.honorific_cues === 0) continue;
        if (prob < 0.62) continue;

        accepted.push({ key, ...c, ner_prob: Number(prob.toFixed(4)) });
      }

      let merged = this._resolveAliases(accepted);
      merged = this._addSalientKinshipRoles(chaptersMap, keys, merged);

      merged.sort((a, b) => b.mention_count - a.mention_count);
      merged = merged.slice(0, 35);
      merged = this._enrichCharacterContexts(chaptersMap, keys, merged);

      const lowerNames = new Set();
      for (const char of merged) {
        for (const form of [char.canonical_name, ...char.aliases]) {
          for (const part of form.toLowerCase().split(' ')) {
            if (part.length >= 3) lowerNames.add(part);
          }
        }
      }

      return { characters: merged, lower_names: lowerNames };
    }

    _resolveAliases(accepted) {
      accepted.sort((a, b) => {
        const wa = a.word_count + (a.honorific ? 0.5 : 0);
        const wb = b.word_count + (b.honorific ? 0.5 : 0);
        if (wa !== wb) return wb - wa;
        return b.total - a.total;
      });

      const groups = [];
      for (const c of accepted) {
        const coreLower = c.name_only.toLowerCase();
        const coreTokens = coreLower.split(' ');
        let matched = null;

        for (const g of groups) {
          const gCoreLower = g.core_name.toLowerCase();
          const gTokens = gCoreLower.split(' ');

          if (coreLower === gCoreLower) {
            matched = g;
            break;
          }
          if (coreTokens.length === 1 && gTokens.length >= 2 && coreTokens[0] === gTokens[0]) {
            const ambiguous = groups.some((og) => og !== g && og.core_name.toLowerCase().split(' ')[0] === coreTokens[0]);
            if (!ambiguous) {
              matched = g;
              break;
            }
          }
          if (coreTokens.length >= 2 && gTokens.length > coreTokens.length) {
            const prefix = gTokens.slice(0, coreTokens.length).join(' ');
            if (prefix === coreLower) {
              matched = g;
              break;
            }
          }
        }

        if (matched) {
          matched.mention_count += c.total;
          if (c.surface !== matched.canonical_name && !matched.aliases.includes(c.surface)) {
            matched.aliases.push(c.surface);
          }
          if (matched.honorific === null && c.honorific !== null && c.total >= matched.mention_count * 0.25) {
            const oldName = matched.canonical_name;
            matched.canonical_name = c.surface;
            matched.honorific = c.honorific;
            if (!matched.aliases.includes(oldName)) matched.aliases.push(oldName);
            matched.aliases = matched.aliases.filter((a) => a !== matched.canonical_name);
          }
          for (const [chKey, cnt] of Object.entries(c.chapters)) {
            matched.chapters[chKey] = (matched.chapters[chKey] || 0) + cnt;
          }
        } else {
          groups.push({
            canonical_name: c.surface,
            core_name: c.name_only,
            honorific: c.honorific,
            aliases: [],
            mention_count: c.total,
            ner_prob: c.ner_prob,
            chapters: { ...c.chapters },
            traits: [],
            sample_mentions: []
          });
        }
      }

      return groups.map((g) => {
        const chKeys = Object.keys(g.chapters).sort((a, b) => Number(a) - Number(b));
        return {
          ...g,
          chapter_count: chKeys.length,
          first_chapter_key: chKeys.length ? Number(chKeys[0]) : null
        };
      });
    }

    _addSalientKinshipRoles(chaptersMap, keys, characters) {
      const pat = /(?:^|[^\p{L}])(?:su|la)\s+abuela(?![\p{L}])/giu;
      let total = 0;
      const chCounts = {};
      for (const chKey of keys) {
        const m = chaptersMap[chKey].plain_text.match(pat);
        if (m && m.length > 0) {
          total += m.length;
          chCounts[chKey] = m.length;
        }
      }
      if (total >= 25 && Object.keys(chCounts).length >= 3) {
        const sortedKeys = Object.keys(chCounts).sort((a, b) => Number(a) - Number(b));
        characters.push({
          canonical_name: 'La abuela',
          core_name: 'abuela',
          honorific: null,
          aliases: ['su abuela', 'la abuela'],
          mention_count: total,
          ner_prob: 0.92,
          chapters: chCounts,
          chapter_count: sortedKeys.length,
          first_chapter_key: Number(sortedKeys[0]),
          traits: [],
          sample_mentions: []
        });
      }
      return characters;
    }

    _enrichCharacterContexts(chaptersMap, keys, characters) {
      if (characters.length === 0) return [];
      const { SpanishNLP, Utf8Helper, TfIdf } = BiblioWorker;

      const patterns = [];
      const allCharWords = new Set();

      characters.forEach((char) => {
        const forms = [char.canonical_name, ...char.aliases];
        patterns.push(buildEntityRegex(forms));
        for (const f of forms) {
          for (const tw of SpanishNLP.tokenizeRaw(f)) {
            allCharWords.add(tw.toLowerCase());
          }
        }
      });

      const contextDocs = Array.from({ length: characters.length }, () => []);
      const stemToSurface = new Map();

      for (const chKey of keys) {
        const sentences = SpanishNLP.splitSentences(chaptersMap[chKey].plain_text);
        for (const sent of sentences) {
          let cleanTokens = null;

          characters.forEach((char, idx) => {
            if (!char.chapters[chKey]) return;
            if (patterns[idx].test(sent)) {
              if (cleanTokens === null) {
                cleanTokens = [];
                for (const w of SpanishNLP.tokenizeRaw(sent)) {
                  const lw = w.toLowerCase();
                  if (lw.length < 4 || SpanishNLP.isStopword(lw) || allCharWords.has(lw)) continue;
                  const st = SpanishNLP.stem(lw);
                  cleanTokens.push(st);
                  if (!stemToSurface.has(st)) stemToSurface.set(st, new Map());
                  const fm = stemToSurface.get(st);
                  fm.set(lw, (fm.get(lw) || 0) + 1);
                }
              }
              contextDocs[idx].push(...cleanTokens);
              if (char.sample_mentions.length < 3 && sent.length >= 50 && sent.length <= 320) {
                char.sample_mentions.push({ chapter_key: Number(chKey), text: sent });
              }
            }
          });
        }
      }

      const bestSurface = {};
      for (const [st, forms] of stemToSurface.entries()) {
        let bw = st, bc = -1;
        for (const [f, cnt] of forms.entries()) {
          if (cnt > bc) { bc = cnt; bw = f; }
        }
        bestSurface[st] = bw;
      }

      const tfidf = new TfIdf();
      tfidf.fit(contextDocs);

      characters.forEach((char, idx) => {
        const vec = tfidf.transform(contextDocs[idx]);
        char.traits = Object.entries(vec)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 7)
          .map(([st]) => Utf8Helper.ucfirst(bestSurface[st] || st));
      });

      return characters;
    }

    _tokenizeWithMeta(sentence) {
      const parts = sentence.match(/[\p{L}]+(?:-[\p{L}]+)*|[.,;:!?¿¡()[\]"'«»“”—]/gu) || [];
      const tokens = [];
      let afterPunct = false;
      let afterSentenceEnd = true;

      for (const item of parts) {
        if (/^\p{L}/u.test(item)) {
          tokens.push({
            word: item,
            is_cap: BiblioWorker.Utf8Helper.isUpperStart(item),
            after_punct: afterPunct,
            after_sentence_end: afterSentenceEnd
          });
          afterPunct = false;
          afterSentenceEnd = false;
        } else {
          afterPunct = true;
          if ('.!?«»“”—'.includes(item)) afterSentenceEnd = true;
        }
      }
      return tokens;
    }

    _isRoman(w) {
      return /^(?:I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|XIII|XIV|XV|XX)$/.test(w);
    }

    _isAcronym(w) {
      return w.length >= 2 && BiblioWorker.Utf8Helper.isAllUpper(w);
    }
  }

  BiblioWorker.CharacterExtractor = CharacterExtractor;
})(self);
