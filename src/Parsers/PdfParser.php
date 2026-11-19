<?php

namespace BiblioML\Parsers;

use BiblioML\Text\Utf8Helper;
use RuntimeException;

/**
 * Extractor de texto PDF en PHP puro (PDF 1.4 - 1.7).
 * Soporta:
 * - Objetos estándar y comprimidos en /ObjStm
 * - Streams /FlateDecode
 * - Fuentes Type0/CID (2 bytes) y fuentes de 1 byte (WinAnsi)
 * - Mapas /ToUnicode (beginbfchar y beginbfrange con arreglos y rangos)
 * - Reconstrucción de líneas por coordenadas (x, y) y normalización Unicode NFC
 */
class PdfParser
{
    /** @var array<int, string> */
    private $objects = [];
    /** @var array<int, string> */
    private $rawStreams = [];
    /** @var array<int, array> */
    private $cmapCache = [];

    /**
     * Extrae las páginas como arreglos de líneas de texto ordenadas visualmente.
     * @return array<int, array{page:int, lines:array<int, array{text:string, x:float, y:float, font:string, size:float}>, text:string}>
     */
    public function extractPages(string $pdfPath): array
    {
        if (!is_file($pdfPath)) {
            throw new RuntimeException("Archivo PDF no encontrado: {$pdfPath}");
        }
        $raw = file_get_contents($pdfPath);
        if ($raw === false || strncmp($raw, '%PDF', 4) !== 0) {
            throw new RuntimeException("El archivo no es un PDF válido.");
        }

        $this->objects = [];
        $this->rawStreams = [];
        $this->cmapCache = [];

        $this->parseAllObjects($raw);
        $this->unpackObjectStreams();

        $pageIds = $this->findPageObjectIds();
        $pages = [];
        $pageNum = 0;

        foreach ($pageIds as $pageId) {
            $pageNum++;
            $pageBody = $this->objects[$pageId] ?? '';
            $fontMap = $this->extractPageFonts($pageBody);
            $contentStream = $this->extractPageContentStream($pageBody);
            $lines = $this->parseContentStreamToLines($contentStream, $fontMap);

            $plainLines = array_map(function ($l) {
                return $l['text'];
            }, $lines);

            $pages[] = [
                'page'  => $pageNum,
                'lines' => $lines,
                'text'  => implode("\n", $plainLines),
            ];
        }

        return $pages;
    }

    private function parseAllObjects(string $raw): void
    {
        $len = strlen($raw);
        $offset = 0;
        while (preg_match('/(\d+)\s+\d+\s+obj\b/s', $raw, $m, PREG_OFFSET_CAPTURE, $offset)) {
            $objId = (int)$m[1][0];
            $startPos = $m[0][1] + strlen($m[0][0]);
            $endPos = strpos($raw, 'endobj', $startPos);
            if ($endPos === false) {
                break;
            }
            $body = substr($raw, $startPos, $endPos - $startPos);
            $this->objects[$objId] = $body;

            // Extraer stream si existe
            $streamPos = strpos($body, 'stream');
            if ($streamPos !== false) {
                // Asegurar que 'stream' no sea parte de 'endstream' o un nombre '/stream'
                if (preg_match('/(?:>>|\s)stream(?:\r\n|\n|\r)/s', $body, $sm, PREG_OFFSET_CAPTURE)) {
                    $sStart = $sm[0][1] + strlen($sm[0][0]);
                    $sEnd = strrpos($body, 'endstream');
                    if ($sEnd !== false && $sEnd >= $sStart) {
                        $sData = substr($body, $sStart, $sEnd - $sStart);
                        // Quitar salto de línea final antes de endstream
                        $sData = preg_replace('/(?:\r\n|\n|\r)$/', '', $sData);
                        $this->rawStreams[$objId] = $sData;
                    }
                }
            }

            $offset = $endPos + 6;
            if ($offset >= $len) {
                break;
            }
        }
    }

