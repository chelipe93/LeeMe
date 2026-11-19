<?php

namespace BiblioML\ML;

use BiblioML\Text\SpanishNLP;
use BiblioML\Text\Utf8Helper;

/**
 * Extractor clásico de personajes literarios (sin LLM) mediante:
 * - Detección de secuencias de nombres propios y títulos/honoríficos en español
 * - Clasificador estadístico por características (Logistic Feature Scoring):
 *   1. Ratio de capitalización fuera de inicio de oración
 *   2. Proximidad a verbos de habla/cognición/acción y preposiciones de persona
 *   3. Presencia de honoríficos y términos de parentesco (doña, don, tía, tío, señor, doctor...)
 *   4. Penalización de topónimos, instituciones, días/meses, obras y conceptos religiosos
 * - Resolución de correferencia / alias (ej. "Benito" -> "Benito Suárez", "Eulalia" -> "Doña Eulalia")
 * - Extracción de rasgos/palabras de contexto distintivas por personaje vía TF-IDF
 */
class CharacterExtractor
{
    private static $honorifics = [
        'doña' => 'Doña', 'don' => 'Don', 'tía' => 'Tía', 'tío' => 'Tío',
        'señor' => 'Señor', 'señora' => 'Señora', 'señorita' => 'Señorita',
        'doctor' => 'Doctor', 'doctora' => 'Doctora', 'padre' => 'Padre',
        'madre' => 'Madre', 'hermana' => 'Hermana', 'hermano' => 'Hermano',
        'coronel' => 'Coronel', 'general' => 'General', 'capitán' => 'Capitán',
        'profesor' => 'Profesor', 'profesora' => 'Profesora', 'maestro' => 'Maestro',
        'primo' => 'Primo', 'prima' => 'Prima', 'abuelo' => 'Abuelo', 'abuela' => 'Abuela',
        'míster' => 'Míster', 'monsieur' => 'Monsieur', 'madame' => 'Madame',
    ];

    private static $personVerbs = [
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
    ];

    private static $nonPersonTerms = [
        // Lugares / regiones / países / ciudades frecuentes en literatura hispana y universal
        'barranquilla','cartagena','bogotá','medellín','cali','santa marta','colombia','parís','paris',
        'europa','américa','francia','españa','italia','alemania','inglaterra','rusia','méxico','argentina',
        'chile','perú','venezuela','cuba','roma','londres','madrid','barcelona','nueva york','venecia',
        'florencia','viena','berlín','ginebra','zurich','prado','el prado','san blas','caribe','atlántico',
        'magdalena','occidente','oriente','norte','sur','costa','interior','universidad','colegio',
        'iglesia','catedral','hospital','hotel','club','club cartagena','la enseñanza','enseñanza',
        'country','country club','bellavista','alto prado','bocas de ceniza','puerto colombia',
        // Religión, mitología abstracta, textos, festividades, política
        'dios','señor dios','cristo','jesucristo','virgen','biblia','génesis','apocalipsis','evangelio',
        'iglesia católica','vaticano','cielo','infierno','paraíso','demonio','diablo','satanás',
        'navidad','carnaval','pascua','semana santa','cuaresma','ley','república','estado','patria',
        'partido','liberal','conservador','fascismo','nazismo','comunismo','marxismo','psicoanálisis',
        'guerra','segunda guerra','guerra mundial','violencia','bogotazo',
        // Meses, días, números romanos, títulos de parte
        'enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre',
        'noviembre','diciembre','lunes','martes','miércoles','jueves','viernes','sábado','domingo',
        'uno','dos','tres','cuatro','cinco','primera','segunda','tercera','epílogo','prólogo','capítulo',
        'parte','página','nota','notas','resaltar','amarillo','azul','marcador','kindle','cubierta',
        'sinopsis','dedicatoria','créditos','autor','autora','editorial','epublibre',
        // Pronombres / inicios de oración frecuentes
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
        'fuego','aire','sol','luna','mar','río','flor','flores','árbol','noche','luz','sombra','voz'
    ];

    private static $locationPreps = [
        'en' => 1, 'hacia' => 1, 'desde' => 1, 'hasta' => 1, 'por' => 1,
    ];

