<?php

namespace BiblioML\Parsers;

use BiblioML\Text\Utf8Helper;

/**
 * Parser estructurado para PDFs de "Bloc de notas" exportados desde Kindle
 * (en español e inglés). Extrae capítulos, subrayados, notas personales,
 * marcadores, páginas, colores, fechas y maneja continuaciones entre páginas.
 */
class KindleNotesParser
{
    /** @var PdfParser */
    private $pdfParser;

    public function __construct(?PdfParser $pdfParser = null)
    {
        $this->pdfParser = $pdfParser ?: new PdfParser();
    }

    /**
     * @return array{
     *   stats: array{total_declared:int, highlights:int, notes:int, bookmarks:int, pages_pdf:int},
     *   items: array<int, array>
     * }
     */
    public function parse(string $pdfPath): array
    {
        $pages = $this->pdfParser->extractPages($pdfPath);

        $stats = [
            'total_declared' => 0,
            'highlights'     => 0,
            'notes'          => 0,
            'bookmarks'      => 0,
            'pages_pdf'      => count($pages),
        ];

        // Aplanar líneas descartando pie de página numérico de cada página del PDF
        $allLines = [];
        foreach ($pages as $pageData) {
            $pNum = $pageData['page'];
            foreach ($pageData['lines'] as $line) {
                $t = trim($line['text']);
                if ($t === '') {
                    continue;
                }
                // Ignorar número de página al pie del PDF (ej. y < 70 y texto == número de página)
                if ($line['y'] < 75 && preg_match('/^\d{1,4}$/', $t) && (int)$t === $pNum) {
                    continue;
                }
                $allLines[] = [
                    'text' => $t,
                    'x'    => $line['x'],
                    'y'    => $line['y'],
                    'size' => $line['size'],
                    'pdf_page' => $pNum,
                ];
            }
        }

        $items = [];
        $currentSection = null;
        $currentItem = null;
        $inUserNote = false;
        $headerDone = false;

        $pushCurrent = function () use (&$items, &$currentItem, &$inUserNote) {
            if ($currentItem !== null) {
                $currentItem['highlight_text'] = Utf8Helper::cleanWhitespace($currentItem['highlight_text'] ?? '');
                $currentItem['user_note'] = Utf8Helper::cleanWhitespace($currentItem['user_note'] ?? '');
                if ($currentItem['highlight_text'] === '') {
                    $currentItem['highlight_text'] = null;
                }
                if ($currentItem['user_note'] === '') {
                    $currentItem['user_note'] = null;
                }
                $items[] = $currentItem;
            }
            $currentItem = null;
            $inUserNote = false;
        };

        $datePattern = '/^\d{1,2}\s+(?:ene|feb|mar|abr|may|jun|jul|ago|sep|sept|oct|nov|dic|jan|apr|aug|dec)\.?\s+\d{4}$/iu';

        foreach ($allLines as $idx => $lineObj) {
            $line = $lineObj['text'];
            $x = $lineObj['x'];

            // Encabezado del Bloc de Notas (página 1)
            if (!$headerDone) {
                if (preg_match('/^Notas?\s*\((\d+)\)/iu', $line, $m)) {
                    $stats['total_declared'] = (int)$m[1];
                    continue;
                }
                if (preg_match('/^[•\-\*]\s*(\d+)\s+(?:subrayados|highlights)/iu', $line)) {
                    continue;
                }
                if (preg_match('/^[•\-\*]\s*(\d+)\s+(?:marcadores|bookmarks)/iu', $line)) {
                    continue;
                }
                if (preg_match('/^[•\-\*]\s*(\d+)\s+(?:notas|notes)/iu', $line)) {
                    continue;
                }
                if (Utf8Helper::toLower($line) === 'kindle') {
                    continue;
                }
            }

            // Encabezado de ítem Kindle: "Página 15 | Resaltar (Amarillo)" / "Página 29 | Marcador (Azul)" / "Página 30 | Nota"
            if (preg_match('/^(?:P[aá]gina|Page|Posici[oó]n|Location)\s+(\d+)\s*\|\s*(.+)$/iu', $line, $hm)) {
                $headerDone = true;
                $pushCurrent();

                $pageNum = (int)$hm[1];
                $typeRaw = trim($hm[2]);
                $typeLow = Utf8Helper::toLower($typeRaw);

                $noteType = 'highlight';
                $color = null;

                if (strpos($typeLow, 'marcador') !== false || strpos($typeLow, 'bookmark') !== false) {
                    $noteType = 'bookmark';
                } elseif (strpos($typeLow, 'nota') !== false || strpos($typeLow, 'note') !== false) {
                    $noteType = 'note';
                } else {
                    $noteType = 'highlight';
                }

                if (preg_match('/\(([^)]+)\)/u', $typeRaw, $cm)) {
                    $color = trim($cm[1]);
                }

                $currentItem = [
                    'pdf_chapter_label' => $currentSection,
                    'page_number'       => $pageNum,
                    'note_type'         => $noteType,
                    'highlight_color'   => $color,
                    'highlight_text'    => '',
                    'user_note'         => '',
                    'note_date'         => null,
                ];
                $inUserNote = ($noteType === 'note');
                continue;
            }

            // Línea de "Nota: ..." adjunta a un subrayado
            if ($currentItem !== null && preg_match('/^(?:Nota|Note)\s*:\s*(.*)$/iu', $line, $nm)) {
                $inUserNote = true;
                $noteContent = trim($nm[1]);
                if ($noteContent !== '') {
                    $currentItem['user_note'] .= ($currentItem['user_note'] !== '' ? ' ' : '') . $noteContent;
                }
                continue;
            }

            // Fecha ("26 oct. 2026")
            if (preg_match($datePattern, $line)) {
                if ($currentItem !== null && $currentItem['note_date'] === null) {
                    $currentItem['note_date'] = $line;
                }
                continue;
            }

            // Encabezado de capítulo/sección del PDF: en Kindle va alineado al margen izquierdo (x <= 55)
            // y ocurre cuando ya tenemos una fecha del ítem anterior o antes del primer ítem
            $isSectionCandidate = ($x <= 56 && Utf8Helper::len($line) <= 80 && (
                $currentItem === null || $currentItem['note_date'] !== null
            ));
            if ($isSectionCandidate) {
                $headerDone = true;
                $pushCurrent();
                $currentSection = $line;
                continue;
            }

            // Contenido del subrayado o de la nota
            if ($currentItem !== null) {
                if ($inUserNote) {
                    $currentItem['user_note'] .= ($currentItem['user_note'] !== '' ? ' ' : '') . $line;
                } elseif ($currentItem['note_type'] === 'highlight') {
                    $currentItem['highlight_text'] .= ($currentItem['highlight_text'] !== '' ? ' ' : '') . $line;
                }
            }
        }

        $pushCurrent();

        // Contar estadísticas reales extraídas
        foreach ($items as $idx => &$it) {
            $it['sort_order'] = $idx + 1;
            if ($it['note_type'] === 'highlight') {
                $stats['highlights']++;
                if ($it['user_note'] !== null) {
                    $stats['notes']++;
                }
            } elseif ($it['note_type'] === 'bookmark') {
                $stats['bookmarks']++;
            } elseif ($it['note_type'] === 'note') {
                $stats['notes']++;
            }
        }
        unset($it);

        return [
            'stats' => $stats,
            'items' => $items,
        ];
    }
}