    private function unpackObjectStreams(): void
    {
        foreach ($this->objects as $id => $body) {
            if (strpos($body, '/ObjStm') === false || !isset($this->rawStreams[$id])) {
                continue;
            }
            $data = $this->decompressStream($id);
            if ($data === null) {
                continue;
            }
            if (!preg_match('/\/First\s+(\d+)/', $body, $fm)) {
                continue;
            }
            $first = (int)$fm[1];
            $header = trim(substr($data, 0, $first));
            $content = substr($data, $first);

            $tokens = preg_split('/\s+/', $header);
            $entries = [];
            for ($i = 0; $i + 1 < count($tokens); $i += 2) {
                $entries[] = [(int)$tokens[$i], (int)$tokens[$i + 1]];
            }

            $total = count($entries);
            for ($i = 0; $i < $total; $i++) {
                $subId = $entries[$i][0];
                $subStart = $entries[$i][1];
                $subEnd = ($i + 1 < $total) ? $entries[$i + 1][1] : strlen($content);
                if (!isset($this->objects[$subId])) {
                    $this->objects[$subId] = trim(substr($content, $subStart, $subEnd - $subStart));
                }
            }
        }
    }

    private function decompressStream(int $objId): ?string
    {
        if (!isset($this->rawStreams[$objId])) {
            return null;
        }
        $body = $this->objects[$objId] ?? '';
        $data = $this->rawStreams[$objId];

        if (strpos($body, '/FlateDecode') !== false) {
            $un = @gzuncompress($data);
            if ($un === false) {
                $un = @gzinflate($data);
            }
            if ($un === false && strlen($data) > 2) {
                $un = @gzinflate(substr($data, 2));
            }
            return $un === false ? null : $un;
        }
        return $data;
    }

    private function findPageObjectIds(): array
    {
        // Buscar /Type /Catalog -> /Pages X 0 R
        $rootPagesId = null;
        foreach ($this->objects as $id => $body) {
            if (preg_match('/\/Type\s*\/Catalog\b/', $body) && preg_match('/\/Pages\s+(\d+)\s+\d+\s+R/', $body, $m)) {
                $rootPagesId = (int)$m[1];
                break;
            }
        }

        $pages = [];
        if ($rootPagesId !== null) {
            $this->collectPagesRecursive($rootPagesId, $pages);
        }

        // Fallback si el árbol de páginas no se resolvió
        if (empty($pages)) {
            foreach ($this->objects as $id => $body) {
                if (preg_match('/\/Type\s*\/Page\b(?!s)/', $body)) {
                    $pages[] = $id;
                }
            }
        }

        return $pages;
    }

    private function collectPagesRecursive(int $nodeId, array &$pages, int $depth = 0): void
    {
        if ($depth > 20 || !isset($this->objects[$nodeId])) {
            return;
        }
        $body = $this->objects[$nodeId];
        if (preg_match('/\/Kids\s*\[(.*?)\]/s', $body, $km)) {
            if (preg_match_all('/(\d+)\s+\d+\s+R/', $km[1], $rm)) {
                foreach ($rm[1] as $kidId) {
                    $this->collectPagesRecursive((int)$kidId, $pages, $depth + 1);
                }
            }
            return;
        }
        if (preg_match('/\/Type\s*\/Page\b(?!s)/', $body)) {
            $pages[] = $nodeId;
        }
    }