    private static $locationNouns = [
        'ciudad'=>1,'calle'=>1,'plaza'=>1,'avenida'=>1,'barrio'=>1,'pueblo'=>1,'país'=>1,'región'=>1,
        'club'=>1,'colegio'=>1,'escuela'=>1,'universidad'=>1,'iglesia'=>1,'hotel'=>1,'teatro'=>1,
        'café'=>1,'bar'=>1,'río'=>1,'mar'=>1,'océano'=>1,'isla'=>1,'montaña'=>1,'aeropuerto'=>1,
        'puerto'=>1,'viaje'=>1,'viajes'=>1,'oficina'=>1,'parque'=>1,'cementerio'=>1,'hospital'=>1
    ];

    /**
     * Extrae la lista de personajes, sus apariciones por capítulo, rasgos TF-IDF y ocurrencias.
     * @param array<int, array> $chapters Capítulos narrativos (indexados por clave numérica o id)
     * @param array<int, array> $notes Notas Kindle opcionales
     * @return array{characters: array<int, array>, name_lookup: array<string, int>, lower_names: array<string, bool>}
     */
    public function extract(array $chapters, array $notes = []): array
    {
        $nonPersonMap = array_fill_keys(self::$nonPersonTerms, true);
        $verbMap = array_fill_keys(self::$personVerbs, true);

        // Paso 1: Contar frecuencia en minúsculas de cada palabra en todo el libro
        // (para distinguir nombres propios reales de palabras comunes capitalizadas al inicio de oración)
        $lowerWordFreq = [];
        foreach ($chapters as $ch) {
            foreach (SpanishNLP::tokenizeRaw($ch['plain_text']) as $tok) {
                if (!Utf8Helper::isUpperStart($tok)) {
                    $lw = Utf8Helper::toLower($tok);
                    $lowerWordFreq[$lw] = ($lowerWordFreq[$lw] ?? 0) + 1;
                }
            }
        }

        // Paso 2: Recorrer oraciones y extraer menciones candidatas con señales de contexto
        $candidates = []; // rawNormalizedKey => stats

        foreach ($chapters as $chKey => $ch) {
            $sentences = SpanishNLP::splitSentences($ch['plain_text']);
            foreach ($sentences as $sIdx => $sentence) {
                $tokens = $this->tokenizeWithMeta($sentence);
                $n = count($tokens);
                $i = 0;

                while ($i < $n) {
                    $tok = $tokens[$i];
                    $low = Utf8Helper::toLower($tok['word']);
                    $honPrefix = null;
                    $startIdx = $i;

                    // Caso A: Honorífico ("doña", "don", "tía", "tío", "señor", etc.) seguido de nombre propio
                    if (isset(self::$honorifics[$low]) && $i + 1 < $n && $tokens[$i + 1]['is_cap'] && !$tokens[$i + 1]['after_punct']) {
                        $honPrefix = self::$honorifics[$low];
                        $i++;
                    }

                    // Verificar si el token actual empieza en mayúscula y no es todo mayúsculas (títulos/gritos) o romano
                    if ($i < $n && $tokens[$i]['is_cap'] && !$this->isRomanNumeral($tokens[$i]['word']) && !$this->isAcronymOrShout($tokens[$i]['word'])) {
                        $parts = [$tokens[$i]['word']];
                        $endIdx = $i;

                        // Agrupar hasta 3 palabras capitalizadas consecutivas (permitiendo "de"/"del"/"de la" entre apellidos)
                        $j = $i + 1;
                        while ($j < $n && count($parts) < 3) {
                            if ($tokens[$j]['after_punct']) {
                                break;
                            }
                            if ($tokens[$j]['is_cap'] && !$this->isRomanNumeral($tokens[$j]['word']) && !$this->isAcronymOrShout($tokens[$j]['word'])) {
                                $parts[] = $tokens[$j]['word'];
                                $endIdx = $j;
                                $j++;
                            } else {
                                break;
                            }
                        }

                        $nameOnly = implode(' ', $parts);
                        $fullSurface = $honPrefix !== null ? ($honPrefix . ' ' . $nameOnly) : $nameOnly;
                        $nameLower = Utf8Helper::toLower($nameOnly);

                        // Descartar si es término no-persona directo o muy corto
                        if (Utf8Helper::len($nameOnly) >= 3 && !isset($nonPersonMap[$nameLower]) && !isset($nonPersonMap[Utf8Helper::toLower($fullSurface)])) {
                            // Evaluar si alguna palabra de un nombre de 1 palabra es stopword
                            $skipSingle = (count($parts) === 1 && SpanishNLP::isStopword($nameLower));
                            if (!$skipSingle) {
                                $isSentenceStart = ($startIdx === 0 || $tokens[$startIdx]['after_sentence_end']);
                                $prevLow = ($startIdx > 0) ? Utf8Helper::toLower($tokens[$startIdx - 1]['word']) : '';
                                $prev2Low = ($startIdx > 1) ? Utf8Helper::toLower($tokens[$startIdx - 2]['word']) : '';
                                $nextLow = ($endIdx + 1 < $n) ? Utf8Helper::toLower($tokens[$endIdx + 1]['word']) : '';
                                $next2Low = ($endIdx + 2 < $n) ? Utf8Helper::toLower($tokens[$endIdx + 2]['word']) : '';

                                $hasVerbCue = isset($verbMap[$nextLow]) || isset($verbMap[$next2Low]) || isset($verbMap[$prevLow]);
                                $hasPersonPrep = in_array($prevLow, ['a','con','de','para','ante','sobre','contra','entre'], true)
                                    && !isset(self::$locationNouns[$prev2Low]);
                                $hasLocationCue = (isset(self::$locationPreps[$prevLow]) && isset(self::$locationNouns[$prev2Low]))
                                    || isset(self::$locationNouns[$prevLow])
                                    || ($prevLow === 'en' && count($parts) === 1 && $honPrefix === null);

                                $key = Utf8Helper::toLower($fullSurface);
                                if (!isset($candidates[$key])) {
                                    $candidates[$key] = [
                                        'surface'        => $fullSurface,
                                        'name_only'      => $nameOnly,
                                        'honorific'      => $honPrefix,
                                        'word_count'     => count($parts),
                                        'total'          => 0,
                                        'mid_sentence'   => 0,
                                        'verb_cues'      => 0,
                                        'honorific_cues' => 0,
                                        'prep_cues'      => 0,
                                        'loc_cues'       => 0,
                                        'chapters'       => [],
                                    ];
                                }
                                $c = &$candidates[$key];
                                $c['total']++;
                                if (!$isSentenceStart) {
                                    $c['mid_sentence']++;
                                }
                                if ($hasVerbCue) {
                                    $c['verb_cues']++;
                                }
                                if ($honPrefix !== null || isset(self::$honorifics[$prevLow])) {
                                    $c['honorific_cues']++;
                                }
                                if ($hasPersonPrep) {
                                    $c['prep_cues']++;
                                }
                                if ($hasLocationCue) {
                                    $c['loc_cues']++;
                                }
                                $c['chapters'][$chKey] = ($c['chapters'][$chKey] ?? 0) + 1;
                                unset($c);
                            }
                        }

                        $i = $endIdx + 1;
                        continue;
                    }

                    $i = $startIdx + 1;
                }
            }
        }

        // Paso 3: Clasificador lineal por características (Logistic Feature Score)
        $accepted = [];
        foreach ($candidates as $key => $c) {
            $minMentions = ($c['word_count'] >= 2 || $c['honorific'] !== null) ? 2 : 3;
            if ($c['total'] < $minMentions) {
                continue;
            }
            // Si nunca aparece fuera de inicio de oración (y no tiene honorífico), casi seguro es palabra común
            if ($c['mid_sentence'] === 0 && $c['honorific_cues'] === 0) {
                continue;
            }

            // Verificar frecuencia en minúscula en el texto para palabras simples
            $lowFreq = 0;
            if ($c['word_count'] === 1 && $c['honorific'] === null) {
                $lw = Utf8Helper::toLower($c['name_only']);
                $lowFreq = $lowerWordFreq[$lw] ?? 0;
                // Si aparece mucho más en minúscula que como nombre propio -> sustantivo común
                if ($lowFreq > $c['mid_sentence'] * 1.35) {
                    continue;
                }
            }

            $total = (float)$c['total'];
            $fMidRatio = $c['mid_sentence'] / $total;
            $fCapPurity = $c['mid_sentence'] / max(1.0, (float)($c['mid_sentence'] + $lowFreq));
            $fVerbRatio = $c['verb_cues'] / $total;
            $fHonRatio = $c['honorific_cues'] / $total;
            $fLocRatio = $c['loc_cues'] / $total;
            $fMultiWord = ($c['word_count'] >= 2) ? 1.0 : 0.0;

            // Combinación lineal + sigmoide
            $z = -1.35
                + 1.60 * $fMidRatio
                + 1.45 * $fCapPurity
                + 1.70 * $fVerbRatio
                + 2.20 * $fHonRatio
                + 0.75 * $fMultiWord
                - 2.60 * $fLocRatio;

            $prob = 1.0 / (1.0 + exp(-$z));

            // Descartar candidatos que casi siempre aparecen tras "en ..." (lugares)
            if ($fLocRatio > 0.42 && $c['honorific_cues'] === 0) {
                continue;
            }
            if ($prob < 0.62) {
                continue;
            }

            $c['ner_prob'] = round($prob, 4);
            $accepted[$key] = $c;
        }

        // Paso 4: Resolución de alias / correferencia
        // Ej: "Doña Eulalia" + "Eulalia", "Benito" + "Benito Suárez", "Divina" + "Divina Arriaga"
        $merged = $this->resolveAliases($accepted);

        // Paso 5: Detectar figura familiar recurrente muy central sin nombre propio si aplica (ej. "Abuela de Lina" / "La abuela")
        // Solo si tiene alta frecuencia (>= 30) en la novela
        $merged = $this->addSalientKinshipRoles($chapters, $merged);

        // Ordenar por menciones descendentes y limitar a los 35 personajes más relevantes
        usort($merged, function ($a, $b) {
            return $b['mention_count'] <=> $a['mention_count'];
        });
        $merged = array_slice($merged, 0, 35);

        // Paso 6: Extraer rasgos distintivos (TF-IDF en ventanas de contexto ±8 palabras) y citas de ejemplo
        $merged = $this->enrichCharacterContexts($chapters, $merged);

        // Construir tablas de búsqueda rápida
        $nameLookup = [];
        $lowerNames = [];
        foreach ($merged as $idx => $char) {
            $allForms = array_merge([$char['canonical_name']], $char['aliases']);
            foreach ($allForms as $form) {
                $fl = Utf8Helper::toLower($form);
                $nameLookup[$fl] = $idx;
                foreach (explode(' ', $fl) as $part) {
                    if (Utf8Helper::len($part) >= 3) {
                        $lowerNames[$part] = true;
                    }
                }
            }
        }

        return [
            'characters'  => $merged,
            'name_lookup' => $nameLookup,
            'lower_names' => $lowerNames,
        ];
    }

