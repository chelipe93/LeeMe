<?php

namespace BiblioML\ML;

use BiblioML\Text\SpanishNLP;
use BiblioML\Text\Utf8Helper;

/**
 * Resumen extractivo por capítulo y global usando Machine Learning clásico (sin LLM):
 * - Vectorización TF-IDF de oraciones
 * - Grafo de similitud coseno + TextRank (PageRank iterativo, d = 0.85)
 * - Impulso de relevancia por notas/subrayados de Kindle (Kindle Salience Boost)
 * - Selección sin redundancia mediante MMR (Maximal Marginal Relevance)
 */
class Summarizer
{
    /**
     * Resume un capítulo a partir de su texto plano y las notas Kindle asociadas.
     * @param array<int, array> $chapterNotes
     */
    public function summarizeChapter(string $plainText, array $chapterNotes = [], int $numSentences = 5): array
    {
        $rawSentences = SpanishNLP::splitSentences($plainText);
        if (empty($rawSentences)) {
            return [
                'summary_text' => '',
                'sentences'    => [],
                'metrics'      => ['total_sentences' => 0, 'iterations' => 0, 'kindle_boosted' => 0],
            ];
        }

        // Filtrar oraciones candidatas (evitar títulos de 2 palabras o citas excesivamente largas)
        $candidates = [];
        foreach ($rawSentences as $idx => $s) {
            $len = Utf8Helper::len($s);
            if ($len < 40 && count($rawSentences) > 10) {
                continue;
            }
            $tokens = SpanishNLP::tokenizeClean($s, true);
            if (count($tokens) < 4 && count($rawSentences) > 10) {
                continue;
            }
            $candidates[] = [
                'orig_index' => $idx,
                'text'       => $s,
                'tokens'     => $tokens,
                'norm'       => Utf8Helper::normalizeForMatch($s),
            ];
        }

        if (empty($candidates)) {
            $first = array_slice($rawSentences, 0, min($numSentences, count($rawSentences)));
            return [
                'summary_text' => implode(' ', $first),
                'sentences'    => array_map(function ($t, $i) {
                    return ['index' => $i, 'text' => $t, 'score' => 1.0, 'textrank' => 1.0, 'kindle_match' => false];
                }, $first, array_keys($first)),
                'metrics' => ['total_sentences' => count($rawSentences), 'iterations' => 0, 'kindle_boosted' => 0],
            ];
        }

        // Preparar textos normalizados de subrayados y notas Kindle para salience boost
        $noteNorms = [];
        $noteTokensAll = [];
        foreach ($chapterNotes as $n) {
            if (!empty($n['highlight_text'])) {
                $noteNorms[] = Utf8Helper::normalizeForMatch($n['highlight_text']);
                $noteTokensAll = array_merge($noteTokensAll, SpanishNLP::tokenizeClean($n['highlight_text'], true));
            }
            if (!empty($n['user_note'])) {
                $noteTokensAll = array_merge($noteTokensAll, SpanishNLP::tokenizeClean($n['user_note'], true));
            }
        }

        // Ajustar TF-IDF sobre todas las oraciones candidatas
        $tfidf = new TfIdf();
        $tokenDocs = array_column($candidates, 'tokens');
        $tfidf->fit($tokenDocs);

        $vectors = [];
        foreach ($candidates as $i => $c) {
            $vectors[$i] = $tfidf->transform($c['tokens']);
        }

        // Centroide temático del capítulo y vector de notas Kindle
        $centroid = TfIdf::centroid($vectors);
        $kindleVec = !empty($noteTokensAll) ? $tfidf->transform($noteTokensAll) : [];

        $totalCand = count($candidates);
        $prelim = [];
        foreach ($candidates as $i => $c) {
            $centSim = TfIdf::cosine($vectors[$i], $centroid);
            $kOverlap = 0.0;
            $directKindle = false;
            foreach ($noteNorms as $nn) {
                if (strlen($nn) >= 20 && (strpos($c['norm'], substr($nn, 0, min(40, strlen($nn)))) !== false
                    || strpos($nn, substr($c['norm'], 0, min(40, strlen($c['norm'])))) !== false)) {
                    $directKindle = true;
                    $kOverlap = 1.0;
                    break;
                }
            }
            if (!$directKindle && !empty($kindleVec)) {
                $kOverlap = TfIdf::cosine($vectors[$i], $kindleVec);
            }
            // Prior posicional (inicio y cierre suelen condensar transiciones narrativas)
            $posRatio = $totalCand > 1 ? ($i / ($totalCand - 1)) : 0.0;
            $posPrior = ($posRatio < 0.12) ? (1.0 - $posRatio * 4.0) : (($posRatio > 0.88) ? (($posRatio - 0.88) * 4.0) : 0.25);

            // Penalizar ligeramente oraciones excesivamente largas (> 480 caracteres) para claridad del resumen
            $charLen = Utf8Helper::len($c['text']);
            $lenFactor = ($charLen > 480) ? max(0.55, 480.0 / $charLen) : (($charLen < 70) ? 0.80 : 1.0);

            $prelim[$i] = [
                'idx'           => $i,
                'centroid_sim'  => $centSim,
                'kindle_score'  => $kOverlap,
                'direct_kindle' => $directKindle,
                'pos_prior'     => $posPrior,
                'len_factor'    => $lenFactor,
                'pre_score'     => ($centSim * 0.65 + $kOverlap * 0.25 + $posPrior * 0.10) * $lenFactor,
            ];
        }

        // Pre-seleccionar hasta 140 oraciones más informativas para matriz TextRank rápida O(M^2)
        $maxGraphNodes = 140;
        $graphIndices = array_keys($prelim);
        if (count($graphIndices) > $maxGraphNodes) {
            usort($graphIndices, function ($a, $b) use ($prelim) {
                return $prelim[$b]['pre_score'] <=> $prelim[$a]['pre_score'];
            });
            $graphIndices = array_slice($graphIndices, 0, $maxGraphNodes);
            sort($graphIndices);
        }

        $m = count($graphIndices);
        // Construir grafo de similitud coseno
        $adj = array_fill(0, $m, []);
        $weightSum = array_fill(0, $m, 0.0);
        for ($a = 0; $a < $m; $a++) {
            $va = $vectors[$graphIndices[$a]];
            for ($b = $a + 1; $b < $m; $b++) {
                $sim = TfIdf::cosine($va, $vectors[$graphIndices[$b]]);
                if ($sim > 0.06) {
                    $adj[$a][$b] = $sim;
                    $adj[$b][$a] = $sim;
                    $weightSum[$a] += $sim;
                    $weightSum[$b] += $sim;
                }
            }
        }

        // TextRank (PageRank ponderado, d = 0.85)
        $damping = 0.85;
        $pr = array_fill(0, $m, 1.0 / max(1, $m));
        $iterations = 0;
        for ($iter = 1; $iter <= 35; $iter++) {
            $iterations = $iter;
            $newPr = array_fill(0, $m, (1.0 - $damping) / max(1, $m));
            for ($u = 0; $u < $m; $u++) {
                if ($weightSum[$u] <= 0.0) {
                    continue;
                }
                $share = ($damping * $pr[$u]) / $weightSum[$u];
                foreach ($adj[$u] as $v => $w) {
                    $newPr[$v] += $share * $w;
                }
            }
            $diff = 0.0;
            for ($u = 0; $u < $m; $u++) {
                $diff += abs($newPr[$u] - $pr[$u]);
            }
            $pr = $newPr;
            if ($diff < 1e-5) {
                break;
            }
        }

        // Normalizar TextRank a [0, 1]
        $maxPr = max($pr) ?: 1.0;
        $scores = [];
        foreach ($graphIndices as $localIdx => $candIdx) {
            $trNorm = $pr[$localIdx] / $maxPr;
            $p = $prelim[$candIdx];
            $composite = (
                0.52 * $trNorm +
                0.26 * $p['centroid_sim'] +
                0.08 * $p['pos_prior'] +
                0.14 * $p['kindle_score']
            ) * $p['len_factor'];

            $scores[$candIdx] = [
                'cand_idx'      => $candIdx,
                'composite'     => $composite,
                'textrank'      => $trNorm,
                'centroid_sim'  => $p['centroid_sim'],
                'kindle_score'  => $p['kindle_score'],
                'direct_kindle' => $p['direct_kindle'],
            ];
        }

        // Selección MMR (Maximal Marginal Relevance, lambda = 0.72) para evitar frases repetitivas
        $targetK = min($numSentences, count($scores));
        $lambda = 0.72;
        $selected = [];
        $remaining = array_keys($scores);

        while (count($selected) < $targetK && !empty($remaining)) {
            $bestIdx = null;
            $bestMmr = -INF;

            foreach ($remaining as $cIdx) {
                $rel = $scores[$cIdx]['composite'];
                $maxRedundancy = 0.0;
                foreach ($selected as $sIdx) {
                    $sim = TfIdf::cosine($vectors[$cIdx], $vectors[$sIdx]);
                    if ($sim > $maxRedundancy) {
                        $maxRedundancy = $sim;
                    }
                }
                $mmr = $lambda * $rel - (1.0 - $lambda) * $maxRedundancy;
                if ($mmr > $bestMmr) {
                    $bestMmr = $mmr;
                    $bestIdx = $cIdx;
                }
            }

            if ($bestIdx === null) {
                break;
            }
            $selected[] = $bestIdx;
            $remaining = array_values(array_diff($remaining, [$bestIdx]));
        }

        // Ordenar cronológicamente para lectura natural
        sort($selected);

        $resultSentences = [];
        $kindleBoostedCount = 0;
        foreach ($selected as $cIdx) {
            $sc = $scores[$cIdx];
            if ($sc['direct_kindle'] || $sc['kindle_score'] > 0.18) {
                $kindleBoostedCount++;
            }
            $resultSentences[] = [
                'index'        => $candidates[$cIdx]['orig_index'],
                'text'         => $candidates[$cIdx]['text'],
                'score'        => round($sc['composite'], 4),
                'textrank'     => round($sc['textrank'], 4),
                'centroid_sim' => round($sc['centroid_sim'], 4),
                'kindle_match' => $sc['direct_kindle'],
            ];
        }

        $summaryText = implode(' ', array_column($resultSentences, 'text'));

        return [
            'summary_text' => $summaryText,
            'sentences'    => $resultSentences,
            'metrics'      => [
                'total_sentences' => count($rawSentences),
                'graph_nodes'     => $m,
                'iterations'      => $iterations,
                'kindle_boosted'  => $kindleBoostedCount,
            ],
        ];
    }

    /**
     * Genera un resumen global del libro combinando las mejores oraciones de los capítulos.
     */
    public function summarizeGlobal(array $chapterSummaries, array $allNotes = [], int $numSentences = 7): string
    {
        $pool = [];
        foreach ($chapterSummaries as $ch) {
            if (!empty($ch['sentences'])) {
                foreach (array_slice($ch['sentences'], 0, 2) as $s) {
                    $pool[] = $s['text'];
                }
            }
        }
        if (empty($pool)) {
            return '';
        }
        $combined = implode("\n\n", $pool);
        $res = $this->summarizeChapter($combined, $allNotes, $numSentences);
        return $res['summary_text'];
    }
}