    private function extractPageFonts(string $pageBody): array
    {
        $resDict = '';
        if (preg_match('/\/Resources\s+(\d+)\s+\d+\s+R/', $pageBody, $rm)) {
            $resDict = $this->objects[(int)$rm[1]] ?? '';
        } elseif (preg_match('/\/Resources\s*<<(.*?)>>/s', $pageBody, $rm)) {
            $resDict = $rm[1];
        }

        // También revisar /Parent si /Resources es heredado
        if ($resDict === '' && preg_match('/\/Parent\s+(\d+)\s+\d+\s+R/', $pageBody, $pm)) {
            $parentBody = $this->objects[(int)$pm[1]] ?? '';
            if (preg_match('/\/Resources\s+(\d+)\s+\d+\s+R/', $parentBody, $rm)) {
                $resDict = $this->objects[(int)$rm[1]] ?? '';
            }
        }

        $fontDictStr = '';
        if (preg_match('/\/Font\s+(\d+)\s+\d+\s+R/', $resDict, $fm)) {
            $fontDictStr = $this->objects[(int)$fm[1]] ?? '';
        } elseif (preg_match('/\/Font\s*<<(.*?)>>/s', $resDict, $fm)) {
            $fontDictStr = $fm[1];
        }

        $fonts = [];
        if (preg_match_all('/\/([A-Za-z0-9_]+)\s+(\d+)\s+\d+\s+R/', $fontDictStr, $matches, PREG_SET_ORDER)) {
            foreach ($matches as $m) {
                $fontName = $m[1];
                $fontObjId = (int)$m[2];
                $fonts[$fontName] = $this->loadFontInfo($fontObjId);
            }
        }
        return $fonts;
    }

    private function loadFontInfo(int $fontObjId): array
    {
        $body = $this->objects[$fontObjId] ?? '';
        $isCid = (strpos($body, '/Type0') !== false || strpos($body, '/Identity-H') !== false || strpos($body, '/DescendantFonts') !== false);
        $cmap = null;

        if (preg_match('/\/ToUnicode\s+(\d+)\s+\d+\s+R/', $body, $tm)) {
            $cmapId = (int)$tm[1];
            $cmap = $this->parseToUnicodeCMap($cmapId);
        }

        return [
            'id'        => $fontObjId,
            'is_cid'    => $isCid || ($cmap !== null && ($cmap['bytes'] ?? 1) === 2),
            'cmap'      => $cmap,
            'is_bold'   => (stripos($body, 'Bold') !== false),
        ];
    }

    private function parseToUnicodeCMap(int $cmapObjId): ?array
    {
        if (isset($this->cmapCache[$cmapObjId])) {
            return $this->cmapCache[$cmapObjId];
        }
        $stream = $this->decompressStream($cmapObjId);
        if ($stream === null) {
            return null;
        }

        $map = [];
        $bytes = 1;

        if (preg_match('/begincodespacerange\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/s', $stream, $cm)) {
            $bytes = max(1, (int)(strlen($cm[1]) / 2));
        }

        // beginbfchar ... endbfchar
        if (preg_match_all('/beginbfchar(.*?)endbfchar/s', $stream, $blocks)) {
            foreach ($blocks[1] as $block) {
                if (preg_match_all('/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/', $block, $pairs, PREG_SET_ORDER)) {
                    foreach ($pairs as $p) {
                        $src = hexdec($p[1]);
                        $map[$src] = $this->hexUtf16ToUtf8($p[2]);
                        if (strlen($p[1]) >= 4) {
                            $bytes = 2;
                        }
                    }
                }
            }
        }

        // beginbfrange ... endbfrange
        if (preg_match_all('/beginbfrange(.*?)endbfrange/s', $stream, $blocks)) {
            foreach ($blocks[1] as $block) {
                // Forma 1: <start> <end> <dstStart>
                if (preg_match_all('/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/', $block, $ranges, PREG_SET_ORDER)) {
                    foreach ($ranges as $r) {
                        $start = hexdec($r[1]);
                        $end = hexdec($r[2]);
                        $dstStart = hexdec($r[3]);
                        if (strlen($r[1]) >= 4) {
                            $bytes = 2;
                        }
                        $limit = min($end, $start + 4096);
                        for ($code = $start; $code <= $limit; $code++) {
                            $map[$code] = Utf8Helper::codePointToUtf8($dstStart + ($code - $start));
                        }
                    }
                }
                // Forma 2: <start> <end> [<dst1> <dst2> ...]
                if (preg_match_all('/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[(.*?)\]/s', $block, $arrRanges, PREG_SET_ORDER)) {
                    foreach ($arrRanges as $r) {
                        $start = hexdec($r[1]);
                        if (strlen($r[1]) >= 4) {
                            $bytes = 2;
                        }
                        if (preg_match_all('/<([0-9A-Fa-f]+)>/', $r[3], $dsts)) {
                            foreach ($dsts[1] as $idx => $hexDst) {
                                $map[$start + $idx] = $this->hexUtf16ToUtf8($hexDst);
                            }
                        }
                    }
                }
            }
        }

        $result = ['bytes' => $bytes, 'map' => $map];
        $this->cmapCache[$cmapObjId] = $result;
        return $result;
    }

