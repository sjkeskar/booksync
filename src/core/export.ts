import { childrenOf, RECOVERED_ID, ROOT_BAR, ROOT_MOBILE, ROOT_OTHER, type Tree } from './model';
import { isRiskyUrl } from './urlNorm';

export interface ExportOptions {
  /** Export only this folder (a sync id); default: everything. */
  folderId?: string;
  /** Leave out javascript:/data: bookmarks (recommended when sharing). */
  skipScripts?: boolean;
  /** Exclude the Recovered folder. */
  skipRecovered?: boolean;
}

const ROOT_TITLES: Record<string, string> = {
  [ROOT_BAR]: 'Bookmarks bar',
  [ROOT_OTHER]: 'Other bookmarks',
  [ROOT_MOBILE]: 'Mobile bookmarks',
};

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const secs = (ms: number) => Math.floor((ms || 0) / 1000);

/** Netscape Bookmark File format — imported by Chrome, Edge, Brave, Firefox and Safari. */
export function toNetscapeHtml(tree: Tree, opts: ExportOptions = {}): string {
  const out: string[] = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];
  const ind = (d: number) => '    '.repeat(d);
  const folderBody = (id: string, depth: number) => {
    for (const c of childrenOf(tree, id)) {
      if (opts.skipRecovered && c === RECOVERED_ID) continue;
      const n = tree.nodes.get(c)!;
      if (n.kind === 'folder') {
        out.push(`${ind(depth)}<DT><H3 ADD_DATE="${secs(n.added)}" LAST_MODIFIED="0">${escapeHtml(n.title)}</H3>`);
        out.push(`${ind(depth)}<DL><p>`);
        folderBody(c, depth + 1);
        out.push(`${ind(depth)}</DL><p>`);
      } else {
        if (opts.skipScripts && isRiskyUrl(n.url)) continue;
        out.push(`${ind(depth)}<DT><A HREF="${escapeHtml(n.url ?? '')}" ADD_DATE="${secs(n.added)}">${escapeHtml(n.title)}</A>`);
      }
    }
  };
  if (opts.folderId) {
    const f = tree.nodes.get(opts.folderId);
    if (!f || f.kind !== 'folder') throw new Error('Folder not found');
    out.push(`${ind(1)}<DT><H3 ADD_DATE="${secs(f.added)}" LAST_MODIFIED="0">${escapeHtml(f.title)}</H3>`);
    out.push(`${ind(1)}<DL><p>`);
    folderBody(f.id, 2);
    out.push(`${ind(1)}</DL><p>`);
  } else {
    for (const r of [ROOT_BAR, ROOT_OTHER, ROOT_MOBILE]) {
      if (!tree.children.has(r)) continue;
      if (r === ROOT_MOBILE && !childrenOf(tree, r).length) continue;
      const bar = r === ROOT_BAR ? ' PERSONAL_TOOLBAR_FOLDER="true"' : '';
      out.push(`${ind(1)}<DT><H3 ADD_DATE="0" LAST_MODIFIED="0"${bar}>${ROOT_TITLES[r]}</H3>`);
      out.push(`${ind(1)}<DL><p>`);
      folderBody(r, 2);
      out.push(`${ind(1)}</DL><p>`);
    }
  }
  out.push('</DL><p>', '');
  return out.join('\n');
}

export interface JsonExportNode {
  type: 'folder' | 'bookmark';
  title: string;
  url?: string;
  added: number;
  children?: JsonExportNode[];
}

export function toJsonExport(tree: Tree, opts: ExportOptions = {}) {
  const conv = (id: string): JsonExportNode[] =>
    childrenOf(tree, id).flatMap((c): JsonExportNode[] => {
      if (opts.skipRecovered && c === RECOVERED_ID) return [];
      const n = tree.nodes.get(c)!;
      if (n.kind === 'folder') return [{ type: 'folder' as const, title: n.title, added: n.added, children: conv(c) }];
      if (opts.skipScripts && isRiskyUrl(n.url)) return [];
      return [{ type: 'bookmark' as const, title: n.title, url: n.url ?? '', added: n.added }];
    });
  const roots: Record<string, JsonExportNode[]> = {};
  if (opts.folderId) roots.folder = conv(opts.folderId);
  else for (const r of [ROOT_BAR, ROOT_OTHER, ROOT_MOBILE]) if (tree.children.has(r)) roots[r] = conv(r);
  return { format: 'bookmark-sync-export', version: 1, exportedAt: new Date().toISOString(), roots };
}
