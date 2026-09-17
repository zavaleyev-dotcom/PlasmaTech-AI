import { PDFParse } from 'pdf-parse';
process.on('message', async ({ data }) => {
  let parser;
  let result;
  try {
    parser = new PDFParse({ data: new Uint8Array(data), isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
    const info = await parser.getInfo();
    if (info.total > 5000) throw new Error('LIMIT');
    const pages = []; let characters = 0;
    for (let page = 1; page <= info.total; page++) {
      const extracted = await parser.getText({ partial: [page], pageJoiner: '' });
      const text = extracted.pages[0]?.text ?? '';
      characters += text.length;
      if (characters > 20_000_000) throw new Error('LIMIT');
      pages.push({ page, text });
    }
    result = { pages, pageCount: info.total };
  } catch (error) {
    result = { error: error.message === 'LIMIT' ? 'Превышен лимит: 5000 страниц или 20 млн символов на PDF.' : 'PDF повреждён, зашифрован или недоступен для извлечения текста.', limited: error.message === 'LIMIT' };
  } finally { if (parser) await parser.destroy().catch(() => {}); }
  process.send(result);
});