    private function hexUtf16ToUtf8(string $hex): string
    {
        $hex = strtoupper($hex);
        if (strlen($hex) % 4 !== 0) {
            $cp = hexdec($hex);
            return Utf8Helper::codePointToUtf8($cp);
        }
        $out = '';
        for ($i = 0; $i < strlen($hex); $i += 4) {
            $cp = hexdec(substr($hex, $i, 4));
            // Par sustituto UTF-16
            if ($cp >= 0xD800 && $cp <= 0xDBFF && $i + 4 < strlen($hex)) {
                $low = hexdec(substr($hex, $i + 4, 4));
                if ($low >= 0xDC00 && $low <= 0xDFFF) {
                    $cp = 0x10000 + (($cp - 0xD800) << 10) + ($low - 0xDC00);
                    $i += 4;
                }
            }
            $out .= Utf8Helper::codePointToUtf8($cp);
        }
        return $out;
    }

    private function extractPageContentStream(string $pageBody): string
    {
        $streams = [];
        if (preg_match('/\/Contents\s+(\d+)\s+\d+\s+R/', $pageBody, $cm)) {
            $s = $this->decompressStream((int)$cm[1]);
            if ($s !== null) {
                $streams[] = $s;
            }
        } elseif (preg_match('/\/Contents\s*\[(.*?)\]/s', $pageBody, $cm)) {
            if (preg_match_all('/(\d+)\s+\d+\s+R/', $cm[1], $ids)) {
                foreach ($ids[1] as $cid) {
                    $s = $this->decompressStream((int)$cid);
                    if ($s !== null) {
                        $streams[] = $s;
                    }
                }
            }
        }
        return implode("\n", $streams);
    }

