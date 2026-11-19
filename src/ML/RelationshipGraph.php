<?php

namespace BiblioML\ML;

use BiblioML\Text\SpanishNLP;
use BiblioML\Text\Utf8Helper;

/**
 * Construcción del grafo de relaciones entre personajes (sin LLM):
 * - Co-ocurrencia ponderada en ventana deslizante de oraciones (misma oración = 3.0, ±1 = 1.2, ±2 = 0.5)
 * - PMI (Pointwise Mutual Information) para detectar vínculos genuinos
 * - Léxico afectivo en español para inferir tono relacional (afinidad / tensión / ambivalente / neutral)
 * - Centralidad PageRank ponderado y Grado normalizado
 * - Detección de comunidades narrativas mediante Label Propagation ponderado
 */
class RelationshipGraph
{
    private static $positiveLexicon = [
        'amor','amar','amaba','cariño','ternura','amistad','amiga','amigo','compasión','placer','alegría',
        'feliz','felicidad','apoyo','cuidado','cuidar','comprensión','respeto','sabiduría','libertad',
        'libre','confianza','sonrisa','sonrió','abrazó','besó','dulce','dulzura','proteger','calma',
        'paz','belleza','inteligencia','admiración','risa','reía','esperanza','solidaridad','honesto',
        'noble','bondad','afecto','complicidad','entusiasmo','armonía','equilibrio','generosidad'
    ];

    private static $negativeLexicon = [
        'odio','odiar','odiaba','violencia','miedo','terror','cólera','ira','celos','engaño','engañó',
        'muerte','morir','murió','asesino','matar','golpe','latigazos','desprecio','culpa','culpabilidad',
        'represión','humillación','rencor','miserable','llanto','lloraba','tristeza','destruir','crueldad',
        'veneno','envenenó','traición','venganza','amenaza','amenazando','cárcel','locos','infierno',
        'frustración','agresividad','resentimiento','envidia','abyección','opresión','dominar','dominación',
        'explotar','explotación','sufrimiento','dolor','heridas','desesperación','derrumbó','vencida',
        'miedo','temía','temor','furia','rabia','salvajemente','gritó','insulto','castiga','maldad'
    ];

