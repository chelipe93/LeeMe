<?php

namespace BiblioML\ML;

use BiblioML\Text\SpanishNLP;
use BiblioML\Text\Utf8Helper;

/**
 * Extracción de conceptos clave y frases temáticas mediante ML clásico:
 * - TF-IDF a nivel de corpus (capítulos como documentos)
 * - RAKE (Rapid Automatic Keyword Extraction)
 * - Colocaciones de bigramas con PMI (Pointwise Mutual Information)
 * - Integración con temas de notas personales de Kindle
 */
class ConceptExtractor
{
    /**
     * Extrae palabras y conceptos clave por capítulo y globales.
     * @param array<int, array> $chapters Capítulos narrativos con ['id'|'chapter_index', 'plain_text']
     * @param array<int, array> $notesByChapter Mapa chapterKey => notas Kindle
     * @param array<string, bool> $characterNamesLower Nombres de personajes para no duplicarlos como conceptos abstractos
     */
    public function extract(array $chapters, array $notesByChapter = [], array $characterNamesLower = []): array
    {
        $chapterTokens = [];
        $stemToSurface = []; // stem => [surface => freq]
        $globalTokenFreq = [];
        $bigramFreq = [];
        $totalTokens = 0;

        foreach ($chapters as $k => $ch) {
            $rawWords = SpanishNLP::tokenizeRaw($ch['plain_text']);
            $stems = [];
            $prevClean = null;

            foreach ($rawWords as $w) {
                $low = Utf8Helper::toLower($w);
                if (Utf8Helper::len($low) < 4 || SpanishNLP::isStopword($low)) {
                    $prevClean = null;
                    continue;
                }
                if (isset($characterNamesLower[$low])) {
                    $prevClean = null;
                    continue;
                }
                $stem = SpanishNLP::stem($low);
                $stems[] = $stem;
                $stemToSurface[$stem][$low] = ($stemToSurface[$stem][$low] ?? 0) + 1;
                $globalTokenFreq[$low] = ($globalTokenFreq[$low] ?? 0) + 1;
                $totalTokens++;

                if ($prevClean !== null && $prevClean !== $low) {
                    $bg = $prevClean . ' ' . $low;
                    $bigramFreq[$bg] = ($bigramFreq[$bg] ?? 0) + 1;
                }
                $prevClean = $low;
            }
            $chapterTokens[$k] = $stems;
        }

        // Elegir forma superficial más frecuente para cada stem
        $bestSurface = [];
        foreach ($stemToSurface as $stem => $forms) {
            arsort($forms);
            $bestSurface[$stem] = (string)array_key_first($forms);
        }

        // Filtrar términos con frecuencia demasiado alta (> 85% de capítulos) o hapax (< 2 ocurrencias)
        // para que TF-IDF y K-Means capturen ejes temáticos reales y no palabras genéricas o ruido
        $numDocs = count($chapterTokens);
        $stemDf = [];
        $stemTotalFreq = [];
        foreach ($chapterTokens as $stems) {
            $seen = [];
            foreach ($stems as $st) {
                $stemTotalFreq[$st] = ($stemTotalFreq[$st] ?? 0) + 1;
                if (!isset($seen[$st])) {
                    $seen[$st] = true;
                    $stemDf[$st] = ($stemDf[$st] ?? 0) + 1;
                }
            }
        }

        $filteredChapterTokens = [];
        foreach ($chapterTokens as $k => $stems) {
            $chCounts = array_count_values($stems);
            $kept = [];
            foreach ($stems as $st) {
                $df = $stemDf[$st] ?? 1;
                $tf = $chCounts[$st] ?? 1;
                // Mantener si aparece al menos 2 veces en el capítulo o en >= 2 capítulos, y no en todos los capítulos si hay >= 5
                if (($tf >= 2 || $df >= 2) && ($numDocs < 5 || ($df / $numDocs) <= 0.85)) {
                    $kept[] = $st;
                }
            }
            $filteredChapterTokens[$k] = !empty($kept) ? $kept : $stems;
        }

        // Ajustar TF-IDF entre capítulos
        $tfidf = new TfIdf();
        $tfidf->fit($filteredChapterTokens);

        $chapterVectors = [];
        $chapterKeywords = [];
        $globalTermScores = [];

        foreach ($chapters as $k => $ch) {
            $vec = $tfidf->transform($filteredChapterTokens[$k]);
            $chapterVectors[$k] = $vec;

            // Impulsar términos que aparecen en las notas Kindle de este capítulo
            $boosted = $vec;
            $chNotes = $notesByChapter[$k] ?? [];
            $noteBoostStems = [];
            foreach ($chNotes as $n) {
                $txt = trim(($n['user_note'] ?? '') . ' ' . ($n['highlight_text'] ?? ''));
                foreach (SpanishNLP::tokenizeClean($txt, true) as $st) {
                    $noteBoostStems[$st] = ($noteBoostStems[$st] ?? 0) + 1;
                }
            }
            foreach ($noteBoostStems as $st => $cnt) {
                if (isset($boosted[$st])) {
                    $boosted[$st] *= (1.0 + min(0.6, 0.15 * $cnt));
                }
            }

            arsort($boosted);

            // Top unigramas TF-IDF
            $topTerms = [];
            $usedLabels = [];
            foreach ($boosted as $stem => $score) {
                $label = $bestSurface[$stem] ?? $stem;
                if (isset($characterNamesLower[$label]) || isset($usedLabels[$label])) {
                    continue;
                }
                $usedLabels[$label] = true;
                $topTerms[] = [
                    'term'   => Utf8Helper::ucfirst($label),
                    'stem'   => $stem,
                    'score'  => round($score, 4),
                    'method' => isset($noteBoostStems[$stem]) ? 'TF-IDF + Kindle' : 'TF-IDF',
                ];
                $globalTermScores[$stem] = ($globalTermScores[$stem] ?? 0.0) + $score;
                if (count($topTerms) >= 10) {
                    break;
                }
            }

            // Frases clave RAKE por capítulo
            $rakePhrases = $this->extractRakePhrases($ch['plain_text'], $characterNamesLower, 5);

            // Temas directos escritos por el lector en "Nota:" de Kindle
            $readerTopics = $this->extractReaderNoteTopics($chNotes);

            $chapterKeywords[$k] = [
                'tfidf_terms'   => $topTerms,
                'rake_phrases'  => $rakePhrases,
                'reader_topics' => $readerTopics,
            ];
        }

        // Conceptos globales (unigramas TF-IDF agregados + bigramas PMI)
        arsort($globalTermScores);
        $globalConcepts = [];
        foreach ($globalTermScores as $stem => $score) {
            $label = $bestSurface[$stem] ?? $stem;
            if (isset($characterNamesLower[$label])) {
                continue;
            }
            $globalConcepts[] = [
                'term'   => Utf8Helper::ucfirst($label),
                'stem'   => $stem,
                'score'  => round($score, 4),
                'method' => 'TF-IDF Global',
            ];
            if (count($globalConcepts) >= 24) {
                break;
            }
        }

        // Top bigramas por PMI * log(freq)
        $pmiBigrams = [];
        if ($totalTokens > 0) {
            foreach ($bigramFreq as $bg => $cnt) {
                if ($cnt < 3) {
                    continue;
                }
                [$w1, $w2] = explode(' ', $bg);
                $f1 = $globalTokenFreq[$w1] ?? 1;
                $f2 = $globalTokenFreq[$w2] ?? 1;
                $pmi = log(($cnt * $totalTokens) / ($f1 * $f2));
                if ($pmi > 2.2) {
                    $pmiBigrams[$bg] = $pmi * log(1.0 + $cnt);
                }
            }
            arsort($pmiBigrams);
            $pmiBigrams = array_slice($pmiBigrams, 0, 14, true);
        }

        $globalBigrams = [];
        foreach ($pmiBigrams as $bg => $sc) {
            $globalBigrams[] = [
                'term'   => Utf8Helper::ucfirst($bg),
                'score'  => round($sc, 4),
                'method' => 'Bigrama PMI',
            ];
        }

        return [
            'chapter_vectors'   => $chapterVectors,
            'chapter_keywords'  => $chapterKeywords,
            'global_concepts'   => $globalConcepts,
            'global_bigrams'    => $globalBigrams,
            'vocabulary_size'   => $tfidf->getVocabularySize(),
            'best_surface'      => $bestSurface,
        ];
    }