    private function parseContentStreamToLines(string $stream, array $fontMap): array
    {
        if ($stream === '') {
            return [];
        }

        // Extraer todos los bloques BT ... ET
        $runs = [];
        $currentFont = '';
        $currentSize = 12.0;

        $len = strlen($stream);
        $pos = 0;

        while ($pos < $len) {
            // Buscar siguiente BT
            $btPos = $this->findOperator($stream, 'BT', $pos);
            if ($btPos === false) {
                break;
            }
            $etPos = $this->findOperator($stream, 'ET', $btPos + 2);
            if ($etPos === false) {
                break;
            }

            $block = substr($stream, $btPos + 2, $etPos - $btPos - 2);
            $pos = $etPos + 2;

            $tx = 0.0;
            $ty = 0.0;
            $tl = 0.0;
            $blockFont = $currentFont;
            $blockSize = $currentSize;

            $tokens = $this->tokenizePdfStream($block);
            $operands = [];
            $lineText = '';
            $lineX = null;
            $lineY = null;
            $lineFont = $blockFont;
            $lineSize = $blockSize;

            $flushRun = function () use (&$runs, &$lineText, &$lineX, &$lineY, &$lineFont, &$lineSize) {
                $norm = Utf8Helper::normalizeNfc($lineText);
                if (trim($norm) !== '') {
                    $runs[] = [
                        'text' => $norm,
                        'x'    => $lineX ?? 0.0,
                        'y'    => $lineY ?? 0.0,
                        'font' => $lineFont,
                        'size' => $lineSize,
                    ];
                }
                $lineText = '';
                $lineX = null;
                $lineY = null;
            };

            foreach ($tokens as $tok) {
                if ($tok['type'] !== 'op') {
                    $operands[] = $tok;
                    continue;
                }

                $op = $tok['val'];
                switch ($op) {
                    case 'Tf':
                        if (count($operands) >= 2) {
                            $fTok = $operands[count($operands) - 2];
                            $sTok = $operands[count($operands) - 1];
                            $blockFont = ltrim((string)$fTok['val'], '/');
                            $blockSize = (float)$sTok['val'];
                            $currentFont = $blockFont;
                            $currentSize = $blockSize;
                        }
                        break;

                    case 'TL':
                        if (count($operands) >= 1) {
                            $tl = (float)$operands[count($operands) - 1]['val'];
                        }
                        break;

                    case 'Td':
                    case 'TD':
                        if (count($operands) >= 2) {
                            $dx = (float)$operands[count($operands) - 2]['val'];
                            $dy = (float)$operands[count($operands) - 1]['val'];
                            if ($op === 'TD') {
                                $tl = -$dy;
                            }
                            if ($lineText !== '' && abs($dy) > 1.0) {
                                $flushRun();
                            }
                            $tx += $dx;
                            $ty += $dy;
                        }
                        break;

                    case 'Tm':
                        if (count($operands) >= 6) {
                            $nx = (float)$operands[count($operands) - 2]['val'];
                            $ny = (float)$operands[count($operands) - 1]['val'];
                            if ($lineText !== '' && abs($ny - $ty) > 1.0) {
                                $flushRun();
                            }
                            $tx = $nx;
                            $ty = $ny;
                        }
                        break;

                    case 'T*':
                        if ($lineText !== '') {
                            $flushRun();
                        }
                        $ty -= $tl;
                        break;

                    case 'Tj':
                    case "'":
                    case '"':
                        if ($op === "'" || $op === '"') {
                            if ($lineText !== '') {
                                $flushRun();
                            }
                            $ty -= $tl;
                        }
                        if (!empty($operands)) {
                            $strTok = $operands[count($operands) - 1];
                            $decoded = $this->decodeTextToken($strTok, $fontMap[$blockFont] ?? null);
                            if ($lineX === null) {
                                $lineX = $tx;
                                $lineY = $ty;
                                $lineFont = $blockFont;
                                $lineSize = $blockSize;
                            }
                            $lineText .= $decoded;
                        }
                        break;

                    case 'TJ':
                        if (!empty($operands)) {
                            $arrTok = $operands[count($operands) - 1];
                            if ($arrTok['type'] === 'array') {
                                if ($lineX === null) {
                                    $lineX = $tx;
                                    $lineY = $ty;
                                    $lineFont = $blockFont;
                                    $lineSize = $blockSize;
                                }
                                foreach ($arrTok['val'] as $item) {
                                    if ($item['type'] === 'str' || $item['type'] === 'hex') {
                                        $lineText .= $this->decodeTextToken($item, $fontMap[$blockFont] ?? null);
                                    } elseif ($item['type'] === 'num' && (float)$item['val'] < -180) {
                                        $lineText .= ' ';
                                    }
                                }
                            }
                        }
                        break;
                }
                $operands = [];
            }

            $flushRun();
        }

        // Agrupar runs en líneas visuales: ordenar por Y descendente (arriba->abajo), luego X ascendente
        usort($runs, function ($a, $b) {
            if (abs($a['y'] - $b['y']) > 4.0) {
                return ($b['y'] <=> $a['y']);
            }
            return ($a['x'] <=> $b['x']);
        });

        $lines = [];
        foreach ($runs as $run) {
            $n = count($lines);
            if ($n > 0 && abs($lines[$n - 1]['y'] - $run['y']) <= 4.0) {
                $prev = $lines[$n - 1]['text'];
                $next = $run['text'];
                if ($prev !== '' && substr($prev, -1) !== ' ' && $next !== '' && $next[0] !== ' ') {
                    $lines[$n - 1]['text'] .= ' ' . $next;
                } else {
                    $lines[$n - 1]['text'] .= $next;
                }
            } else {
                $lines[] = $run;
            }
        }

        // Limpiar espacios internos por línea
        foreach ($lines as &$l) {
            $l['text'] = trim(preg_replace('/[ \t]+/', ' ', $l['text']));
        }
        unset($l);

        return array_values(array_filter($lines, function ($l) {
            return $l['text'] !== '';
        }));
    }

