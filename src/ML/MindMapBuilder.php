<?php

namespace BiblioML\ML;

use BiblioML\Text\Utf8Helper;

/**
 * Constructor de Mapas Mentales jerárquicos (Global por Estructura, Global por Clústeres ML K-Means++,
 * y Mapa Mental detallado por Capítulo) a partir de los resultados de los modelos ML clásicos.
 */
class MindMapBuilder
{
    /**
     * Construye el Mapa Mental Global Estructural (Libro -> Partes -> Capítulos -> Conceptos/Personajes/Notas).
     */
    public function buildGlobalStructural(
        string $bookTitle,
        string $author,
        array $chapters,
        array $chapterKeywords,
        array $characters,
        array $notesByChapter
    ): array {
        // Agrupar capítulos narrativos por part_title
        $byPart = [];
        foreach ($chapters as $k => $ch) {
            $part = $ch['part_title'] ?: 'Desarrollo Principal';
            $byPart[$part][] = $k;
        }

        $partNodes = [];
        $pIdx = 0;
        foreach ($byPart as $partName => $chKeys) {
            $pIdx++;
            $chapterNodes = [];
            foreach ($chKeys as $k) {
                $ch = $chapters[$k];
                $kw = $chapterKeywords[$k] ?? ['tfidf_terms' => [], 'rake_phrases' => [], 'reader_topics' => []];
                $chNotes = $notesByChapter[$k] ?? [];

                $leafChildren = [];
                // Top 3 conceptos TF-IDF del capítulo
                foreach (array_slice($kw['tfidf_terms'] ?? [], 0, 3) as $t) {
                    $leafChildren[] = [
                        'id'    => "g_ch_{$k}_kw_" . md5($t['term']),
                        'label' => $t['term'],
                        'type'  => 'concept',
                        'meta'  => "Score TF-IDF: {$t['score']} ({$t['method']})",
                        'chapter_id' => $ch['id'] ?? $k,
                    ];
                }
                // Top 2 personajes del capítulo
                $chChars = $this->getTopCharactersForChapter($characters, $k, 2);
                foreach ($chChars as $cc) {
                    $leafChildren[] = [
                        'id'    => "g_ch_{$k}_char_" . md5($cc['name']),
                        'label' => $cc['name'],
                        'type'  => 'character',
                        'meta'  => "{$cc['mentions']} menciones en este capítulo",
                        'chapter_id' => $ch['id'] ?? $k,
                    ];
                }
                // Top 2 temas de notas Kindle si existen
                foreach (array_slice($kw['reader_topics'] ?? [], 0, 2) as $rt) {
                    $leafChildren[] = [
                        'id'    => "g_ch_{$k}_note_" . md5($rt['term']),
                        'label' => 'Nota: ' . $rt['term'],
                        'type'  => 'note',
                        'meta'  => $rt['full'] . ($rt['page'] ? " (Pág. {$rt['page']})" : ''),
                        'chapter_id' => $ch['id'] ?? $k,
                    ];
                }

                $chapterNodes[] = [
                    'id'         => "g_ch_{$k}",
                    'label'      => $ch['display_title'],
                    'type'       => 'chapter',
                    'chapter_id' => $ch['id'] ?? $k,
                    'meta'       => "{$ch['word_count']} palabras · " . count($chNotes) . " notas Kindle",
                    'children'   => $leafChildren,
                ];
            }

            $partNodes[] = [
                'id'       => "g_part_{$pIdx}",
                'label'    => (count($byPart) > 1 && $partName !== 'Desarrollo Principal') ? "Parte {$partName}" : $partName,
                'type'     => 'part',
                'meta'     => count($chKeys) . ' capítulos',
                'children' => $chapterNodes,
            ];
        }

        return [
            'id'       => 'root_structural',
            'label'    => $bookTitle,
            'subtitle' => $author,
            'type'     => 'root',
            'meta'     => 'Mapa Mental Global · Estructura Narrativa + ML',
            'children' => $partNodes,
        ];
    }

