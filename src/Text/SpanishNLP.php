<?php

namespace BiblioML\Text;

/**
 * Procesador NLP clásico en español (sin LLMs):
 * - Segmentación de oraciones
 * - Tokenización UTF-8
 * - Eliminación de stopwords
 * - Stemming heurístico estilo Snowball para español
 */
class SpanishNLP
{
    private static $stopwords = null;

    public static function getStopwords(): array
    {
        if (self::$stopwords !== null) {
            return self::$stopwords;
        }
        $words = [
            // Artículos, preposiciones, conjunciones, pronombres
            'a','acá','ahí','al','algo','algún','alguna','algunas','alguno','algunos','allá','allí','ambos',
            'ante','antes','aquel','aquella','aquellas','aquello','aquellos','aquí','arriba','así','atrás',
            'aun','aún','aunque','bajo','bastante','bien','cada','casi','cerca','cierto','cierta','ciertas',
            'ciertos','como','cómo','con','conmigo','conseguimos','conseguir','consigo','consigue','consiguen',
            'consigues','contigo','contra','cual','cuál','cuales','cuáles','cualquier','cualquiera','cuando',
            'cuándo','cuanto','cuánto','cuanta','cuánta','cuantas','cuántas','cuantos','cuántos','cuyo','cuya',
            'cuyos','cuyas','de','debajo','debe','deben','debía','debían','decir','del','delante','demás',
            'demasiado','dentro','desde','después','detrás','día','días','dice','dicen','dicho','dijo','donde',
            'dónde','dos','durante','e','el','él','ella','ellas','ello','ellos','embargo','en','encima',
            'entonces','entre','era','erais','éramos','eran','eras','eres','es','esa','esas','ese','eso',
            'esos','esta','está','estaba','estabais','estábamos','estaban','estabas','estad','estada','estadas',
            'estado','estados','estamos','están','estando','estar','estará','estarán','estarás','estaré',
            'estaría','estas','este','esto','estos','estoy','estuvo','estuviera','estuvieron','ex','excepto',
            'fin','fue','fuera','fueran','fueron','fuese','fui','fuimos','gran','grande','ha','había','habían',
            'habías','habido','habiendo','habrá','habría','hace','hacen','hacer','hacía','hacían','hacia',
            'hago','han','has','hasta','hay','haya','hayan','he','hecho','hemos','hizo','hoy','hubiera',
            'hubieran','hubiese','hubo','igual','incluso','ir','jamás','junto','la','las','le','les','lo',
            'los','luego','lugar','más','mas','mayor','me','mediante','mejor','menor','menos','mi','mí','mía',
            'mías','mientras','mío','míos','mis','misma','mismas','mismo','mismos','modo','mucha','muchas',
            'mucho','muchos','muy','nada','nadie','ni','ningún','ninguna','ningunas','ninguno','ningunos',
            'no','nos','nosotras','nosotros','nuestra','nuestras','nuestro','nuestros','nueva','nuevo','nunca',
            'o','otra','otras','otro','otros','para','parece','parecía','parte','pasar','pasó','pero','pesar',
            'poca','pocas','poco','pocos','podemos','poder','podía','podían','podrá','podría','poner','por',
            'porque','porqué','primera','primero','pronto','propia','propias','propio','propios','pudo',
            'puede','pueden','puedo','pues','que','qué','queda','quedó','quien','quién','quienes','quiénes',
            'quiere','quiso','quizá','quizás','realmente','sabía','saber','se','sé','sea','sean','según',
            'segunda','segundo','seis','ser','será','serán','sería','serían','si','sí','sido','siempre',
            'siendo','siete','sigue','siguiente','sin','sino','siquiera','sobre','sola','solamente','solo',
            'sólo','somos','son','soy','su','sus','suya','suyas','suyo','suyos','tal','tales','también',
            'tampoco','tan','tanta','tantas','tanto','tantos','tarde','te','tendrá','tendría','tenemos',
            'tener','tenga','tengo','tenía','tenían','tenido','tercera','ti','tiempo','tiene','tienen',
            'toda','todas','todavía','todo','todos','tras','tres','tu','tú','tus','tuve','tuviera','tuvieron',
            'tuvo','tuya','tuyo','u','última','último','un','una','unas','uno','unos','usted','ustedes','va',
            'vais','vamos','van','varias','varios','vaya','veces','ver','vez','via','vía','vino','vio','vos',
            'vosotras','vosotros','vuestra','vuestro','y','ya','yo',
            // Auxiliares narrativos frecuentes sin carga temática
            'hablaba','hablar','miraba','miró','decía','sabían','podían','quería','querían','hacía','tenía',
            'estaba','había','habían','llegó','llegaba','volvió','volvía','parecían','hubiese','hubiesen',
            'fuese','fuesen','hubieran','habrían','podrían','debían','fueran','tuviese','tuviera','estuviese',
            'quisiera','quisiese','alrededor','adelante','además','apenas','aquello','asimismo','cuatro',
            'cinco','ocho','nueve','diez','cien','ciento','mil','vez','cosa','cosas','momento','manera',
            'forma','hecho','caso','lado','embargo','obstante','entretanto','mientras','entonces','después',
            'antes','ahora','luego','pronto','nunca','siempre','todavía','aún','aquí','allí','allá','acá',
            // Inglés básico por si hay títulos/notas mixtas
            'the','and','for','that','with','from','this','have','not','are','was','were','but','you','your',
            'highlight','page','note','bookmark','pagina','página','resaltar','amarillo','azul','rosa','naranja','nota','marcador'
        ];
        self::$stopwords = array_fill_keys($words, true);
        return self::$stopwords;
    }