    private function findOperator(string $stream, string $op, int $offset)
    {
        $len = strlen($stream);
        $opLen = strlen($op);
        $inStr = false;
        $parenDepth = 0;

        for ($i = $offset; $i < $len; $i++) {
            $ch = $stream[$i];
            if ($inStr) {
                if ($ch === '\\') {
                    $i++;
                    continue;
                }
                if ($ch === '(') {
                    $parenDepth++;
                } elseif ($ch === ')') {
                    $parenDepth--;
                    if ($parenDepth <= 0) {
                        $inStr = false;
                    }
                }
                continue;
            }
            if ($ch === '(') {
                $inStr = true;
                $parenDepth = 1;
                continue;
            }
            if (substr($stream, $i, $opLen) === $op) {
                $before = ($i === 0) ? ' ' : $stream[$i - 1];
                $after = ($i + $opLen >= $len) ? ' ' : $stream[$i + $opLen];
                if (ctype_space($before) && ctype_space($after)) {
                    return $i;
                }
            }
        }
        return false;
    }

    private function tokenizePdfStream(string $s): array
    {
        $tokens = [];
        $len = strlen($s);
        $i = 0;

        while ($i < $len) {
            $c = $s[$i];
            if (ctype_space($c)) {
                $i++;
                continue;
            }
            // Comentario PDF
            if ($c === '%') {
                while ($i < $len && $s[$i] !== "\n" && $s[$i] !== "\r") {
                    $i++;
                }
                continue;
            }
            // Literal string (...)
            if ($c === '(') {
                $i++;
                $depth = 1;
                $buf = '';
                while ($i < $len && $depth > 0) {
                    $ch = $s[$i];
                    if ($ch === '\\' && $i + 1 < $len) {
                        $next = $s[$i + 1];
                        if ($next === "\r" || $next === "\n") {
                            // Line continuation
                            $i += 2;
                            if ($next === "\r" && $i < $len && $s[$i] === "\n") {
                                $i++;
                            }
                            continue;
                        }
                        if ($next >= '0' && $next <= '7') {
                            $oct = $next;
                            $i += 2;
                            for ($k = 0; $k < 2 && $i < $len && $s[$i] >= '0' && $s[$i] <= '7'; $k++) {
                                $oct .= $s[$i++];
                            }
                            $buf .= chr(octdec($oct) & 0xFF);
                            continue;
                        }
                        $escMap = ['n' => "\n", 'r' => "\r", 't' => "\t", 'b' => "\x08", 'f' => "\x0C", '(' => '(', ')' => ')', '\\' => '\\'];
                        $buf .= $escMap[$next] ?? $next;
                        $i += 2;
                        continue;
                    }
                    if ($ch === '(') {
                        $depth++;
                        $buf .= $ch;
                    } elseif ($ch === ')') {
                        $depth--;
                        if ($depth > 0) {
                            $buf .= $ch;
                        }
                    } else {
                        $buf .= $ch;
                    }
                    $i++;
                }
                $tokens[] = ['type' => 'str', 'val' => $buf];
                continue;
            }
            // Hex string <...>
            if ($c === '<' && ($i + 1 >= $len || $s[$i + 1] !== '<')) {
                $end = strpos($s, '>', $i + 1);
                if ($end === false) {
                    break;
                }
                $hex = preg_replace('/\s+/', '', substr($s, $i + 1, $end - $i - 1));
                $tokens[] = ['type' => 'hex', 'val' => $hex];
                $i = $end + 1;
                continue;
            }
            // Array [...]
            if ($c === '[') {
                $i++;
                $arr = [];
                $subBuf = '';
                $depth = 1;
                $inLit = false;
                $pDepth = 0;
                $startArr = $i;
                while ($i < $len && $depth > 0) {
                    $ch = $s[$i];
                    if ($inLit) {
                        if ($ch === '\\') {
                            $i += 2;
                            continue;
                        }
                        if ($ch === '(') $pDepth++;
                        elseif ($ch === ')') {
                            $pDepth--;
                            if ($pDepth <= 0) $inLit = false;
                        }
                        $i++;
                        continue;
                    }
                    if ($ch === '(') {
                        $inLit = true;
                        $pDepth = 1;
                    } elseif ($ch === '[') {
                        $depth++;
                    } elseif ($ch === ']') {
                        $depth--;
                        if ($depth === 0) {
                            break;
                        }
                    }
                    $i++;
                }
                $subBuf = substr($s, $startArr, $i - $startArr);
                $arr = $this->tokenizePdfStream($subBuf);
                $tokens[] = ['type' => 'array', 'val' => $arr];
                $i++;
                continue;
            }
            // Name /Foo
            if ($c === '/') {
                $start = $i;
                $i++;
                while ($i < $len && !ctype_space($s[$i]) && strpos('()<>[]{}/%', $s[$i]) === false) {
                    $i++;
                }
                $tokens[] = ['type' => 'name', 'val' => substr($s, $start, $i - $start)];
                continue;
            }
            // Number or Operator
            $start = $i;
            while ($i < $len && !ctype_space($s[$i]) && strpos('()<>[]{}/%', $s[$i]) === false) {
                $i++;
            }
            $word = substr($s, $start, $i - $start);
            if (is_numeric($word)) {
                $tokens[] = ['type' => 'num', 'val' => (float)$word];
            } else {
                $tokens[] = ['type' => 'op', 'val' => $word];
            }
        }

        return $tokens;
    }