    /**
     * Construye el Mapa Mental Global Temático (Libro -> Clústeres Spherical K-Means++ -> Capítulos + Conceptos + Notas).
     */
    public function buildGlobalThematic(
        string $bookTitle,
        string $author,
        array $clusterResult,
        array $chapters,
        array $chapterKeywords,
        array $notesByChapter,
        array $characters
    ): array {
        $clusterNodes = [];
        foreach ($clusterResult['clusters'] ?? [] as $cl) {
            $cid = $cl['cluster_id'];
            $children = [];

            // Rama de conceptos núcleo del clúster
            $conceptChildren = [];
            foreach ($cl['top_terms'] as $term) {
                $conceptChildren[] = [
                    'id'    => "cl_{$cid}_t_" . md5($term),
                    'label' => $term,
                    'type'  => 'concept',
                    'meta'  => 'Término dominante del centroide K-Means++',
                ];
            }
            if (!empty($conceptChildren)) {
                $children[] = [
                    'id'       => "cl_{$cid}_concepts",
                    'label'    => 'Conceptos del Clúster',
                    'type'     => 'group',
                    'children' => $conceptChildren,
                ];
            }

            // Rama de capítulos agrupados
            $chChildren = [];
            $clusterNotes = [];
            foreach ($cl['members'] as $chKey) {
                if (!isset($chapters[$chKey])) {
                    continue;
                }
                $ch = $chapters[$chKey];
                $kw = $chapterKeywords[$chKey] ?? [];
                foreach ($kw['reader_topics'] ?? [] as $rt) {
                    $clusterNotes[] = $rt;
                }
                $chChildren[] = [
                    'id'         => "cl_{$cid}_ch_{$chKey}",
                    'label'      => $ch['display_title'],
                    'type'       => 'chapter',
                    'chapter_id' => $ch['id'] ?? $chKey,
                    'meta'       => "{$ch['word_count']} palabras · " . count($notesByChapter[$chKey] ?? []) . " notas Kindle",
                ];
            }
            if (!empty($chChildren)) {
                $children[] = [
                    'id'       => "cl_{$cid}_chapters",
                    'label'    => 'Capítulos Asociados (' . count($chChildren) . ')',
                    'type'     => 'group',
                    'children' => $chChildren,
                ];
            }

            // Rama de notas del lector dentro de este clúster temático
            if (!empty($clusterNotes)) {
                $noteNodes = [];
                foreach (array_slice($clusterNotes, 0, 5) as $idx => $rn) {
                    $noteNodes[] = [
                        'id'    => "cl_{$cid}_rn_{$idx}",
                        'label' => $rn['term'],
                        'type'  => 'note',
                        'meta'  => $rn['full'] . ($rn['page'] ? " (Pág. {$rn['page']})" : ''),
                    ];
                }
                $children[] = [
                    'id'       => "cl_{$cid}_notes",
                    'label'    => 'Notas Kindle Vinculadas',
                    'type'     => 'group',
                    'children' => $noteNodes,
                ];
            }

            $clusterNodes[] = [
                'id'       => "cl_{$cid}",
                'label'    => $cl['label'],
                'type'     => 'cluster',
                'meta'     => 'Clúster temático K-Means++ · ' . count($cl['members']) . ' capítulos',
                'children' => $children,
            ];
        }

        // Añadir rama de Personajes Centrales (PageRank)
        $topChars = $characters;
        usort($topChars, function ($a, $b) {
            return ($b['pagerank'] ?? 0) <=> ($a['pagerank'] ?? 0);
        });
        $charBranchChildren = [];
        foreach (array_slice($topChars, 0, 8) as $idx => $ch) {
            $charBranchChildren[] = [
                'id'    => "global_char_{$idx}",
                'label' => $ch['canonical_name'],
                'type'  => 'character',
                'meta'  => "Menciones: {$ch['mention_count']} · PageRank: " . round(($ch['pagerank'] ?? 0) * 100, 1) . '% · Rasgos: ' . implode(', ', array_slice($ch['traits'] ?? [], 0, 3)),
            ];
        }
        if (!empty($charBranchChildren)) {
            $clusterNodes[] = [
                'id'       => 'global_characters_branch',
                'label'    => 'Personajes Centrales (PageRank)',
                'type'     => 'part',
                'meta'     => 'Top personajes por centralidad en el grafo de co-ocurrencia',
                'children' => $charBranchChildren,
            ];
        }

        return [
            'id'       => 'root_thematic',
            'label'    => $bookTitle,
            'subtitle' => 'Clústeres ML (Spherical K-Means++) · Silhouette: ' . ($clusterResult['silhouette'] ?? 0),
            'type'     => 'root',
            'meta'     => $author,
            'children' => $clusterNodes,
        ];
    }