    /**
     * Construye el grafo de personajes y actualiza métricas de centralidad y comunidad.
     * @param array<int, array> $chapters
     * @param array<int, array> $characters
     */
    public function build(array $chapters, array $characters): array
    {
        $nChars = count($characters);
        if ($nChars === 0) {
            return ['characters' => [], 'edges' => [], 'communities' => [], 'modularity' => 0.0];
        }

        $posSet = array_fill_keys(self::$positiveLexicon, true);
        $negSet = array_fill_keys(self::$negativeLexicon, true);

        // Compilar regex de detección por personaje y conjunto de palabras de nombre a excluir del contexto
        $patterns = [];
        $charWordSet = [];
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
                    $charWordSet[Utf8Helper::toLower($tw)] = true;
                }
            }
        }

        $totalSentences = 0;
        $charSentCount = array_fill(0, $nChars, 0);
        $pairData = []; // "i:j" => [weight, cooc, chapters, words, pos, neg, evidence]

        foreach ($chapters as $chKey => $ch) {
            $sentences = SpanishNLP::splitSentences($ch['plain_text']);
            $sCount = count($sentences);
            $totalSentences += $sCount;

            // Determinar qué personajes aparecen en cada oración
            $sentChars = [];
            for ($s = 0; $s < $sCount; $s++) {
                $present = [];
                foreach ($characters as $idx => $char) {
                    if (!isset($char['chapters'][$chKey])) {
                        continue;
                    }
                    if (preg_match($patterns[$idx], $sentences[$s])) {
                        $present[] = $idx;
                        $charSentCount[$idx]++;
                    }
                }
                $sentChars[$s] = $present;
            }

            // Ventana deslizante de co-ocurrencia: misma oración (3.0), ±1 (1.2), ±2 (0.5)
            for ($s = 0; $s < $sCount; $s++) {
                $here = $sentChars[$s];
                if (empty($here)) {
                    continue;
                }

                // Pares en la misma oración
                $hc = count($here);
                if ($hc >= 2) {
                    $tokens = $this->extractContextWords($sentences[$s], $charWordSet);
                    [$pos, $neg] = $this->scoreSentiment($sentences[$s], $posSet, $negSet);

                    for ($a = 0; $a < $hc; $a++) {
                        for ($b = $a + 1; $b < $hc; $b++) {
                            $u = min($here[$a], $here[$b]);
                            $v = max($here[$a], $here[$b]);
                            $this->addPairObservation($pairData, $u, $v, 3.0, $chKey, $tokens, $pos, $neg, $sentences[$s]);
                        }
                    }
                }

                // Pares con oraciones vecinas (+1 y +2)
                foreach ([1 => 1.2, 2 => 0.5] as $offset => $w) {
                    if ($s + $offset >= $sCount) {
                        continue;
                    }
                    $there = $sentChars[$s + $offset];
                    if (empty($there)) {
                        continue;
                    }
                    $combText = $sentences[$s] . ' ' . $sentences[$s + $offset];
                    $tokens = null;
                    $sentPol = null;

                    foreach ($here as $c1) {
                        foreach ($there as $c2) {
                            if ($c1 === $c2) {
                                continue;
                            }
                            $u = min($c1, $c2);
                            $v = max($c1, $c2);
                            if ($tokens === null) {
                                $tokens = $this->extractContextWords($combText, $charWordSet);
                                $sentPol = $this->scoreSentiment($combText, $posSet, $negSet);
                            }
                            $this->addPairObservation($pairData, $u, $v, $w, $chKey, $tokens, $sentPol[0], $sentPol[1], null);
                        }
                    }
                }
            }
        }

        // Construir aristas finales con PMI y tono relacional
        $edges = [];
        $adj = array_fill(0, $nChars, []);
        $totalSentsSafe = max(1.0, (float)$totalSentences);

        foreach ($pairData as $key => $pd) {
            if ($pd['weight'] < 2.2) {
                continue;
            }
            $u = $pd['u'];
            $v = $pd['v'];
            $pu = ($charSentCount[$u] + 1.0) / ($totalSentsSafe + 2.0);
            $pv = ($charSentCount[$v] + 1.0) / ($totalSentsSafe + 2.0);
            $puv = ($pd['cooc'] + 0.5) / ($totalSentsSafe + 2.0);
            $pmi = log($puv / ($pu * $pv));

            $pos = $pd['pos'];
            $neg = $pd['neg'];
            $totalPol = $pos + $neg;
            $sentiment = $totalPol > 0 ? (($pos - $neg) / $totalPol) : 0.0;

            if ($totalPol >= 3 && $pos >= 2 && $neg >= 2 && abs($sentiment) < 0.25) {
                $tone = 'ambivalente';
            } elseif ($sentiment >= 0.22) {
                $tone = 'afinidad';
            } elseif ($sentiment <= -0.22) {
                $tone = 'tensión';
            } else {
                $tone = 'neutral';
            }

            arsort($pd['words']);
            $topCtx = array_map([Utf8Helper::class, 'ucfirst'], array_keys(array_slice($pd['words'], 0, 6, true)));
            ksort($pd['chapters']);

            $edges[] = [
                'source_idx'      => $u,
                'target_idx'      => $v,
                'weight'          => round($pd['weight'], 2),
                'cooccurrence'    => $pd['cooc'],
                'pmi_score'       => round($pmi, 4),
                'sentiment_score' => round($sentiment, 4),
                'relation_tone'   => $tone,
                'context_words'   => $topCtx,
                'shared_chapters' => array_keys($pd['chapters']),
                'evidence'        => $pd['evidence'],
            ];

            $adj[$u][$v] = $pd['weight'];
            $adj[$v][$u] = $pd['weight'];
        }

        // Ordenar aristas por peso descendente
        usort($edges, function ($a, $b) {
            return $b['weight'] <=> $a['weight'];
        });

        // Calcular PageRank ponderado y Grado normalizado
        $pagerank = $this->computePageRank($adj, $nChars);
        $maxDeg = max(1, $nChars - 1);

        // Detección de comunidades mediante Label Propagation ponderado
        $communities = $this->detectCommunities($adj, $nChars);
        $modularity = $this->computeModularity($adj, $communities);

        foreach ($characters as $idx => &$char) {
            $char['pagerank'] = round($pagerank[$idx], 6);
            $char['degree_centrality'] = round(count($adj[$idx]) / $maxDeg, 6);
            $char['community_id'] = $communities[$idx];
        }
        unset($char);

        return [
            'characters'  => $characters,
            'edges'       => $edges,
            'communities' => $communities,
            'modularity'  => round($modularity, 4),
        ];
    }

    private function addPairObservation(
        array &$pairData,
        int $u,
        int $v,
        float $weight,
        $chKey,
        array $tokens,
        int $pos,
        int $neg,
        ?string $sentence
    ): void {
        $key = "{$u}:{$v}";
        if (!isset($pairData[$key])) {
            $pairData[$key] = [
                'u'        => $u,
                'v'        => $v,
                'weight'   => 0.0,
                'cooc'     => 0,
                'chapters' => [],
                'words'    => [],
                'pos'      => 0,
                'neg'      => 0,
                'evidence' => [],
            ];
        }
        $p = &$pairData[$key];
        $p['weight'] += $weight;
        $p['cooc']++;
        $p['chapters'][$chKey] = ($p['chapters'][$chKey] ?? 0) + 1;
        $p['pos'] += $pos;
        $p['neg'] += $neg;

        foreach ($tokens as $t) {
            $p['words'][$t] = ($p['words'][$t] ?? 0) + 1;
        }
        if ($sentence !== null && count($p['evidence']) < 3 && Utf8Helper::len($sentence) <= 320) {
            $p['evidence'][] = [
                'chapter_key' => $chKey,
                'text'        => $sentence,
            ];
        }
        unset($p);
    }

    private static $genericCtxWords = [
        'casa'=>1,'hombre'=>1,'hombres'=>1,'mujer'=>1,'mujeres'=>1,'años'=>1,'año'=>1,'vida'=>1,
        'haber'=>1,'ojos'=>1,'través'=>1,'mundo'=>1,'instante'=>1,'tiempo'=>1,'noche'=>1,'tarde'=>1,
        'mañana'=>1,'cuerpo'=>1,'rostro'=>1,'cara'=>1,'manos'=>1,'mano'=>1,'cabeza'=>1,'puerta'=>1,
        'cuarto'=>1,'mesa'=>1,'silla'=>1,'cama'=>1,'calle'=>1,'ciudad'=>1,'gente'=>1,'persona'=>1,
        'personas'=>1,'palabra'=>1,'palabras'=>1,'voz'=>1,'historia'=>1,'primera'=>1,'última'=>1,
        'llegar'=>1,'volver'=>1,'seguir'=>1,'dejar'=>1,'quedar'=>1,'parecer'=>1,'sentir'=>1,'pensar'=>1,
        'creer'=>1,'mirar'=>1,'oír'=>1,'escuchar'=>1,'encontrar'=>1,'llevar'=>1,'tomar'=>1,'darle'=>1
    ];

    private function extractContextWords(string $text, array $charWordSet): array
    {
        $out = [];
        foreach (SpanishNLP::tokenizeRaw($text) as $w) {
            $lw = Utf8Helper::toLower($w);
            if (Utf8Helper::len($lw) < 4 || SpanishNLP::isStopword($lw) || isset($charWordSet[$lw]) || isset(self::$genericCtxWords[$lw])) {
                continue;
            }
            $out[] = $lw;
        }
        return $out;
    }

    private function scoreSentiment(string $text, array $posSet, array $negSet): array
    {
        $pos = 0;
        $neg = 0;
        foreach (SpanishNLP::tokenizeRaw($text) as $w) {
            $lw = Utf8Helper::toLower($w);
            if (isset($posSet[$lw])) {
                $pos++;
            } elseif (isset($negSet[$lw])) {
                $neg++;
            }
        }
        return [$pos, $neg];
    }

    private function computePageRank(array $adj, int $n): array
    {
        $damping = 0.85;
        $pr = array_fill(0, $n, 1.0 / $n);
        $wSum = array_fill(0, $n, 0.0);
        for ($i = 0; $i < $n; $i++) {
            $wSum[$i] = array_sum($adj[$i]);
        }

        for ($iter = 0; $iter < 40; $iter++) {
            $newPr = array_fill(0, $n, (1.0 - $damping) / $n);
            for ($u = 0; $u < $n; $u++) {
                if ($wSum[$u] <= 0.0) {
                    continue;
                }
                $share = ($damping * $pr[$u]) / $wSum[$u];
                foreach ($adj[$u] as $v => $w) {
                    $newPr[$v] += $share * $w;
                }
            }
            $diff = 0.0;
            for ($i = 0; $i < $n; $i++) {
                $diff += abs($newPr[$i] - $pr[$i]);
            }
            $pr = $newPr;
            if ($diff < 1e-6) {
                break;
            }
        }
        return $pr;
    }

    /**
     * Detección de comunidades mediante optimización voraz de Modularidad estilo Louvain
     * (resolución γ = 1.15 para separar círculos narrativos incluso con un narrador puente).
     */
    private function detectCommunities(array $adj, int $n): array
    {
        $gamma = 1.15;
        $k = array_fill(0, $n, 0.0);
        $twoM = 0.0;
        for ($i = 0; $i < $n; $i++) {
            $k[$i] = array_sum($adj[$i]);
            $twoM += $k[$i];
        }
        if ($twoM <= 0.0) {
            return range(0, $n - 1);
        }

        // Inicializar cada nodo en su propia comunidad
        $comm = range(0, $n - 1);
        $sigmaTot = $k; // suma de grados por comunidad

        // Ordenar por grado ascendente para que los nodos periféricos se agrupen en núcleos locales primero
        $order = range(0, $n - 1);
        usort($order, function ($a, $b) use ($k) {
            return $k[$a] <=> $k[$b];
        });

        for ($pass = 0; $pass < 25; $pass++) {
            $moved = false;
            foreach ($order as $u) {
                if (empty($adj[$u])) {
                    continue;
                }
                $oldC = $comm[$u];
                $ku = $k[$u];

                // Pesos hacia cada comunidad vecina
                $kIn = [];
                foreach ($adj[$u] as $v => $w) {
                    $cv = $comm[$v];
                    $kIn[$cv] = ($kIn[$cv] ?? 0.0) + $w;
                }

                // Retirar u temporalmente de oldC
                $sigmaTot[$oldC] -= $ku;
                $bestC = $oldC;
                $bestGain = ($kIn[$oldC] ?? 0.0) - $gamma * (($sigmaTot[$oldC] * $ku) / $twoM);

                foreach ($kIn as $candC => $wIn) {
                    if ($candC === $oldC) {
                        continue;
                    }
                    $gain = $wIn - $gamma * (($sigmaTot[$candC] * $ku) / $twoM);
                    if ($gain > $bestGain + 1e-9) {
                        $bestGain = $gain;
                        $bestC = $candC;
                    }
                }

                $comm[$u] = $bestC;
                $sigmaTot[$bestC] += $ku;
                if ($bestC !== $oldC) {
                    $moved = true;
                }
            }
            if (!$moved) {
                break;
            }
        }

        // Renumerar comunidades 0..C-1 ordenadas por tamaño descendente
        $counts = array_count_values($comm);
        arsort($counts);
        $remap = [];
        $cid = 0;
        foreach (array_keys($counts) as $old) {
            $remap[$old] = $cid++;
        }
        foreach ($comm as $i => $old) {
            $comm[$i] = $remap[$old];
        }
        return $comm;
    }

    private function computeModularity(array $adj, array $communities): float
    {
        $twoM = 0.0;
        $k = [];
        foreach ($adj as $u => $neighbors) {
            $sum = array_sum($neighbors);
            $k[$u] = $sum;
            $twoM += $sum;
        }
        if ($twoM <= 0.0) {
            return 0.0;
        }

        $q = 0.0;
        $n = count($adj);
        for ($u = 0; $u < $n; $u++) {
            for ($v = 0; $v < $n; $v++) {
                if ($communities[$u] !== $communities[$v]) {
                    continue;
                }
                $auv = $adj[$u][$v] ?? 0.0;
                $q += $auv - (($k[$u] * $k[$v]) / $twoM);
            }
        }
        return $q / $twoM;
    }
}
