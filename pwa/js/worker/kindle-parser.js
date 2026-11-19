/**
 * Parser estructurado para PDFs de "Bloc de notas" exportados desde Kindle.
 */
(function (root) {
  const BiblioWorker = (root.BiblioWorker = root.BiblioWorker || {});

  class KindleNotesParser {
    constructor(pdfParser) {
      this.pdfParser = pdfParser || new BiblioWorker.PdfParser();
    }

    async parse(pdfBuffer) {
      const { Utf8Helper } = BiblioWorker;
      const pages = await this.pdfParser.extractPages(pdfBuffer);

      const stats = {
        total_declared: 0,
        highlights: 0,
        notes: 0,
        bookmarks: 0,
        pages_pdf: pages.length
      };

      const allLines = [];
      for (const pageData of pages) {
        const pNum = pageData.page;
        for (const line of pageData.lines) {
          const t = (line.text || '').trim();
          if (!t) continue;
          if (line.y < 75 && /^\d{1,4}$/.test(t) && parseInt(t, 10) === pNum) continue;
          allLines.push({
            text: t,
            x: line.x,
            y: line.y,
            size: line.size,
            pdf_page: pNum
          });
        }
      }

      const items = [];
      let currentSection = null;
      let currentItem = null;
      let inUserNote = false;
      let headerDone = false;

      const pushCurrent = () => {
        if (currentItem !== null) {
          const hl = Utf8Helper.cleanWhitespace(currentItem.highlight_text || '');
          const un = Utf8Helper.cleanWhitespace(currentItem.user_note || '');
          currentItem.highlight_text = hl || null;
          currentItem.user_note = un || null;
          items.push(currentItem);
        }
        currentItem = null;
        inUserNote = false;
      };

      const datePattern = /^\d{1,2}\s+(?:ene|feb|mar|abr|may|jun|jul|ago|sep|sept|oct|nov|dic|jan|apr|aug|dec)\.?\s+\d{4}$/i;

      for (const lineObj of allLines) {
        const line = lineObj.text;
        const x = lineObj.x;

        if (!headerDone) {
          const nm = /^Notas?\s*\((\d+)\)/i.exec(line);
          if (nm) {
            stats.total_declared = parseInt(nm[1], 10);
            continue;
          }
          if (/^[•\-\*]\s*(\d+)\s+(?:subrayados|highlights|marcadores|bookmarks|notas|notes)/i.test(line)) {
            continue;
          }
          if (line.toLowerCase() === 'kindle') continue;
        }

        const hm = /^(?:P[aá]gina|Page|Posici[oó]n|Location)\s+(\d+)\s*\|\s*(.+)$/i.exec(line);
        if (hm) {
          headerDone = true;
          pushCurrent();

          const pageNum = parseInt(hm[1], 10);
          const typeRaw = hm[2].trim();
          const typeLow = typeRaw.toLowerCase();

          let noteType = 'highlight';
          if (typeLow.includes('marcador') || typeLow.includes('bookmark')) {
            noteType = 'bookmark';
          } else if (typeLow.includes('nota') || typeLow.includes('note')) {
            noteType = 'note';
          }

          let color = null;
          const cm = /\(([^)]+)\)/.exec(typeRaw);
          if (cm) color = cm[1].trim();

          currentItem = {
            pdf_chapter_label: currentSection,
            page_number: pageNum,
            note_type: noteType,
            highlight_color: color,
            highlight_text: '',
            user_note: '',
            note_date: null
          };
          inUserNote = noteType === 'note';
          continue;
        }

        if (currentItem !== null) {
          const nMatch = /^(?:Nota|Note)\s*:\s*(.*)$/i.exec(line);
          if (nMatch) {
            inUserNote = true;
            const noteContent = (nMatch[1] || '').trim();
            if (noteContent) {
              currentItem.user_note += (currentItem.user_note ? ' ' : '') + noteContent;
            }
            continue;
          }
        }

        if (datePattern.test(line)) {
          if (currentItem !== null && currentItem.note_date === null) {
            currentItem.note_date = line;
          }
          continue;
        }

        const isSectionCandidate = x <= 56 && line.length <= 80 && (currentItem === null || currentItem.note_date !== null);
        if (isSectionCandidate) {
          headerDone = true;
          pushCurrent();
          currentSection = line;
          continue;
        }

        if (currentItem !== null) {
          if (inUserNote) {
            currentItem.user_note += (currentItem.user_note ? ' ' : '') + line;
          } else if (currentItem.note_type === 'highlight') {
            currentItem.highlight_text += (currentItem.highlight_text ? ' ' : '') + line;
          }
        }
      }

      pushCurrent();

      items.forEach((it, idx) => {
        it.sort_order = idx + 1;
        if (it.note_type === 'highlight') {
          stats.highlights++;
          if (it.user_note !== null) stats.notes++;
        } else if (it.note_type === 'bookmark') {
          stats.bookmarks++;
        } else if (it.note_type === 'note') {
          stats.notes++;
        }
      });

      return { stats, items };
    }
  }

  BiblioWorker.KindleNotesParser = KindleNotesParser;
})(self);
