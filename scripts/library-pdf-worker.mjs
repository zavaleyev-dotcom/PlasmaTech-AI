// Local PDF bytes only. No URLs, network enrichment, or writes to source documents.
import { PDFParse } from 'pdf-parse';
const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
const doiFrom = value => {
  const matches = clean(value).match(/10\.\d{4,9}\/[^\s<>"]+/gi) || [];
  const values = [...new Set(matches.map(v => v.replace(/[.,;:]+$/, '').replace(/\)+$/, m => m.length > (v.match(/\(/g) || []).length ? '' : m).toLowerCase()))];
  return values.length === 1 ? values[0] : null;
};
process.on('message', async ({ data }) => {
  let parser;
  try {
    parser = new PDFParse({ data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
    const info = await parser.getInfo();
    const text = await parser.getText({ partial: [1, 2].filter(n => n <= info.total) });
    const rawTitle = clean(info.info?.Title);
    const title = rawTitle && !/^(untitled|unknown|document|microsoft\b|scan\b)|\.(docx?|pptx?|pdf)$/i.test(rawTitle) ? rawTitle.slice(0, 2000) : null;
    const author = clean(info.info?.Author);
    const authors = author && !/^(unknown|anonymous|admin|user|administrator|owner)$/i.test(author) ? author.split(';').map(clean).filter(Boolean) : [];
    const metadata = info.metadata?.getAll?.() || {};
    const date = clean(metadata['prism:publicationdate'] || info.info?.Custom?.PublicationDate);
    const yearMatch = /^(18\d{2}|19\d{2}|20\d{2})(?:\D|$)/.exec(date);
    const year = yearMatch && Number(yearMatch[1]) <= new Date().getFullYear() + 1 ? Number(yearMatch[1]) : null;
    const doi = doiFrom(JSON.stringify({ info: info.info, metadata })) || doiFrom(text.pages[0]?.text?.split(/\bReferences\b|Литература/i)[0] || '') || doiFrom(text.text.split(/\bReferences\b|Литература/i)[0]);
    process.send({ title, authors, year, doi });
  } catch { process.send({ error: 'Не удалось прочитать PDF: повреждён, зашифрован или имеет неподдерживаемый формат.' }); }
  finally { if (parser) await parser.destroy().catch(() => {}); }
});