    private function resolveAliases(array $accepted): array
    {
        // Separar entidades con apellido/honorífico de nombres simples
        $groups = []; // canonicalKey => entity

        // Primero ordenar por longitud de palabras descendente y frecuencia descendente
        uasort($accepted, function ($a, $b) {
            $wa = $a['word_count'] + ($a['honorific'] !== null ? 0.5 : 0);
            $wb = $b['word_count'] + ($b['honorific'] !== null ? 0.5 : 0);
            if ($wa !== $wb) {
                return $wb <=> $wa;
            }
            return $b['total'] <=> $a['total'];
        });

        foreach ($accepted as $key => $c) {
            $coreLower = Utf8Helper::toLower($c['name_only']);
            $coreTokens = explode(' ', $coreLower);
            $matchedGroupKey = null;

            foreach ($groups as $gKey => $g) {
                $gCoreLower = Utf8Helper::toLower($g['core_name']);
                $gTokens = explode(' ', $gCoreLower);

                // Coincidencia exacta sin honorífico (ej. "Doña Eulalia" y "Eulalia")
                if ($coreLower === $gCoreLower) {
                    $matchedGroupKey = $gKey;
                    break;
                }
                // Un nombre simple coincide con el primer nombre de un nombre compuesto único (ej. "Benito" -> "Benito Suárez")
                if (count($coreTokens) === 1 && count($gTokens) >= 2 && $coreTokens[0] === $gTokens[0]) {
                    // Verificar que no haya ambigüedad con otro grupo
                    $ambiguous = false;
                    foreach ($groups as $otherKey => $og) {
                        if ($otherKey === $gKey) continue;
                        $oToks = explode(' ', Utf8Helper::toLower($og['core_name']));
                        if ($oToks[0] === $coreTokens[0]) {
                            $ambiguous = true;
                            break;
                        }
                    }
                    if (!$ambiguous) {
                        $matchedGroupKey = $gKey;
                        break;
                    }
                }
                // Caso: "Giovanna Mantini" y "Doña Giovanna Mantini" o "Juan Palos" y "Juan Palos Pérez"
                if (count($coreTokens) >= 2 && count($gTokens) > count($coreTokens)) {
                    $prefix = implode(' ', array_slice($gTokens, 0, count($coreTokens)));
                    if ($prefix === $coreLower) {
                        $matchedGroupKey = $gKey;
                        break;
                    }
                }
            }

            if ($matchedGroupKey !== null) {
                $g = &$groups[$matchedGroupKey];
                $g['mention_count'] += $c['total'];
                if ($c['surface'] !== $g['canonical_name'] && !in_array($c['surface'], $g['aliases'], true)) {
                    $g['aliases'][] = $c['surface'];
                }
                // Si el candidato con honorífico tiene más peso/claridad (ej. "Doña Eulalia" vs "Eulalia"), conservar honorífico
                if ($g['honorific'] === null && $c['honorific'] !== null && $c['total'] >= $g['mention_count'] * 0.25) {
                    $oldName = $g['canonical_name'];
                    $g['canonical_name'] = $c['surface'];
                    $g['honorific'] = $c['honorific'];
                    if (!in_array($oldName, $g['aliases'], true)) {
                        $g['aliases'][] = $oldName;
                    }
                    $g['aliases'] = array_values(array_diff($g['aliases'], [$g['canonical_name']]));
                }
                foreach ($c['chapters'] as $chKey => $cnt) {
                    $g['chapters'][$chKey] = ($g['chapters'][$chKey] ?? 0) + $cnt;
                }
                unset($g);
            } else {
                $groups[$key] = [
                    'canonical_name' => $c['surface'],
                    'core_name'      => $c['name_only'],
                    'honorific'      => $c['honorific'],
                    'aliases'        => [],
                    'mention_count'  => $c['total'],
                    'ner_prob'       => $c['ner_prob'],
                    'chapters'       => $c['chapters'],
                    'traits'         => [],
                    'sample_mentions'=> [],
                ];
            }
        }

        // Recalcular conteo de capítulos y primer capítulo
        $result = [];
        foreach ($groups as $g) {
            ksort($g['chapters']);
            $g['chapter_count'] = count($g['chapters']);
            $g['first_chapter_key'] = array_key_first($g['chapters']);
            $result[] = $g;
        }
        return $result;
    }

