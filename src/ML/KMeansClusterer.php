<?php

namespace BiblioML\ML;

use BiblioML\Text\Utf8Helper;

/**
 * Agrupamiento temático no supervisado mediante Spherical K-Means++ (distancia coseno).
 * Incluye cálculo de Silhouette Score para evaluar la cohesión de clústeres.
 */
class KMeansClusterer
{
    /**
     * Agrupa documentos vectorizados con TF-IDF en K clústeres temáticos.
     * @param array<int|string, array<string, float>> $vectors
     * @param array<string, string> $stemToSurface
     */
    public function cluster(array $vectors, array $stemToSurface = [], ?int $k = null): array
    {
        $keys = array_keys($vectors);
        $n = count($keys);
        if ($n === 0) {
            return ['k' => 0, 'clusters' => [], 'silhouette' => 0.0, 'iterations' => 0];
        }
        if ($k === null) {
            $k = max(2, min(5, (int)round(sqrt($n / 1.5))));
        }
        $k = min($k, $n);

        // Inicialización determinista estilo K-Means++ (distancia coseno)
        $centroids = [];
        $chosen = [$keys[0]];
        $centroids[0] = $vectors[$keys[0]];

        for ($c = 1; $c < $k; $c++) {
            $bestKey = null;
            $bestDist = -1.0;
            foreach ($keys as $key) {
                if (in_array($key, $chosen, true)) {
                    continue;
                }
                $minDist = INF;
                foreach ($centroids as $cent) {
                    $d = 1.0 - TfIdf::cosine($vectors[$key], $cent);
                    if ($d < $minDist) {
                        $minDist = $d;
                    }
                }
                if ($minDist > $bestDist) {
                    $bestDist = $minDist;
                    $bestKey = $key;
                }
            }
            if ($bestKey === null) {
                break;
            }
            $chosen[] = $bestKey;
            $centroids[$c] = $vectors[$bestKey];
        }

        $k = count($centroids);
        $assignments = [];
        $iterations = 0;

        for ($iter = 1; $iter <= 30; $iter++) {
            $iterations = $iter;
            $changed = false;
            $groups = array_fill(0, $k, []);

            foreach ($keys as $key) {
                $bestC = 0;
                $bestSim = -INF;
                for ($c = 0; $c < $k; $c++) {
                    $sim = TfIdf::cosine($vectors[$key], $centroids[$c]);
                    if ($sim > $bestSim) {
                        $bestSim = $sim;
                        $bestC = $c;
                    }
                }
                if (!isset($assignments[$key]) || $assignments[$key] !== $bestC) {
                    $changed = true;
                }
                $assignments[$key] = $bestC;
                $groups[$bestC][] = $key;
            }

            // Recalcular centroides L2
            for ($c = 0; $c < $k; $c++) {
                if (!empty($groups[$c])) {
                    $gVecs = [];
                    foreach ($groups[$c] as $gk) {
                        $gVecs[] = $vectors[$gk];
                    }
                    $centroids[$c] = TfIdf::centroid($gVecs);
                }
            }

            if (!$changed) {
                break;
            }
        }

        // Calcular Silhouette Score (coseno)
        $silhouette = $this->computeSilhouette($vectors, $assignments);

        // Construir metadatos de cada clúster
        $clusters = [];
        for ($c = 0; $c < $k; $c++) {
            $members = [];
            foreach ($assignments as $key => $cid) {
                if ($cid === $c) {
                    $members[] = $key;
                }
            }
            if (empty($members)) {
                continue;
            }
            $cent = $centroids[$c];
            arsort($cent);
            $topTerms = [];
            foreach (array_slice($cent, 0, 6, true) as $stem => $w) {
                $label = $stemToSurface[$stem] ?? $stem;
                $topTerms[] = Utf8Helper::ucfirst($label);
            }
            $clusterLabel = implode(' · ', array_slice($topTerms, 0, 3));
            $clusters[] = [
                'cluster_id' => $c,
                'label'      => $clusterLabel ?: ('Clúster ' . ($c + 1)),
                'top_terms'  => $topTerms,
                'members'    => $members,
            ];
        }

        return [
            'k'           => count($clusters),
            'clusters'    => $clusters,
            'assignments' => $assignments,
            'silhouette'  => round($silhouette, 4),
            'iterations'  => $iterations,
        ];
    }

    private function computeSilhouette(array $vectors, array $assignments): float
    {
        $keys = array_keys($vectors);
        $n = count($keys);
        if ($n <= 2) {
            return 0.0;
        }
        $byCluster = [];
        foreach ($assignments as $k => $c) {
            $byCluster[$c][] = $k;
        }
        if (count($byCluster) < 2) {
            return 0.0;
        }

        $sumS = 0.0;
        foreach ($keys as $i) {
            $ci = $assignments[$i];
            $same = $byCluster[$ci];
            if (count($same) <= 1) {
                continue;
            }
            $a = 0.0;
            foreach ($same as $j) {
                if ($j !== $i) {
                    $a += (1.0 - TfIdf::cosine($vectors[$i], $vectors[$j]));
                }
            }
            $a /= (count($same) - 1);

            $b = INF;
            foreach ($byCluster as $otherC => $otherMembers) {
                if ($otherC === $ci || empty($otherMembers)) {
                    continue;
                }
                $dSum = 0.0;
                foreach ($otherMembers as $j) {
                    $dSum += (1.0 - TfIdf::cosine($vectors[$i], $vectors[$j]));
                }
                $avgD = $dSum / count($otherMembers);
                if ($avgD < $b) {
                    $b = $avgD;
                }
            }

            $denom = max($a, $b);
            if ($denom > 0.0 && $b < INF) {
                $sumS += ($b - $a) / $denom;
            }
        }
        return $sumS / $n;
    }
}
