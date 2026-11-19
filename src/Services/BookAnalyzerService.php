<?php

namespace BiblioML\Services;

use BiblioML\Database;
use BiblioML\ML\CharacterExtractor;
use BiblioML\ML\ConceptExtractor;
use BiblioML\ML\KMeansClusterer;
use BiblioML\ML\MindMapBuilder;
use BiblioML\ML\RelationshipGraph;
use BiblioML\ML\Summarizer;
use BiblioML\Parsers\EpubParser;
use BiblioML\Parsers\KindleNotesParser;
use BiblioML\Text\Utf8Helper;
use RuntimeException;

/**
 * Orquestador completo del pipeline de análisis literario:
 * 1. Parseo de EPUB + PDF de notas Kindle
 * 2. Alineación inteligente de subrayados/notas Kindle con capítulos exactos del EPUB
 * 3. Extracción de personajes (NER clásico por características + resolución de alias)
 * 4. Grafo de relaciones (Co-ocurrencia + PMI + Léxico afectivo + PageRank + Comunidades)
 * 5. Extracción de conceptos (TF-IDF + RAKE + Bigramas PMI) y Clústeres (Spherical K-Means++)
 * 6. Resúmenes extractivos por capítulo y global (TextRank + TF-IDF + Kindle Boost + MMR)
 * 7. Construcción de Mapas Mentales (Global Estructural, Global Temático K-Means, y por Capítulo)
 * 8. Persistencia transaccional en MySQL
 */
class BookAnalyzerService
{
    /** @var array */
    private $config;

    public function __construct(array $config)
    {
        $this->config = $config;
    }

