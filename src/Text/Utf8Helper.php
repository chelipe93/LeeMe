<?php

namespace BiblioML\Text;

/**
 * Utilidades UTF-8 en PHP puro (no requiere extensiones mbstring ni intl).
 */
class Utf8Helper
{
    private static $upperToLower = [
        'A'=>'a','B'=>'b','C'=>'c','D'=>'d','E'=>'e','F'=>'f','G'=>'g','H'=>'h','I'=>'i','J'=>'j',
        'K'=>'k','L'=>'l','M'=>'m','N'=>'n','O'=>'o','P'=>'p','Q'=>'q','R'=>'r','S'=>'s','T'=>'t',
        'U'=>'u','V'=>'v','W'=>'w','X'=>'x','Y'=>'y','Z'=>'z',
        'Á'=>'á','É'=>'é','Í'=>'í','Ó'=>'ó','Ú'=>'ú','Ü'=>'ü','Ñ'=>'ñ',
        'À'=>'à','È'=>'è','Ì'=>'ì','Ò'=>'ò','Ù'=>'ù','Â'=>'â','Ê'=>'ê','Î'=>'î','Ô'=>'ô','Û'=>'û',
        'Ä'=>'ä','Ë'=>'ë','Ï'=>'ï','Ö'=>'ö','Ç'=>'ç','Ã'=>'ã','Õ'=>'õ'
    ];

    private static $lowerToUpper = null;

    private static $stripMap = [
        'á'=>'a','é'=>'e','í'=>'i','ó'=>'o','ú'=>'u','ü'=>'u','ñ'=>'n',
        'Á'=>'A','É'=>'E','Í'=>'I','Ó'=>'O','Ú'=>'U','Ü'=>'U','Ñ'=>'N',
        'à'=>'a','è'=>'e','ì'=>'i','ò'=>'o','ù'=>'u','â'=>'a','ê'=>'e','î'=>'i','ô'=>'o','û'=>'u',
        'ä'=>'a','ë'=>'e','ï'=>'i','ö'=>'o','ç'=>'c','ã'=>'a','õ'=>'o',
        'À'=>'A','È'=>'E','Ì'=>'I','Ò'=>'O','Ù'=>'U','Â'=>'A','Ê'=>'E','Î'=>'I','Ô'=>'O','Û'=>'U',
        'Ä'=>'A','Ë'=>'E','Ï'=>'I','Ö'=>'O','Ç'=>'C','Ã'=>'A','Õ'=>'O'
    ];

    /**
     * Normaliza marcas diacríticas combinantes (NFD -> NFC) comunes en PDFs de Kindle.
     */
    public static function normalizeNfc(string $text): string
    {
        // Dotless i (\u0131) + combining acute (\u0301) -> í
        // Base letter + combining acute (\u0301), tilde (\u0303), diaeresis (\u0308), grave (\u0300), circumflex (\u0302)
        static $combiningMap = [
            "a\xCC\x81" => 'á', "e\xCC\x81" => 'é', "i\xCC\x81" => 'í', "\xC4\xB1\xCC\x81" => 'í',
            "o\xCC\x81" => 'ó', "u\xCC\x81" => 'ú',
            "A\xCC\x81" => 'Á', "E\xCC\x81" => 'É', "I\xCC\x81" => 'Í',
            "O\xCC\x81" => 'Ó', "U\xCC\x81" => 'Ú',
            "n\xCC\x83" => 'ñ', "N\xCC\x83" => 'Ñ',
            "a\xCC\x83" => 'ã', "o\xCC\x83" => 'õ',
            "u\xCC\x88" => 'ü', "U\xCC\x88" => 'Ü',
            "a\xCC\x88" => 'ä', "e\xCC\x88" => 'ë', "i\xCC\x88" => 'ï', "o\xCC\x88" => 'ö',
            "a\xCC\x80" => 'à', "e\xCC\x80" => 'è', "i\xCC\x80" => 'ì', "o\xCC\x80" => 'ò', "u\xCC\x80" => 'ù',
            "a\xCC\x82" => 'â', "e\xCC\x82" => 'ê', "i\xCC\x82" => 'î', "o\xCC\x82" => 'ô', "u\xCC\x82" => 'û',
            "c\xCC\xA7" => 'ç', "C\xCC\xA7" => 'Ç',
            // En algunos PDFs el acento combinante viene antes o separado de dotless i
            "\xCC\x81a" => 'á', "\xCC\x81e" => 'é', "\xCC\x81i" => 'í', "\xCC\x81\xC4\xB1" => 'í',
            "\xCC\x81o" => 'ó', "\xCC\x81u" => 'ú',
            "\xCC\x83n" => 'ñ', "\xCC\x88u" => 'ü',
        ];
        $text = strtr($text, $combiningMap);
        // Cualquier dotless i remanente -> i
        $text = str_replace("\xC4\xB1", 'i', $text);
        return $text;
    }

