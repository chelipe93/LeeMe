<?php

namespace BiblioML\ML;

/**
 * Motor TF-IDF con frecuencia sublineal (1 + log(tf)), IDF suavizado y normalización L2.
 */
class TfIdf
{
    /** @var array<string, float> */
    private $idf = [];
    /** @var int */
    private $docCount = 0;

    /**
     * Ajusta el diccionario IDF a partir de un conjunto de documentos tokenizados.
     * @param array<int|string, array<int, string>> $tokenizedDocs
     */
    public function fit(array $tokenizedDocs): void
    {
        $this->docCount = count($tokenizedDocs);
        $df = [];
        foreach ($tokenizedDocs as $tokens) {
            $seen = [];
            foreach ($tokens as $t) {
                if (!isset($seen[$t])) {
                    $seen[$t] = true;
                    $df[$t] = ($df[$t] ?? 0) + 1;
                }
            }
        }
        $this->idf = [];
        $n = $this->docCount;
        foreach ($df as $term => $count) {
            $this->idf[$term] = log(($n + 1.0) / ($count + 1.0)) + 1.0;
        }
    }

    /**
     * Transforma una lista de tokens en un vector disperso TF-IDF normalizado (norma L2 = 1).
     * @param array<int, string> $tokens
     * @return array<string, float>
     */
    public function transform(array $tokens): array
    {
        if (empty($tokens)) {
            return [];
        }
        $tf = array_count_values($tokens);
        $vec = [];
        $normSq = 0.0;

        foreach ($tf as $term => $count) {
            $idfVal = $this->idf[$term] ?? (log(($this->docCount + 1.0) / 1.0) + 1.0);
            $w = (1.0 + log((float)$count)) * $idfVal;
            $vec[$term] = $w;
            $normSq += $w * $w;
        }

        if ($normSq > 0.0) {
            $invNorm = 1.0 / sqrt($normSq);
            foreach ($vec as $term => $w) {
                $vec[$term] = $w * $invNorm;
            }
        }
        return $vec;
    }

    /**
     * Similitud coseno entre dos vectores dispersos ya normalizados L2.
     */
    public static function cosine(array $a, array $b): float
    {
        if (empty($a) || empty($b)) {
            return 0.0;
        }
        if (count($a) > count($b)) {
            $tmp = $a;
            $a = $b;
            $b = $tmp;
        }
        $dot = 0.0;
        foreach ($a as $k => $v) {
            if (isset($b[$k])) {
                $dot += $v * $b[$k];
            }
        }
        return $dot;
    }

    /**
     * Calcula el centroide normalizado L2 de un grupo de vectores.
     */
    public static function centroid(array $vectors): array
    {
        $sum = [];
        foreach ($vectors as $vec) {
            foreach ($vec as $k => $v) {
                $sum[$k] = ($sum[$k] ?? 0.0) + $v;
            }
        }
        $normSq = 0.0;
        foreach ($sum as $v) {
            $normSq += $v * $v;
        }
        if ($normSq > 0.0) {
            $inv = 1.0 / sqrt($normSq);
            foreach ($sum as $k => $v) {
                $sum[$k] = $v * $inv;
            }
        }
        return $sum;
    }

    public function getVocabularySize(): int
    {
        return count($this->idf);
    }
}