    /**
     * Ejecuta todo el análisis en memoria (útil tanto para guardar en MySQL como para pruebas CLI).
     */
    public function runAnalysisPipeline(
        string $epubPath,
        ?string $pdfPath = null,
        ?string $assetsExtractDir = null,
        ?string $coverDestDir = null
    ): array {
        $t0 = microtime(true);

        // 1. Parsear EPUB
        $epubParser = new EpubParser();
        $epubData = $epubParser->parse($epubPath, $assetsExtractDir, $coverDestDir);
        $chapters = $epubData['chapters'];

        // Separar capítulos narrativos (para ML) manteniendo mapeo por chapter_index
        $narrativeChapters = [];
        foreach ($chapters as $ch) {
            if ((int)$ch['is_front_matter'] === 0) {
                $narrativeChapters[$ch['chapter_index']] = $ch;
            }
        }
        // Si todos fueron marcados como front matter (EPUB muy corto), usar todos
        if (empty($narrativeChapters)) {
            foreach ($chapters as $ch) {
                if ($ch['word_count'] > 20) {
                    $narrativeChapters[$ch['chapter_index']] = $ch;
                }
            }
        }

        // 2. Parsear PDF de notas Kindle (si se suministró)
        $kindleStats = ['total_declared' => 0, 'highlights' => 0, 'notes' => 0, 'bookmarks' => 0, 'pages_pdf' => 0];
        $kindleItems = [];
        if ($pdfPath !== null && is_file($pdfPath)) {
            $kindleParser = new KindleNotesParser();
            $parsedNotes = $kindleParser->parse($pdfPath);
            $kindleStats = $parsedNotes['stats'];
            $kindleItems = $parsedNotes['items'];
        }

        // 3. Alinear cada nota/subrayado Kindle con el capítulo exacto del EPUB
        $alignedNotes = $this->alignNotesToChapters($kindleItems, $chapters);
        $notesByChapter = [];
        foreach ($alignedNotes as $note) {
            $chIdx = $note['matched_chapter_index'];
            if ($chIdx !== null) {
                $notesByChapter[$chIdx][] = $note;
            }
        }

        // 4. Extraer Personajes (NER clásico + resolución de alias + rasgos TF-IDF)
        $charExtractor = new CharacterExtractor();
        $charResult = $charExtractor->extract($narrativeChapters, $alignedNotes);
        $characters = $charResult['characters'];

        // 5. Grafo de Relaciones entre Personajes (Co-ocurrencia + PMI + PageRank + Label Propagation)
        $relBuilder = new RelationshipGraph();
        $graphResult = $relBuilder->build($narrativeChapters, $characters);
        $characters = $graphResult['characters'];
        $edges = $graphResult['edges'];

        // 6. Extracción de Conceptos (TF-IDF + RAKE + Bigramas PMI)
        $conceptExtractor = new ConceptExtractor();
        $conceptResult = $conceptExtractor->extract(
            $narrativeChapters,
            $notesByChapter,
            $charResult['lower_names']
        );

        // 7. Clústeres temáticos de capítulos (Spherical K-Means++)
        $clusterer = new KMeansClusterer();
        $clusterResult = $clusterer->cluster(
            $conceptResult['chapter_vectors'],
            $conceptResult['best_surface']
        );

        // 8. Resúmenes extractivos por capítulo y global (TextRank + TF-IDF + Kindle Boost + MMR)
        $summarizer = new Summarizer();
        $chapterSummaries = [];
        $totalTextRankIters = 0;
        $totalKindleBoosted = 0;

        foreach ($narrativeChapters as $chIdx => $ch) {
            $chNotes = $notesByChapter[$chIdx] ?? [];
            $sum = $summarizer->summarizeChapter($ch['plain_text'], $chNotes, 5);
            $chapterSummaries[$chIdx] = $sum;
            $totalTextRankIters += (int)($sum['metrics']['iterations'] ?? 0);
            $totalKindleBoosted += (int)($sum['metrics']['kindle_boosted'] ?? 0);
        }

        $globalSummary = $summarizer->summarizeGlobal($chapterSummaries, $alignedNotes, 7);

        // 9. Mapas Mentales (Global Estructural, Global Temático K-Means, y por Capítulo)
        $mmBuilder = new MindMapBuilder();
        $chapterMindMaps = [];
        foreach ($narrativeChapters as $chIdx => $ch) {
            $chapterMindMaps[$chIdx] = $mmBuilder->buildChapterMindMap(
                $chIdx,
                $ch,
                $chapterSummaries[$chIdx] ?? [],
                $conceptResult['chapter_keywords'][$chIdx] ?? [],
                $characters,
                $notesByChapter[$chIdx] ?? []
            );
        }

        $globalStructuralMap = $mmBuilder->buildGlobalStructural(
            $epubData['metadata']['title'],
            $epubData['metadata']['author'],
            $narrativeChapters,
            $conceptResult['chapter_keywords'],
            $characters,
            $notesByChapter
        );

        $globalThematicMap = $mmBuilder->buildGlobalThematic(
            $epubData['metadata']['title'],
            $epubData['metadata']['author'],
            $clusterResult,
            $narrativeChapters,
            $conceptResult['chapter_keywords'],
            $notesByChapter,
            $characters
        );

        $elapsedMs = round((microtime(true) - $t0) * 1000, 1);

        $matchedCount = 0;
        foreach ($alignedNotes as $n) {
            if ($n['matched_chapter_index'] !== null) {
                $matchedCount++;
            }
        }

        $mlStats = [
            'elapsed_ms'            => $elapsedMs,
            'narrative_chapters'    => count($narrativeChapters),
            'total_sections'        => count($chapters),
            'total_words'           => $epubData['total_words'],
            'vocabulary_size'       => $conceptResult['vocabulary_size'],
            'textrank_avg_iters'    => count($narrativeChapters) > 0 ? round($totalTextRankIters / count($narrativeChapters), 1) : 0,
            'kindle_boosted_sents'  => $totalKindleBoosted,
            'kmeans_k'              => $clusterResult['k'],
            'kmeans_silhouette'     => $clusterResult['silhouette'],
            'kmeans_iterations'     => $clusterResult['iterations'],
            'character_count'       => count($characters),
            'relation_edges'        => count($edges),
            'graph_modularity'      => $graphResult['modularity'],
            'communities_count'     => count(array_unique(array_column($characters, 'community_id'))),
            'kindle_stats'          => $kindleStats,
            'kindle_items_aligned'  => $matchedCount,
            'kindle_items_total'    => count($alignedNotes),
            'algorithms'            => [
                'Resumen'         => 'TextRank (PageRank d=0.85) + TF-IDF + Kindle Boost + MMR (λ=0.72)',
                'Conceptos'       => 'TF-IDF Corpus + RAKE + Colocaciones Bigramas PMI',
                'Mapa Temático'   => 'Spherical K-Means++ (Distancia Coseno)',
                'Personajes'      => 'NER Estadístico por Características (Logístico) + Resolución de Alias + Rasgos TF-IDF',
                'Grafo Relaciones'=> 'Co-ocurrencia Ventana Deslizante + PMI + Léxico Afectivo + PageRank + Louvain (Modularidad)',
            ],
        ];

        return [
            'metadata'            => $epubData['metadata'],
            'cover_file'          => $epubData['cover_file'],
            'total_words'         => $epubData['total_words'],
            'chapters'            => $chapters,
            'narrative_indices'   => array_keys($narrativeChapters),
            'aligned_notes'       => $alignedNotes,
            'chapter_summaries'   => $chapterSummaries,
            'chapter_keywords'    => $conceptResult['chapter_keywords'],
            'chapter_mindmaps'    => $chapterMindMaps,
            'global_summary'      => $globalSummary,
            'global_structural'   => $globalStructuralMap,
            'global_thematic'     => $globalThematicMap,
            'global_keywords'     => [
                'concepts' => $conceptResult['global_concepts'],
                'bigrams'  => $conceptResult['global_bigrams'],
            ],
            'clusters'            => $clusterResult['clusters'],
            'characters'          => $characters,
            'edges'               => $edges,
            'ml_stats'            => $mlStats,
        ];
    }