    private function addSalientKinshipRoles(array $chapters, array $characters): array
    {
        // En algunas novelas personajes clave se nombran por parentesco ("su abuela", "la abuela")
        $roles = [
            'La abuela' => '/\b(?:su|la)\s+abuela\b/iu',
        ];
        foreach ($roles as $label => $pattern) {
            $total = 0;
            $chCounts = [];
            foreach ($chapters as $chKey => $ch) {
                $cnt = preg_match_all($pattern, $ch['plain_text']);
                if ($cnt > 0) {
                    $total += $cnt;
                    $chCounts[$chKey] = $cnt;
                }
            }
            if ($total >= 25 && count($chCounts) >= 3) {
                ksort($chCounts);
                $characters[] = [
                    'canonical_name'    => $label,
                    'core_name'         => 'abuela',
                    'honorific'         => null,
                    'aliases'           => ['su abuela', 'la abuela'],
                    'mention_count'     => $total,
                    'ner_prob'          => 0.92,
                    'chapters'          => $chCounts,
                    'chapter_count'     => count($chCounts),
                    'first_chapter_key' => array_key_first($chCounts),
                    'traits'            => [],
                    'sample_mentions'   => [],
                ];
            }
        }
        return $characters;
    }

    private function enrichCharacterContexts(array $chapters, array $characters): array
    {
        if (empty($characters)) {
            return [];
        }

        // Compilar patrón regex por personaje
        $patterns = [];
        $allCharWords = [];
        foreach ($characters as $idx => $char) {
            $forms = array_merge([$char['canonical_name']], $char['aliases']);
            usort($forms, function ($a, $b) {
                return strlen($b) <=> strlen($a);
            });
            $escaped = array_map(function ($f) {
                return preg_quote($f, '/');
            }, $forms);
            $patterns[$idx] = '/(?<![\p{L}])(?:' . implode('|', $escaped) . ')(?![\p{L}])/iu';
            foreach ($forms as $f) {
                foreach (SpanishNLP::tokenizeRaw($f) as $tw) {
                    $allCharWords[Utf8Helper::toLower($tw)] = true;
                }
            }
        }

        $contextDocs = array_fill(0, count($characters), []);
        $stemToSurface = [];

        foreach ($chapters as $chKey => $ch) {
            $sentences = SpanishNLP::splitSentences($ch['plain_text']);
            foreach ($sentences as $sent) {
                $sentLen = Utf8Helper::len($sent);
                $cleanTokens = null;

                foreach ($characters as $idx => &$char) {
                    if (!isset($char['chapters'][$chKey])) {
                        continue;
                    }
                    if (preg_match($patterns[$idx], $sent)) {
                        if ($cleanTokens === null) {
                            $cleanTokens = [];
                            foreach (SpanishNLP::tokenizeRaw($sent) as $w) {
                                $lw = Utf8Helper::toLower($w);
                                if (Utf8Helper::len($lw) < 4 || SpanishNLP::isStopword($lw) || isset($allCharWords[$lw])) {
                                    continue;
                                }
                                $st = SpanishNLP::stem($lw);
                                $cleanTokens[] = $st;
                                $stemToSurface[$st][$lw] = ($stemToSurface[$st][$lw] ?? 0) + 1;
                            }
                        }
                        foreach ($cleanTokens as $st) {
                            $contextDocs[$idx][] = $st;
                        }
                        if (count($char['sample_mentions']) < 3 && $sentLen >= 50 && $sentLen <= 320) {
                            $char['sample_mentions'][] = [
                                'chapter_key' => $chKey,
                                'text'        => $sent,
                            ];
                        }
                    }
                }
                unset($char);
            }
        }

        // Elegir mejor forma superficial por stem
        $bestSurface = [];
        foreach ($stemToSurface as $st => $forms) {
            arsort($forms);
            $bestSurface[$st] = (string)array_key_first($forms);
        }

        // TF-IDF entre personajes para obtener los 7 rasgos/palabras contextuales más distintivas de cada uno
        $tfidf = new TfIdf();
        $tfidf->fit($contextDocs);
        foreach ($characters as $idx => &$char) {
            $vec = $tfidf->transform($contextDocs[$idx]);
            arsort($vec);
            $traits = [];
            foreach (array_slice($vec, 0, 7, true) as $st => $sc) {
                $traits[] = Utf8Helper::ucfirst($bestSurface[$st] ?? $st);
            }
            $char['traits'] = $traits;
        }
        unset($char);

        return $characters;
    }