    private function decodeTextToken(array $tok, ?array $fontInfo): string
    {
        if ($tok['type'] === 'hex') {
            $hex = $tok['val'];
            if (strlen($hex) % 2 === 1) {
                $hex .= '0';
            }
            $rawBytes = hex2bin($hex);
            if ($rawBytes === false) {
                return '';
            }
        } elseif ($tok['type'] === 'str') {
            $rawBytes = $tok['val'];
        } else {
            return '';
        }

        if ($fontInfo !== null && $fontInfo['cmap'] !== null) {
            $cmap = $fontInfo['cmap'];
            $bytesPerChar = $cmap['bytes'];
            $map = $cmap['map'];
            $out = '';
            $len = strlen($rawBytes);

            if ($bytesPerChar === 2) {
                for ($i = 0; $i + 1 < $len; $i += 2) {
                    $code = (ord($rawBytes[$i]) << 8) | ord($rawBytes[$i + 1]);
                    if (isset($map[$code])) {
                        $out .= $map[$code];
                    } elseif ($code === 0x0003) {
                        $out .= ' ';
                    } elseif ($code >= 0x20 && $code <= 0x7E) {
                        $out .= chr($code);
                    }
                }
                return $out;
            }

            for ($i = 0; $i < $len; $i++) {
                $code = ord($rawBytes[$i]);
                if (isset($map[$code])) {
                    $out .= $map[$code];
                } elseif ($code >= 0x20 && $code <= 0x7E) {
                    $out .= chr($code);
                }
            }
            return $out;
        }

        // Fallback WinAnsiEncoding (Windows-1252 -> UTF-8)
        $converted = @iconv('Windows-1252', 'UTF-8//IGNORE', $rawBytes);
        return $converted !== false ? $converted : $rawBytes;
    }
}