    public static function isStopword(string $lowerWord): bool
    {
        $sw = self::getStopwords();
        if (isset($sw[$lowerWord])) {
            return true;
        }
        $plain = Utf8Helper::stripAccents($lowerWord);
        return isset($sw[$plain]);
    }

    /**
     * Segmenta texto en oraciones respetando abreviaturas y signos españoles.
     */
    public static function splitSentences(string $text): array
    {
        $text = Utf8Helper::normalizeNfc($text);
        $text = str_replace(["\r\n", "\r"], "\n", $text);

        // Proteger abreviaturas comunes
        $abbrevs = ['Sr.', 'Sra.', 'Srta.', 'Dr.', 'Dra.', 'Dña.', 'Dn.', 'St.', 'Sta.', 'Ud.', 'Uds.', 'pág.', 'págs.', 'cap.', 'núm.', 'etc.', 'p.ej.', 'vs.'];
        $placeholders = [];
        foreach ($abbrevs as $idx => $ab) {
            $ph = "##ABB{$idx}##";
            $placeholders[$ph] = $ab;
            $text = str_ireplace($ab, $ph, $text);
        }
        // Proteger puntos suspensivos
        $text = str_replace('...', '##ELLIPSIS##', $text);

        // Dividir por párrafos primero
        $paragraphs = preg_split('/\n\s*\n+|\n/', $text);
        $sentences = [];

        foreach ($paragraphs as $para) {
            $para = trim(preg_replace('/\s+/', ' ', $para));
            if ($para === '') {
                continue;
            }
            // Dividir después de ., !, ? seguidos de espacio y posible comilla/guión + mayúscula/¿/¡
            $parts = preg_split('/(?<=[\.\!\?\»\”\"])\s+(?=(?:[«“"\'—\-¿¡]*)[\p{Lu}\d¿¡])/u', $para);
            foreach ($parts as $p) {
                $p = str_replace('##ELLIPSIS##', '...', $p);
                $p = strtr($p, $placeholders);
                $p = trim($p);
                if (Utf8Helper::len($p) >= 12) {
                    $sentences[] = $p;
                }
            }
        }
        return $sentences;
    }

    /**
     * Extrae tokens alfabéticos UTF-8 preservando su forma original.
     */
    public static function tokenizeRaw(string $text): array
    {
        preg_match_all('/[\p{L}]+(?:-[\p{L}]+)*/u', $text, $m);
        return $m[0] ?? [];
    }

    /**
     * Extrae tokens filtrados en minúsculas (sin stopwords, len >= 3).
     */
    public static function tokenizeClean(string $text, bool $stem = true): array
    {
        $raw = self::tokenizeRaw($text);
        $out = [];
        foreach ($raw as $tok) {
            $low = Utf8Helper::toLower($tok);
            if (Utf8Helper::len($low) < 3) {
                continue;
            }
            if (self::isStopword($low)) {
                continue;
            }
            $out[] = $stem ? self::stem($low) : $low;
        }
        return $out;
    }

    /**
     * Stemmer ligero para español (inspirado en Snowball Spanish).
     * Reduce plurales y sufijos derivativos/verbales frecuentes para agrupar conceptos.
     */
    public static function stem(string $word): string
    {
        $w = Utf8Helper::stripAccents(Utf8Helper::toLower($word));
        $len = strlen($w);
        if ($len <= 4) {
            return $w;
        }

        // Sufijos nominales y adverbiales largos primero
        static $longSuffixes = [
            'amientos','imientos','amiento','imiento','izaciones','izacion',
            'abilidades','abilidad','aciones','acion','iciones','icion',
            'adoras','adores','adora','ador','ancias','ancia','encias','encia',
            'idades','idad','ismos','ismo','istas','ista','mente','antes','ante',
            'ibles','ible','ables','able','ivos','ivas','ivo','iva',
            'osos','osas','oso','osa','ales','al','ares','ar'
        ];
        foreach ($longSuffixes as $suf) {
            $slen = strlen($suf);
            if ($len - $slen >= 4 && substr($w, -$slen) === $suf) {
                return substr($w, 0, $len - $slen);
            }
        }

        // Sufijos verbales comunes
        static $verbSuffixes = [
            'abamos','ieramos','iaramos','arian','erian','irian','ieron','aban','ian',
            'ando','iendo','aron','eron','aba','ias','ido','ado','ara','era','ira'
        ];
        foreach ($verbSuffixes as $suf) {
            $slen = strlen($suf);
            if ($len - $slen >= 4 && substr($w, -$slen) === $suf) {
                return substr($w, 0, $len - $slen);
            }
        }

        // Plurales simples
        if ($len > 5 && substr($w, -2) === 'es' && !in_array(substr($w, -3, 1), ['a','e','i','o','u'], true)) {
            $w = substr($w, 0, -2);
        } elseif ($len > 4 && substr($w, -1) === 's' && in_array(substr($w, -2, 1), ['a','e','i','o','u'], true)) {
            $w = substr($w, 0, -1);
        }

        return $w;
    }

    public static function countWords(string $text): int
    {
        return count(self::tokenizeRaw($text));
    }
}