    private function tokenizeWithMeta(string $sentence): array
    {
        preg_match_all('/[\p{L}]+(?:-[\p{L}]+)*|[\.\,\;\:\!\?\¿\¡\(\)\[\]\"\'«»“”—]/u', $sentence, $m);
        $raw = $m[0] ?? [];
        $tokens = [];
        $afterPunct = false;
        $afterSentenceEnd = true;

        foreach ($raw as $item) {
            if (preg_match('/^[\p{L}]/u', $item)) {
                $tokens[] = [
                    'word'               => $item,
                    'is_cap'             => Utf8Helper::isUpperStart($item),
                    'after_punct'        => $afterPunct,
                    'after_sentence_end' => $afterSentenceEnd,
                ];
                $afterPunct = false;
                $afterSentenceEnd = false;
            } else {
                $afterPunct = true;
                if (strpos('.!?«»“”—', $item) !== false) {
                    $afterSentenceEnd = true;
                }
            }
        }
        return $tokens;
    }

    private function isRomanNumeral(string $w): bool
    {
        return (bool)preg_match('/^(?:I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|XIII|XIV|XV|XX)$/', $w);
    }

    private function isAcronymOrShout(string $w): bool
    {
        return Utf8Helper::len($w) >= 2 && Utf8Helper::isAllUpper($w);
    }
}
