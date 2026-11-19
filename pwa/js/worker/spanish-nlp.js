/**
 * Utilidades UTF-8 y procesador NLP clásico para español en Web Worker (sin LLM).
 * Evita lookbehinds en RegExp para máxima compatibilidad con Safari iOS y Android WebView.
 */
(function (root) {
  const BiblioWorker = (root.BiblioWorker = root.BiblioWorker || {});

  const STOPWORDS_LIST = [
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
    'hablaba','hablar','miraba','miró','decía','sabían','podían','quería','querían','hacía','tenía',
    'estaba','había','habían','llegó','llegaba','volvió','volvía','parecían','hubiese','hubiesen',
    'fuese','fuesen','hubieran','habrían','podrían','debían','fueran','tuviese','tuviera','estuviese',
    'quisiera','quisiese','alrededor','adelante','además','apenas','aquello','asimismo','cuatro',
    'cinco','ocho','nueve','diez','cien','ciento','mil','cosa','cosas','momento','manera',
    'forma','hecho','caso','lado','embargo','obstante','entretanto','entonces','ahora','pronto',
    'the','and','for','that','with','from','this','have','not','are','was','were','but','you','your',
    'highlight','page','note','bookmark','pagina','página','resaltar','amarillo','azul','rosa','naranja','nota','marcador'
  ];

  const STOPWORDS = new Set();
  for (const w of STOPWORDS_LIST) {
    STOPWORDS.add(w);
    STOPWORDS.add(w.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
  }

  const COMBINING_PRE_MAP = [
    ['\u0131\u0301', 'í'], ['\u0301\u0131', 'í'],
    ['\u0301a', 'á'], ['\u0301e', 'é'], ['\u0301i', 'í'], ['\u0301o', 'ó'], ['\u0301u', 'ú'],
    ['\u0303n', 'ñ'], ['\u0308u', 'ü']
  ];

  const Utf8Helper = {
    normalizeNfc(text) {
      let s = String(text || '');
      for (const [k, v] of COMBINING_PRE_MAP) {
        if (s.includes(k)) s = s.split(k).join(v);
      }
      s = s.normalize('NFC').replace(/\u0131/g, 'i');
      return s;
    },

    stripAccents(text) {
      return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\u0131/g, 'i');
    },

    ucfirst(text) {
      if (!text) return '';
      return text.charAt(0).toUpperCase() + text.slice(1);
    },

    isUpperStart(word) {
      return /^\p{Lu}/u.test(word || '');
    },

    isAllUpper(word) {
      return /^\p{Lu}+$/u.test(word || '');
    },

    cleanWhitespace(text) {
      return String(text || '')
        .replace(/\u00a0/g, ' ')
        .replace(/[\t\r]/g, ' ')
        .replace(/ {2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    },

    normalizeForMatch(text) {
      return Utf8Helper.stripAccents(Utf8Helper.normalizeNfc(text))
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    },

    codePointToUtf8Str(cp) {
      if (cp < 0 || cp > 0x10ffff) return '';
      try {
        return String.fromCodePoint(cp);
      } catch (_) {
        return '';
      }
    }
  };

  const LONG_SUFFIXES = [
    'amientos','imientos','amiento','imiento','izaciones','izacion',
    'abilidades','abilidad','aciones','acion','iciones','icion',
    'adoras','adores','adora','ador','ancias','ancia','encias','encia',
    'idades','idad','ismos','ismo','istas','ista','mente','antes','ante',
    'ibles','ible','ables','able','ivos','ivas','ivo','iva',
    'osos','osas','oso','osa','ales','al','ares','ar'
  ];
  const VERB_SUFFIXES = [
    'abamos','ieramos','iaramos','arian','erian','irian','ieron','aban','ian',
    'ando','iendo','aron','eron','aba','ias','ido','ado','ara','era','ira'
  ];
  const ABBREVS = ['Sr.', 'Sra.', 'Srta.', 'Dr.', 'Dra.', 'Dña.', 'Dn.', 'St.', 'Sta.', 'Ud.', 'Uds.', 'pág.', 'págs.', 'cap.', 'núm.', 'etc.', 'p.ej.', 'vs.'];

  const SpanishNLP = {
    isStopword(lowerWord) {
      if (STOPWORDS.has(lowerWord)) return true;
      return STOPWORDS.has(Utf8Helper.stripAccents(lowerWord));
    },

    splitSentences(text) {
      let t = Utf8Helper.normalizeNfc(text).replace(/\r\n?/g, '\n');
      const placeholders = [];
      ABBREVS.forEach((ab, idx) => {
        const ph = `##ABB${idx}##`;
        placeholders.push([ph, ab]);
        const esc = ab.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        t = t.replace(new RegExp(esc, 'gi'), ph);
      });
      t = t.replace(/\.\.\./g, '##ELLIPSIS##');

      const paragraphs = t.split(/\n\s*\n+|\n/);
      const sentences = [];

      for (let para of paragraphs) {
        para = para.replace(/\s+/g, ' ').trim();
        if (!para) continue;
        // Sin lookbehind para total compatibilidad Safari iOS
        const marked = para.replace(/([.!?»”"])\s+(?=[«“"'—¿¡-]*[\p{Lu}\d¿¡])/gu, '$1\u0001');
        const parts = marked.split('\u0001');
        for (let p of parts) {
          p = p.replace(/##ELLIPSIS##/g, '...');
          for (const [ph, ab] of placeholders) {
            if (p.includes(ph)) p = p.split(ph).join(ab);
          }
          p = p.trim();
          if (p.length >= 12) sentences.push(p);
        }
      }
      return sentences;
    },

    tokenizeRaw(text) {
      return String(text || '').match(/[\p{L}]+(?:-[\p{L}]+)*/gu) || [];
    },

    tokenizeClean(text, doStem = true) {
      const raw = SpanishNLP.tokenizeRaw(text);
      const out = [];
      for (const tok of raw) {
        const low = tok.toLowerCase();
        if (low.length < 3 || SpanishNLP.isStopword(low)) continue;
        out.push(doStem ? SpanishNLP.stem(low) : low);
      }
      return out;
    },

    stem(word) {
      let w = Utf8Helper.stripAccents(String(word || '').toLowerCase());
      const len = w.length;
      if (len <= 4) return w;

      for (const suf of LONG_SUFFIXES) {
        if (len - suf.length >= 4 && w.endsWith(suf)) {
          return w.slice(0, len - suf.length);
        }
      }
      for (const suf of VERB_SUFFIXES) {
        if (len - suf.length >= 4 && w.endsWith(suf)) {
          return w.slice(0, len - suf.length);
        }
      }
      if (len > 5 && w.endsWith('es') && !'aeiou'.includes(w[len - 3])) {
        w = w.slice(0, -2);
      } else if (len > 4 && w.endsWith('s') && 'aeiou'.includes(w[len - 2])) {
        w = w.slice(0, -1);
      }
      return w;
    },

    countWords(text) {
      return SpanishNLP.tokenizeRaw(text).length;
    }
  };

  BiblioWorker.Utf8Helper = Utf8Helper;
  BiblioWorker.SpanishNLP = SpanishNLP;
})(self);