    /**
     * Construye el Mapa Mental detallado para un capítulo específico.
     */
    public function buildChapterMindMap(
        $chapterKey,
        array $chapter,
        array $summaryData,
        array $keywordsData,
        array $characters,
        array $chapterNotes
    ): array {
        $branches = [];

        // 1. Conceptos Clave (TF-IDF + RAKE)
        $conceptChildren = [];
        foreach (array_slice($keywordsData['tfidf_terms'] ?? [], 0, 6) as $idx => $t) {
            $conceptChildren[] = [
                'id'    => "ch_{$chapterKey}_tfidf_{$idx}",
                'label' => $t['term'],
                'type'  => 'concept',
                'meta'  => "Relevancia {$t['method']}: {$t['score']}",
            ];
        }
        foreach (array_slice($keywordsData['rake_phrases'] ?? [], 0, 4) as $idx => $p) {
            $conceptChildren[] = [
                'id'    => "ch_{$chapterKey}_rake_{$idx}",
                'label' => $p['term'],
                'type'  => 'phrase',
                'meta'  => "Frase clave RAKE (score {$p['score']})",
            ];
        }
        if (!empty($conceptChildren)) {
            $branches[] = [
                'id'       => "ch_{$chapterKey}_b_concepts",
                'label'    => 'Conceptos Clave (TF-IDF / RAKE)',
                'type'     => 'cluster',
                'children' => $conceptChildren,
            ];
        }

        // 2. Personajes en el Capítulo
        $chChars = $this->getTopCharactersForChapter($characters, $chapterKey, 7);
        if (!empty($chChars)) {
            $charNodes = [];
            foreach ($chChars as $idx => $cc) {
                $charNodes[] = [
                    'id'    => "ch_{$chapterKey}_char_{$idx}",
                    'label' => "{$cc['name']} ({$cc['mentions']})",
                    'type'  => 'character',
                    'meta'  => "Menciones en capítulo: {$cc['mentions']} · Rasgos: " . implode(', ', array_slice($cc['traits'], 0, 3)),
                ];
            }
            $branches[] = [
                'id'       => "ch_{$chapterKey}_b_chars",
                'label'    => 'Personajes del Capítulo',
                'type'     => 'part',
                'children' => $charNodes,
            ];
        }

        // 3. Núcleos Narrativos (TextRank)
        if (!empty($summaryData['sentences'])) {
            $sumNodes = [];
            foreach (array_slice($summaryData['sentences'], 0, 4) as $idx => $s) {
                $short = Utf8Helper::len($s['text']) > 78
                    ? (Utf8Helper::substr($s['text'], 0, 75) . '…')
                    : $s['text'];
                $sumNodes[] = [
                    'id'    => "ch_{$chapterKey}_tr_{$idx}",
                    'label' => $short,
                    'type'  => 'summary',
                    'meta'  => $s['text'] . " [TextRank: {$s['textrank']}, Score: {$s['score']}]",
                ];
            }
            $branches[] = [
                'id'       => "ch_{$chapterKey}_b_summary",
                'label'    => 'Núcleos Narrativos (TextRank)',
                'type'     => 'group',
                'children' => $sumNodes,
            ];
        }

        // 4. Notas y Subrayados de Kindle del capítulo
        if (!empty($chapterNotes)) {
            $noteNodes = [];
            foreach (array_slice($chapterNotes, 0, 8) as $idx => $n) {
                $label = !empty($n['user_note'])
                    ? $n['user_note']
                    : ($n['highlight_text'] ?? 'Marcador pág. ' . ($n['page_number'] ?? '?'));
                $short = Utf8Helper::len($label) > 64 ? (Utf8Helper::substr($label, 0, 61) . '…') : $label;
                $meta = ($n['page_number'] ? "Pág. {$n['page_number']} · " : '')
                    . (!empty($n['highlight_text']) ? "«{$n['highlight_text']}»" : '')
                    . (!empty($n['user_note']) ? " | Nota: {$n['user_note']}" : '');

                $noteNodes[] = [
                    'id'    => "ch_{$chapterKey}_kn_{$idx}",
                    'label' => $short,
                    'type'  => 'note',
                    'meta'  => trim($meta),
                ];
            }
            $branches[] = [
                'id'       => "ch_{$chapterKey}_b_notes",
                'label'    => 'Tus Notas Kindle (' . count($chapterNotes) . ')',
                'type'     => 'note_group',
                'children' => $noteNodes,
            ];
        }

        return [
            'id'         => "root_ch_{$chapterKey}",
            'label'      => $chapter['display_title'],
            'subtitle'   => "{$chapter['word_count']} palabras · " . count($chapterNotes) . " notas Kindle",
            'type'       => 'root',
            'chapter_id' => $chapter['id'] ?? $chapterKey,
            'children'   => $branches,
        ];
    }

    private function getTopCharactersForChapter(array $characters, $chapterKey, int $limit): array
    {
        $list = [];
        foreach ($characters as $c) {
            $cnt = $c['chapters'][$chapterKey] ?? 0;
            if ($cnt > 0) {
                $list[] = [
                    'name'     => $c['canonical_name'],
                    'mentions' => $cnt,
                    'traits'   => $c['traits'] ?? [],
                ];
            }
        }
        usort($list, function ($a, $b) {
            return $b['mentions'] <=> $a['mentions'];
        });
        return array_slice($list, 0, $limit);
    }
}