    /**
     * Analiza y persiste un libro completo (EPUB + PDF Kindle opcional) en MySQL.
     */
    public function ingestAndSave(
        Database $db,
        string $epubStoredPath,
        string $epubOriginalName,
        ?string $pdfStoredPath = null,
        ?string $pdfOriginalName = null
    ): int {
        $appCfg = $this->config['app'];
        $tempAssetFolder = 'tmp_' . bin2hex(random_bytes(6));
        $tempAssetDir = $appCfg['books_dir'] . DIRECTORY_SEPARATOR . $tempAssetFolder;

        $analysis = $this->runAnalysisPipeline(
            $epubStoredPath,
            $pdfStoredPath,
            $tempAssetDir,
            $appCfg['covers_dir']
        );

        $meta = $analysis['metadata'];
        $stats = $analysis['ml_stats'];
        $kStats = $stats['kindle_stats'];

        $db->beginTransaction();
        try {
            $bookId = $db->execute(
                "INSERT INTO books (
                    title, author, language, publisher, description, cover_path,
                    epub_filename, epub_path, pdf_filename, pdf_path,
                    total_chapters, total_words, total_notes, total_highlights, total_characters, global_summary
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                'ssssssssssiiiiis',
                [
                    $meta['title'],
                    $meta['author'],
                    $meta['language'],
                    $meta['publisher'],
                    $meta['description'],
                    $analysis['cover_file'],
                    $epubOriginalName,
                    $epubStoredPath,
                    $pdfOriginalName,
                    $pdfStoredPath,
                    $stats['narrative_chapters'],
                    $analysis['total_words'],
                    (int)($kStats['notes'] ?? 0),
                    (int)($kStats['highlights'] ?? 0),
                    count($analysis['characters']),
                    $analysis['global_summary'],
                ]
            );

            // Renombrar directorio de recursos a book_{bookId}
            $finalAssetDir = $appCfg['books_dir'] . DIRECTORY_SEPARATOR . 'book_' . $bookId;
            if (is_dir($tempAssetDir)) {
                @rename($tempAssetDir, $finalAssetDir);
            }

            // Insertar capítulos y mapear chapter_index -> chapter_id en BD
            $chapterIdxToId = [];
            $assetBaseUrl = "api/index.php?action=book_asset&book_id={$bookId}&path=";

            foreach ($analysis['chapters'] as $ch) {
                $chIdx = $ch['chapter_index'];
                $htmlFixed = str_replace('{{ASSET_BASE}}', $assetBaseUrl, $ch['html_content']);
                $sumData = $analysis['chapter_summaries'][$chIdx] ?? null;
                $kwData = $analysis['chapter_keywords'][$chIdx] ?? null;
                $mmData = $analysis['chapter_mindmaps'][$chIdx] ?? null;

                $chId = $db->execute(
                    "INSERT INTO chapters (
                        book_id, chapter_index, part_title, title, display_title, href,
                        is_front_matter, word_count, html_content, plain_text,
                        summary_text, summary_json, keywords_json, mindmap_json
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    'iissssiissssss',
                    [
                        $bookId,
                        $chIdx,
                        $ch['part_title'],
                        $ch['title'],
                        $ch['display_title'],
                        $ch['href'],
                        (int)$ch['is_front_matter'],
                        (int)$ch['word_count'],
                        $htmlFixed,
                        $ch['plain_text'],
                        $sumData ? $sumData['summary_text'] : null,
                        $sumData ? json_encode($sumData, JSON_UNESCAPED_UNICODE) : null,
                        $kwData ? json_encode($kwData, JSON_UNESCAPED_UNICODE) : null,
                        $mmData ? json_encode($mmData, JSON_UNESCAPED_UNICODE) : null,
                    ]
                );
                $chapterIdxToId[$chIdx] = $chId;
            }

            // Actualizar referencias de chapter_id en los mapas mentales globales antes de persistir
            $globalStructural = $this->patchMindMapChapterIds($analysis['global_structural'], $chapterIdxToId);
            $globalThematic = $this->patchMindMapChapterIds($analysis['global_thematic'], $chapterIdxToId);

            // Insertar notas Kindle alineadas
            foreach ($analysis['aligned_notes'] as $note) {
                $matchedIdx = $note['matched_chapter_index'];
                $matchedChId = ($matchedIdx !== null && isset($chapterIdxToId[$matchedIdx])) ? $chapterIdxToId[$matchedIdx] : null;

                $db->execute(
                    "INSERT INTO kindle_notes (
                        book_id, chapter_id, pdf_chapter_label, page_number, note_type,
                        highlight_color, highlight_text, user_note, note_date, match_confidence, sort_order
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    'iisisssssdi',
                    [
                        $bookId,
                        $matchedChId,
                        $note['pdf_chapter_label'],
                        $note['page_number'],
                        $note['note_type'],
                        $note['highlight_color'],
                        $note['highlight_text'],
                        $note['user_note'],
                        $note['note_date'],
                        (float)$note['match_confidence'],
                        (int)$note['sort_order'],
                    ]
                );
            }

            // Insertar personajes
            $charIdxToId = [];
            foreach ($analysis['characters'] as $idx => $char) {
                $firstKey = $char['first_chapter_key'] ?? null;
                $firstChId = ($firstKey !== null && isset($chapterIdxToId[$firstKey])) ? $chapterIdxToId[$firstKey] : null;

                // Mapear capítulos a chapter_id => mentions
                $chaptersById = [];
                foreach ($char['chapters'] as $chKey => $cnt) {
                    if (isset($chapterIdxToId[$chKey])) {
                        $chaptersById[(string)$chapterIdxToId[$chKey]] = $cnt;
                    }
                }
                $samples = [];
                foreach ($char['sample_mentions'] as $sm) {
                    $samples[] = [
                        'chapter_id' => $chapterIdxToId[$sm['chapter_key']] ?? null,
                        'text'       => $sm['text'],
                    ];
                }

                $charId = $db->execute(
                    "INSERT INTO characters (
                        book_id, canonical_name, aliases_json, mention_count, chapter_count,
                        pagerank, degree_centrality, community_id, first_chapter_id,
                        chapters_json, traits_json, sample_mentions_json
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    'issiiddiiss' . 's',
                    [
                        $bookId,
                        $char['canonical_name'],
                        json_encode($char['aliases'], JSON_UNESCAPED_UNICODE),
                        (int)$char['mention_count'],
                        (int)$char['chapter_count'],
                        (float)$char['pagerank'],
                        (float)$char['degree_centrality'],
                        (int)$char['community_id'],
                        $firstChId,
                        json_encode($chaptersById, JSON_UNESCAPED_UNICODE),
                        json_encode($char['traits'], JSON_UNESCAPED_UNICODE),
                        json_encode($samples, JSON_UNESCAPED_UNICODE),
                    ]
                );
                $charIdxToId[$idx] = $charId;
            }

            // Insertar relaciones del grafo
            foreach ($analysis['edges'] as $e) {
                $srcId = $charIdxToId[$e['source_idx']] ?? null;
                $tgtId = $charIdxToId[$e['target_idx']] ?? null;
                if ($srcId === null || $tgtId === null) {
                    continue;
                }
                $sharedIds = [];
                foreach ($e['shared_chapters'] as $chKey) {
                    if (isset($chapterIdxToId[$chKey])) {
                        $sharedIds[] = $chapterIdxToId[$chKey];
                    }
                }
                $evidence = [];
                foreach ($e['evidence'] as $ev) {
                    $evidence[] = [
                        'chapter_id' => $chapterIdxToId[$ev['chapter_key']] ?? null,
                        'text'       => $ev['text'],
                    ];
                }

                $db->execute(
                    "INSERT INTO character_relations (
                        book_id, source_character_id, target_character_id, weight,
                        cooccurrence_count, pmi_score, sentiment_score, relation_tone,
                        context_words_json, shared_chapters_json, evidence_json
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    'iiididdssss',
                    [
                        $bookId,
                        $srcId,
                        $tgtId,
                        (float)$e['weight'],
                        (int)$e['cooccurrence'],
                        (float)$e['pmi_score'],
                        (float)$e['sentiment_score'],
                        $e['relation_tone'],
                        json_encode($e['context_words'], JSON_UNESCAPED_UNICODE),
                        json_encode($sharedIds, JSON_UNESCAPED_UNICODE),
                        json_encode($evidence, JSON_UNESCAPED_UNICODE),
                    ]
                );
            }

            // Insertar análisis global (mapas mentales, keywords, clústeres, métricas ML)
            $clustersMapped = [];
            foreach ($analysis['clusters'] as $cl) {
                $memberIds = [];
                foreach ($cl['members'] as $chKey) {
                    if (isset($chapterIdxToId[$chKey])) {
                        $memberIds[] = $chapterIdxToId[$chKey];
                    }
                }
                $cl['member_chapter_ids'] = $memberIds;
                $clustersMapped[] = $cl;
            }

            $db->execute(
                "INSERT INTO book_analysis (
                    book_id, global_mindmap_json, cluster_mindmap_json,
                    global_keywords_json, clusters_json, stats_json
                 ) VALUES (?, ?, ?, ?, ?, ?)",
                'isssss',
                [
                    $bookId,
                    json_encode($globalStructural, JSON_UNESCAPED_UNICODE),
                    json_encode($globalThematic, JSON_UNESCAPED_UNICODE),
                    json_encode($analysis['global_keywords'], JSON_UNESCAPED_UNICODE),
                    json_encode($clustersMapped, JSON_UNESCAPED_UNICODE),
                    json_encode($stats, JSON_UNESCAPED_UNICODE),
                ]
            );

            // Inicializar progreso de lectura en el primer capítulo narrativo
            $firstNarrIdx = $analysis['narrative_indices'][0] ?? array_key_first($chapterIdxToId);
            $firstNarrId = $chapterIdxToId[$firstNarrIdx] ?? null;
            $db->execute(
                "INSERT INTO reading_progress (book_id, current_chapter_id, scroll_percent) VALUES (?, ?, 0)",
                'ii',
                [$bookId, $firstNarrId]
            );

            $db->commit();
            return $bookId;
        } catch (\Throwable $ex) {
            $db->rollback();
            throw $ex;
        }
    }

    /**
     * Alinea cada subrayado/nota del PDF Kindle con el capítulo exacto del EPUB.
     * Usa coincidencia exacta normalizada -> 4-gramas de palabras -> interpolación monótona por orden/título.
     */
    private function alignNotesToChapters(array $notes, array $chapters): array
    {
        if (empty($notes) || empty($chapters)) {
            return [];
        }

        // Pre-normalizar el texto de cada capítulo
        $chapNorm = [];
        $chapTitlesNorm = [];
        foreach ($chapters as $ch) {
            $idx = $ch['chapter_index'];
            $chapNorm[$idx] = Utf8Helper::normalizeForMatch($ch['plain_text']);
            $chapTitlesNorm[$idx] = Utf8Helper::normalizeForMatch($ch['title']);
        }

        // Paso 1: Emparejar subrayados por contenido textual real
        foreach ($notes as &$n) {
            $n['matched_chapter_index'] = null;
            $n['match_confidence'] = 0.0;

            if (empty($n['highlight_text'])) {
                continue;
            }
            $hlNorm = Utf8Helper::normalizeForMatch($n['highlight_text']);
            if (strlen($hlNorm) < 6) {
                continue;
            }

            // A) Búsqueda de subcadena exacta (primero completa, luego prefijo/mitad de 48 chars)
            $probes = [];
            if (strlen($hlNorm) <= 90) {
                $probes[] = $hlNorm;
            } else {
                $probes[] = substr($hlNorm, 0, 56);
                $probes[] = substr($hlNorm, (int)(strlen($hlNorm) / 2) - 24, 48);
                $probes[] = substr($hlNorm, -48);
            }

            $bestIdx = null;
            $bestScore = 0.0;

            foreach ($chapNorm as $chIdx => $cText) {
                if ($cText === '') {
                    continue;
                }
                $hits = 0;
                foreach ($probes as $pr) {
                    if (strlen($pr) >= 6 && strpos($cText, $pr) !== false) {
                        $hits++;
                    }
                }
                if ($hits > 0) {
                    $sc = 0.85 + 0.15 * ($hits / count($probes));
                    if ($sc > $bestScore) {
                        $bestScore = $sc;
                        $bestIdx = $chIdx;
                    }
                }
            }

            // B) Fallback: coincidencia por 3-gramas de palabras (para pequeños errores de tipografía/OCR)
            if ($bestIdx === null) {
                $words = explode(' ', $hlNorm);
                if (count($words) >= 4) {
                    $ngrams = [];
                    for ($i = 0; $i <= count($words) - 3; $i++) {
                        $ngrams[] = $words[$i] . ' ' . $words[$i + 1] . ' ' . $words[$i + 2];
                    }
                    $totalNg = count($ngrams);
                    foreach ($chapNorm as $chIdx => $cText) {
                        if ($cText === '') continue;
                        $matched = 0;
                        foreach ($ngrams as $ng) {
                            if (strpos($cText, $ng) !== false) {
                                $matched++;
                            }
                        }
                        $ratio = $matched / max(1, $totalNg);
                        if ($ratio >= 0.45 && $ratio > $bestScore) {
                            $bestScore = $ratio;
                            $bestIdx = $chIdx;
                        }
                    }
                }
            }

            if ($bestIdx !== null) {
                $n['matched_chapter_index'] = $bestIdx;
                $n['match_confidence'] = round($bestScore, 4);
            }
        }
        unset($n);

        // Paso 2: Resolver notas/marcadores sin highlight (o sin match directo) usando vecinos y etiqueta PDF
        $count = count($notes);
        for ($i = 0; $i < $count; $i++) {
            if ($notes[$i]['matched_chapter_index'] !== null) {
                continue;
            }
            $pdfLbl = Utf8Helper::normalizeForMatch((string)($notes[$i]['pdf_chapter_label'] ?? ''));

            // Buscar vecino anterior o posterior con la misma etiqueta de sección PDF
            $prevMatched = null;
            for ($p = $i - 1; $p >= 0; $p--) {
                if ($notes[$p]['matched_chapter_index'] !== null) {
                    $prevMatched = $notes[$p]['matched_chapter_index'];
                    break;
                }
            }
            $nextMatched = null;
            for ($q = $i + 1; $q < $count; $q++) {
                if ($notes[$q]['matched_chapter_index'] !== null) {
                    $nextMatched = $notes[$q]['matched_chapter_index'];
                    break;
                }
            }

            if ($prevMatched !== null && $nextMatched !== null && $prevMatched === $nextMatched) {
                $notes[$i]['matched_chapter_index'] = $prevMatched;
                $notes[$i]['match_confidence'] = 0.7000;
                continue;
            }

            // Buscar capítulo cuyo título coincida con pdf_chapter_label respetando orden monótono
            if ($pdfLbl !== '') {
                foreach ($chapTitlesNorm as $chIdx => $tNorm) {
                    if ($tNorm === $pdfLbl) {
                        if ($prevMatched !== null && $chIdx < $prevMatched) {
                            continue;
                        }
                        $notes[$i]['matched_chapter_index'] = $chIdx;
                        $notes[$i]['match_confidence'] = 0.6500;
                        break;
                    }
                }
            }

            if ($notes[$i]['matched_chapter_index'] === null && ($prevMatched !== null || $nextMatched !== null)) {
                $notes[$i]['matched_chapter_index'] = $prevMatched ?? $nextMatched;
                $notes[$i]['match_confidence'] = 0.5000;
            }
        }

        return $notes;
    }

    private function patchMindMapChapterIds(array $node, array $chapterIdxToId): array
    {
        if (isset($node['chapter_id']) && isset($chapterIdxToId[$node['chapter_id']])) {
            $node['chapter_id'] = $chapterIdxToId[$node['chapter_id']];
        }
        if (!empty($node['children'])) {
            foreach ($node['children'] as $k => $ch) {
                $node['children'][$k] = $this->patchMindMapChapterIds($ch, $chapterIdxToId);
            }
        }
        return $node;
    }
}