    public static function toLower(string $text): string
    {
        return strtr($text, self::$upperToLower);
    }

    public static function toUpper(string $text): string
    {
        if (self::$lowerToUpper === null) {
            self::$lowerToUpper = array_flip(self::$upperToLower);
        }
        return strtr($text, self::$lowerToUpper);
    }

    public static function stripAccents(string $text): string
    {
        return strtr($text, self::$stripMap);
    }

    public static function len(string $text): int
    {
        if ($text === '') {
            return 0;
        }
        $count = preg_match_all('/./us', $text);
        return $count === false ? strlen($text) : $count;
    }

    public static function substr(string $text, int $start, ?int $length = null): string
    {
        if ($text === '') {
            return '';
        }
        preg_match_all('/./us', $text, $m);
        $chars = $m[0];
        $slice = $length === null ? array_slice($chars, $start) : array_slice($chars, $start, $length);
        return implode('', $slice);
    }

    public static function ucfirst(string $text): string
    {
        if ($text === '') {
            return '';
        }
        $first = self::substr($text, 0, 1);
        $rest = self::substr($text, 1);
        return self::toUpper($first) . $rest;
    }

    public static function isUpperStart(string $word): bool
    {
        return (bool)preg_match('/^\p{Lu}/u', $word);
    }

    public static function isAllUpper(string $word): bool
    {
        return (bool)preg_match('/^\p{Lu}+$/u', $word);
    }

    public static function cleanWhitespace(string $text): string
    {
        $text = str_replace(["\xC2\xA0", "\t", "\r"], ' ', $text);
        $text = preg_replace('/[ ]{2,}/', ' ', $text);
        $text = preg_replace('/\n{3,}/', "\n\n", $text);
        return trim($text);
    }

    public static function normalizeForMatch(string $text): string
    {
        $text = self::normalizeNfc($text);
        $text = self::toLower($text);
        $text = self::stripAccents($text);
        $text = preg_replace('/[^a-z0-9]+/u', ' ', $text);
        return trim(preg_replace('/\s+/', ' ', $text));
    }

    public static function codePointToUtf8(int $cp): string
    {
        if ($cp < 0 || $cp > 0x10FFFF) {
            return '';
        }
        if ($cp <= 0x7F) {
            return chr($cp);
        }
        if ($cp <= 0x7FF) {
            return chr(0xC0 | ($cp >> 6)) . chr(0x80 | ($cp & 0x3F));
        }
        if ($cp <= 0xFFFF) {
            return chr(0xE0 | ($cp >> 12))
                . chr(0x80 | (($cp >> 6) & 0x3F))
                . chr(0x80 | ($cp & 0x3F));
        }
        return chr(0xF0 | ($cp >> 18))
            . chr(0x80 | (($cp >> 12) & 0x3F))
            . chr(0x80 | (($cp >> 6) & 0x3F))
            . chr(0x80 | ($cp & 0x3F));
    }
}