    /**
     * RAKE (Rapid Automatic Keyword Extraction) clásico para frases de 2 a 3 palabras.
     */
    private function extractRakePhrases(string $text, array $characterNamesLower, int $limit = 5): array
    {
        // Dividir por signos de puntuación en segmentos
        $chunks = preg_split('/[\.\,\;\:\!\?\¿\¡\(\)\[\]\"\'«»“”—\-\n]+/u', $text);
        $phrases = [];

        foreach ($chunks as $chunk) {
            $words = SpanishNLP::tokenizeRaw($chunk);
            $current = [];
            foreach ($words as $w) {
                $low = Utf8Helper::toLower($w);
                if (Utf8Helper::len($low) < 3 || SpanishNLP::isStopword($low) || isset($characterNamesLower[$low])) {
                    if (count($current) >= 2 && count($current) <= 3) {
                        $phrases[] = $current;
                    }
                    $current = [];
                } else {
                    $current[] = $low;
                }
            }
            if (count($current) >= 2 && count($current) <= 3) {
                $phrases[] = $current;
            }
        }

        if (empty($phrases)) {
            return [];
        }

        // Calcular grado y frecuencia de cada palabra
        $wordFreq = [];
        $wordDeg = [];
        $phraseCounts = [];
        foreach ($phrases as $p) {
            $key = implode(' ', $p);
            $phraseCounts[$key] = ($phraseCounts[$key] ?? 0) + 1;
            $deg = count($p);
            foreach ($p as $w) {
                $wordFreq[$w] = ($wordFreq[$w] ?? 0) + 1;
                $wordDeg[$w] = ($wordDeg[$w] ?? 0) + $deg;
            }
        }

        $phraseScores = [];
        foreach ($phraseCounts as $key => $cnt) {
            $words = explode(' ', $key);
            $sc = 0.0;
            foreach ($words as $w) {
                $sc += $wordDeg[$w] / max(1, $wordFreq[$w]);
            }
            // Priorizar frases que aparecen más de una vez o tienen buen puntaje léxico
            $phraseScores[$key] = $sc * (1.0 + 0.5 * log((float)$cnt));
        }

        arsort($phraseScores);
        $out = [];
        foreach ($phraseScores as $phrase => $sc) {
            $out[] = [
                'term'   => Utf8Helper::ucfirst($phrase),
                'score'  => round($sc, 3),
                'method' => 'RAKE',
            ];
            if (count($out) >= $limit) {
                break;
            }
        }
        return $out;
    }

    private function extractReaderNoteTopics(array $notes): array
    {
        $topics = [];
        $seen = [];
        foreach ($notes as $n) {
            if (empty($n['user_note'])) {
                continue;
            }
            $txt = trim(rtrim($n['user_note'], '. '));
            if ($txt === '') {
                continue;
            }
            $short = Utf8Helper::len($txt) > 55 ? (Utf8Helper::substr($txt, 0, 52) . '…') : $txt;
            $norm = Utf8Helper::normalizeForMatch($short);
            if ($norm !== '' && !isset($seen[$norm])) {
                $seen[$norm] = true;
                $topics[] = [
                    'term' => $short,
                    'page' => $n['page_number'] ?? null,
                    'full' => $txt,
                ];
            }
        }
        return $topics;
    }
}
