import 'server-only';
import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
export function libraryRelativePath(root: string, file: string): string {
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Путь вне библиотеки.');
  return relative.split(path.sep).join('/');
}
export async function safeLibraryFile(root: string, relative: string) {
  if (path.isAbsolute(relative) || relative.includes('\0') || relative.split(/[\\/]/).some(p => p === '..')) throw new Error('Недопустимый путь.');
  const file = path.resolve(root, relative);
  libraryRelativePath(root, file);
  let current = root;
  for (const segment of path.relative(root, file).split(path.sep)) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Символические ссылки не индексируются.');
  }
  libraryRelativePath(root, await realpath(file));
  return file;
}
export async function discoverPdfs(root: string) {
  const files: string[] = [];
  const errors: { relativePath: string; message: string }[] = [];
  async function walk(directory: string) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { errors.push({ relativePath: path.relative(root, directory) || '.', message: 'Не удалось прочитать каталог; прежние записи сохранены.' }); return; }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        try { await safeLibraryFile(root, path.relative(root, absolute)); await walk(absolute); }
        catch { errors.push({ relativePath: path.relative(root, absolute), message: 'Каталог недоступен или является ссылкой.' }); }
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.pdf') files.push(libraryRelativePath(root, absolute));
    }
  }
  await walk(root);
  return { files: files.sort(), errors };
}
export async function readLibraryPdf(root: string, relative: string): Promise<Buffer> {
  const file = await safeLibraryFile(root, relative);
  if (path.extname(file).toLowerCase() !== '.pdf') throw new Error('Разрешены только PDF.');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Не является обычным файлом.');
    // Revalidate after opening: do not read a file swapped through a symlink.
    await safeLibraryFile(root, relative);
    const current = await lstat(file);
    if (current.ino !== stat.ino || current.dev !== stat.dev) throw new Error('Файл изменился во время открытия.');
    if (stat.size > 128 * 1024 * 1024) throw new Error('PDF больше 128 МБ: метаданные не извлечены.');
    return await handle.readFile();
  } finally { await handle.close(); }
}
