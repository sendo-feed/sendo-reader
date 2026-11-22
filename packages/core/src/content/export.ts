import type { ContentElement, ContentNode } from "../models";
import { toSafeHttpUrl } from "../url";
import { isContentTag } from "./parse";
import { xPostUrl } from "./x-post";

/**
 * 記事の本文（core が作った木）を、1 つのファイル（HTML か Markdown）に書き出す。
 *
 * 入力は parse.ts で通したタグと属性だけの木で、記事の HTML の文字列は使わない。書き出した
 * ファイルは、画面には出さず、利用者がダウンロードして開く。それでも本文は信頼できないので、
 * HTML では文字と属性の値をエスケープし、通すと決めたタグだけを書く。リンクは http ／ https
 * のものだけを、もう一度確かめて書く。
 *
 * 画像は、ファイルだけで（ログインなしで）出せるよう、data: URI にして埋め込む。画像の URL は
 * 木にあるもの（sendo の中継）を受け取ったまま取りにいき、組み立てない・書き換えない
 * （docs/decisions/images.md の 1）。取れなかった画像は、代替テキストがあれば文字で残す。
 *
 * X の投稿（印の付いた引用）は、引用の文字のあとに、投稿へのリンク（ID から組み立てた URL）を
 * 書く。ウィジェットは埋め込まない（docs/decisions/embeds.md）。
 */

export type ExportFormat = "html" | "markdown";

/** 書き出すファイルの先頭に入れる、記事の情報 */
export interface ExportArticle {
  title: string | null;
  url: string | null;
  feedTitle: string | null;
  author: string | null;
  publishedAt: number;
}

export interface ExportedFile {
  name: string;
  type: string;
  text: string;
}

/** 画像の URL を、埋め込む data: URI にする。埋め込めなければ null */
export type ImageLoader = (src: string) => Promise<string | null>;

/** 埋め込む画像の形式。ほかの応答（HTML のエラーなど）は埋め込まない */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** 画像を同時に取る数 */
const IMAGE_CONCURRENCY = 4;

/** ファイル名の長さの上限（文字） */
const MAX_NAME_LENGTH = 100;

/** 記事を 1 つのファイルに書き出す */
export async function exportArticle(
  article: ExportArticle,
  nodes: readonly ContentNode[],
  format: ExportFormat,
  loadImage: ImageLoader,
): Promise<ExportedFile> {
  const images = await loadImages(nodes, loadImage);
  const base = fileBaseName(article.title);
  return format === "html"
    ? {
        name: `${base}.html`,
        type: "text/html;charset=utf-8",
        text: toHtml(article, nodes, images),
      }
    : {
        name: `${base}.md`,
        type: "text/markdown;charset=utf-8",
        text: toMarkdown(article, nodes, images),
      };
}

/**
 * 同じオリジンの画像を取り、data: URI にする。200 で、決めた画像の形式のときだけ。
 * 失敗（オフラインでキャッシュにない、など）は null
 */
export async function fetchImageAsDataUrl(
  src: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetcher(src, { credentials: "same-origin" });
    if (response.status !== 200) return null;
    const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (type === undefined || !IMAGE_TYPES.has(type)) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return `data:${type};base64,${toBase64(bytes)}`;
  } catch {
    return null;
  }
}

/** 記事のタイトルから、ファイル名（拡張子なし）を作る */
export function fileBaseName(title: string | null): string {
  const cleaned = (title ?? "")
    // パスに使えない文字と制御文字
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を取り除くため
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    // 先頭・末尾の点は、隠しファイルや拡張子と取り違えられる
    .replace(/^\.+|\.+$/g, "")
    .trim();
  const name = Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join("").trim();
  return name === "" ? "article" : name;
}

/** 木の中の画像を取る（同じ URL は 1 度だけ） */
async function loadImages(
  nodes: readonly ContentNode[],
  loadImage: ImageLoader,
): Promise<Map<string, string | null>> {
  const sources = new Set<string>();
  const collect = (children: readonly ContentNode[]) => {
    for (const node of children) {
      if (typeof node === "string") continue;
      if (node.tag === "img" && node.src !== undefined) sources.add(node.src);
      collect(node.children);
    }
  };
  collect(nodes);
  const queue = [...sources];
  const images = new Map<string, string | null>();
  const work = async () => {
    for (let src = queue.shift(); src !== undefined; src = queue.shift()) {
      const data = await loadImage(src).catch(() => null);
      // 自分で作った data: URI でも、形を確かめてから埋め込む
      images.set(src, data !== null && isImageDataUrl(data) ? data : null);
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, queue.length) }, work));
  return images;
}

function isImageDataUrl(value: string): boolean {
  const match = /^data:([a-z/+-]+);base64,[A-Za-z0-9+/]*={0,2}$/.exec(value);
  return match !== null && IMAGE_TYPES.has(match[1] ?? "");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 読める日時（手元の時刻。YYYY-MM-DD HH:mm） */
function formatLocal(time: number): string {
  const date = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function imageFallback(element: ContentElement): string {
  const alt = (element.alt ?? "").trim();
  return alt === "" ? "" : `[画像: ${alt}]`;
}

// ---- HTML ----

const HTML_STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; padding: 2rem 1rem; font: 1.0625rem/1.9 system-ui, sans-serif; color: #1f2328; background: #fff; }
article { max-width: 42rem; margin: 0 auto; overflow-wrap: anywhere; }
h1 { font-size: 1.5rem; line-height: 1.4; }
h1 a { color: inherit; }
.meta { margin: 0; color: #59636e; font-size: 0.875rem; }
img { max-width: 100%; height: auto; }
pre { overflow-x: auto; padding: 0.75rem; background: #f6f8fa; line-height: 1.5; }
code, kbd { font-family: ui-monospace, monospace; font-size: 0.9em; }
blockquote { margin-inline: 0; padding-left: 1rem; border-left: 3px solid #d1d9e0; color: #59636e; }
table { border-collapse: collapse; display: block; overflow-x: auto; }
th, td { border: 1px solid #d1d9e0; padding: 0.25rem 0.5rem; }
@media (prefers-color-scheme: dark) {
  body { color: #f0f6fc; background: #0d1117; }
  .meta, blockquote { color: #9198a1; }
  pre { background: #151b23; }
  blockquote, th, td { border-color: #3d444d; }
}
`.trim();

/** 開いたときに、スクリプトも外への通信も動かさない */
const HTML_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toHtml(
  article: ExportArticle,
  nodes: readonly ContentNode[],
  images: ReadonlyMap<string, string | null>,
): string {
  const title = article.title ?? "(Untitled)";
  const link = toSafeHttpUrl(article.url);
  const heading =
    link === null
      ? escapeHtml(title)
      : `<a href="${escapeHtml(link)}" rel="noopener noreferrer nofollow">${escapeHtml(title)}</a>`;
  const meta = [
    `<time datetime="${new Date(article.publishedAt).toISOString()}">${formatLocal(article.publishedAt)}</time>`,
    ...(article.author === null ? [] : [escapeHtml(article.author)]),
  ].join(" ・ ");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${HTML_CSP}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${HTML_STYLE}
</style>
</head>
<body>
<article>
<header>
${article.feedTitle === null ? "" : `<p class="meta">${escapeHtml(article.feedTitle)}</p>\n`}<h1>${heading}</h1>
<p class="meta">${meta}</p>
</header>
${htmlNodes(nodes, images)}
</article>
</body>
</html>
`;
}

function htmlNodes(
  nodes: readonly ContentNode[],
  images: ReadonlyMap<string, string | null>,
): string {
  // 深さは parse.ts の MAX_CONTENT_DEPTH までなので、再帰で足りる
  return nodes
    .map((node) => {
      if (typeof node === "string") return escapeHtml(node);
      const children = () => htmlNodes(node.children, images);
      if (!isContentTag(node.tag)) return children();
      switch (node.tag) {
        case "br":
        case "hr":
          return `<${node.tag}>`;
        case "img": {
          const data = node.src === undefined ? null : (images.get(node.src) ?? null);
          if (data === null) return escapeHtml(imageFallback(node));
          const size =
            node.width !== undefined && node.height !== undefined
              ? ` width="${node.width}" height="${node.height}"`
              : "";
          return `<img src="${escapeHtml(data)}" alt="${escapeHtml(node.alt ?? "")}"${size}>`;
        }
        case "a": {
          const href = toSafeHttpUrl(node.href);
          if (href === null) return children();
          return `<a href="${escapeHtml(href)}" rel="noopener noreferrer nofollow">${children()}</a>`;
        }
        case "td":
        case "th": {
          const span =
            (node.colspan === undefined ? "" : ` colspan="${node.colspan}"`) +
            (node.rowspan === undefined ? "" : ` rowspan="${node.rowspan}"`);
          return `<${node.tag}${span}>${children()}</${node.tag}>`;
        }
        case "ol":
          return `<ol${node.start === undefined ? "" : ` start="${node.start}"`}>${children()}</ol>`;
        case "blockquote": {
          const quote = `<blockquote>${children()}</blockquote>`;
          const url = node.xPost === undefined ? null : xPostUrl(node.xPost);
          if (url === null) return quote;
          const link = escapeHtml(url);
          return `${quote}<p><a href="${link}" rel="noopener noreferrer nofollow">${link}</a></p>`;
        }
        default:
          return `<${node.tag}>${children()}</${node.tag}>`;
      }
    })
    .join("");
}

// ---- Markdown ----

/** 段落など、前後に空行を置く要素 */
const BLOCK_TAGS = new Set([
  ...["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "ul", "ol", "li", "dl", "dt", "dd"],
  ...["blockquote", "pre", "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td"],
  ...["figure", "figcaption"],
]);

/**
 * 文字の中で、書式として読まれる記号。! は、続くリンクと合わさって画像（![…](…)）に
 * ならないよう、どこでもエスケープする
 */
const MARKDOWN_SPECIAL = /[\\`*_[\]<>~|&!]/g;

function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_SPECIAL, "\\$&");
}

/** YAML の値。JSON の文字列は、YAML の二重引用符の文字列としても読める */
function yamlValue(value: string): string {
  return JSON.stringify(value);
}

function toMarkdown(
  article: ExportArticle,
  nodes: readonly ContentNode[],
  images: ReadonlyMap<string, string | null>,
): string {
  const link = toSafeHttpUrl(article.url);
  const front = [
    "---",
    `title: ${yamlValue(article.title ?? "")}`,
    ...(link === null ? [] : [`url: ${yamlValue(link)}`]),
    ...(article.feedTitle === null ? [] : [`feed: ${yamlValue(article.feedTitle)}`]),
    ...(article.author === null ? [] : [`author: ${yamlValue(article.author)}`]),
    `published: ${yamlValue(new Date(article.publishedAt).toISOString())}`,
    "---",
  ].join("\n");
  const title = escapeHeading(escapeMarkdown(flat(article.title ?? "(Untitled)")));
  const heading = link === null ? `# ${title}` : `# [${title}](${markdownUrl(link)})`;
  const meta = [
    ...(article.feedTitle === null ? [] : [escapeMarkdown(flat(article.feedTitle))]),
    formatLocal(article.publishedAt),
    ...(article.author === null ? [] : [escapeMarkdown(flat(article.author))]),
  ].join(" ・ ");
  const body = markdownBlocks(nodes, images);
  return `${[front, heading, escapeLineStarts(meta), ...body].join("\n\n")}\n`;
}

/** 子を、空行で分けるかたまり（段落、見出し、リストなど）の並びにする */
function markdownBlocks(
  nodes: readonly ContentNode[],
  images: ReadonlyMap<string, string | null>,
): string[] {
  const blocks: string[] = [];
  let run: ContentNode[] = [];
  const flush = () => {
    const paragraph = finishParagraph(markdownInline(run, images));
    if (paragraph !== "") blocks.push(paragraph);
    run = [];
  };
  for (const node of nodes) {
    if (typeof node === "string" || !BLOCK_TAGS.has(node.tag)) {
      run.push(node);
      continue;
    }
    flush();
    blocks.push(...markdownBlock(node, images));
  }
  flush();
  return blocks;
}

function markdownBlock(
  element: ContentElement,
  images: ReadonlyMap<string, string | null>,
): string[] {
  switch (element.tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const text = oneLine(markdownInline(element.children, images));
      if (text === "") return [];
      return [`${"#".repeat(Number(element.tag[1]))} ${escapeHeading(text)}`];
    }
    case "hr":
      return ["---"];
    case "blockquote": {
      const inner = markdownBlocks(element.children, images).join("\n\n");
      const quote =
        inner === ""
          ? []
          : [
              inner
                .split("\n")
                .map((line) => (line === "" ? ">" : `> ${line}`))
                .join("\n"),
            ];
      const link = markdownXPostLink(element);
      return link === null ? quote : [...quote, link];
    }
    case "pre": {
      const text = plainText(element.children).replace(/^\n|\n$/g, "");
      const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
      const fence = "`".repeat(Math.max(3, longest + 1));
      return [`${fence}\n${text}\n${fence}`];
    }
    case "ul":
    case "ol":
      return markdownList(element, images);
    case "dt": {
      const text = oneLine(markdownInline(element.children, images));
      return text === "" ? [] : [`**${text}**`];
    }
    case "table":
      return markdownTable(element, images);
    default:
      // div、p、li（リストの外）、dd、figure、figcaption、表の外の行やセルなど
      return markdownBlocks(element.children, images);
  }
}

function markdownList(list: ContentElement, images: ReadonlyMap<string, string | null>): string[] {
  const items: ContentNode[][] = [];
  for (const node of list.children) {
    if (typeof node !== "string" && node.tag === "li") items.push(node.children);
    else if (typeof node !== "string" || node.trim() !== "") {
      // li の外のものは、ひとつ前の項目に入れる（なければ、項目にする）
      const last = items.at(-1);
      if (last === undefined) items.push([node]);
      else last.push(node);
    }
  }
  if (items.length === 0) return [];
  const start = list.start ?? 1;
  const lines = items.map((children, index) => {
    const marker = list.tag === "ol" ? `${start + index}.` : "-";
    const indent = " ".repeat(marker.length + 1);
    const content = markdownBlocks(children, images).join("\n\n");
    if (content === "") return marker;
    return content
      .split("\n")
      .map((line, i) => (i === 0 ? `${marker} ${line}` : line === "" ? "" : `${indent}${line}`))
      .join("\n");
  });
  return [lines.join("\n")];
}

function markdownTable(
  table: ContentElement,
  images: ReadonlyMap<string, string | null>,
): string[] {
  const blocks: string[] = [];
  const rows: string[][] = [];
  /** 列ごとに、上の行の rowspan があと何行ふさぐか。ふさがれた位置は空のセルにする */
  const spanned: number[] = [];
  const visit = (nodes: readonly ContentNode[]) => {
    for (const node of nodes) {
      if (typeof node === "string") continue;
      if (node.tag === "caption") blocks.push(...markdownBlocks(node.children, images));
      else if (node.tag === "tr") {
        const cells: string[] = [];
        const skipSpanned = () => {
          for (let left = spanned[cells.length] ?? 0; left > 0; left = spanned[cells.length] ?? 0) {
            spanned[cells.length] = left - 1;
            cells.push("");
          }
        };
        for (const cell of node.children) {
          if (typeof cell === "string" || (cell.tag !== "td" && cell.tag !== "th")) continue;
          skipSpanned();
          const text = escapeCellPipes(oneLine(markdownInline(cell.children, images)));
          for (let i = 0; i < (cell.colspan ?? 1); i++) {
            if ((cell.rowspan ?? 1) > 1) spanned[cells.length] = (cell.rowspan ?? 1) - 1;
            cells.push(i === 0 ? text : "");
          }
        }
        // 行の終わりより右の、ふさがれた列
        for (let column = cells.length; column < spanned.length; column++) {
          const left = spanned[column] ?? 0;
          if (left > 0) spanned[column] = left - 1;
        }
        rows.push(cells);
      } else if (node.tag === "thead" || node.tag === "tbody" || node.tag === "tfoot") {
        visit(node.children);
      }
    }
  };
  visit(table.children);
  const columns = Math.max(0, ...rows.map((row) => row.length));
  if (columns === 0) return blocks;
  const line = (cells: readonly string[]) =>
    `| ${Array.from({ length: columns }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  const [header = [], ...body] = rows;
  blocks.push(
    [line(header), line(Array.from({ length: columns }, () => "---")), ...body.map(line)].join(
      "\n",
    ),
  );
  return blocks;
}

/**
 * 段落の中の文字にする。改行（br）は "\n" で返し、段落にするときに、改行の印に替える。
 * 段落の中に入ったかたまり（a の中の p など）は、空白で区切って並べる
 */
function markdownInline(
  nodes: readonly ContentNode[],
  images: ReadonlyMap<string, string | null>,
): string {
  return nodes
    .map((node) => {
      if (typeof node === "string") return escapeMarkdown(node.replace(/[ \t\n\r\f]+/g, " "));
      const inner = () => markdownInline(node.children, images);
      switch (node.tag) {
        case "br":
          return "\n";
        case "img": {
          const data = node.src === undefined ? null : (images.get(node.src) ?? null);
          if (data === null) return escapeMarkdown(imageFallback(node));
          return `![${oneLine(escapeMarkdown(node.alt ?? ""))}](${data})`;
        }
        case "a": {
          const href = toSafeHttpUrl(node.href);
          const text = inner();
          if (href === null) return text;
          const label = text.trim() === "" ? escapeMarkdown(href) : text;
          return `[${label}](${markdownUrl(href)})`;
        }
        case "strong":
        case "b":
          return wrap(inner(), "**");
        case "em":
        case "i":
        case "cite":
          return wrap(inner(), "*");
        case "s":
        case "del":
          return wrap(inner(), "~~");
        case "code":
        case "kbd":
          return inlineCode(plainText(node.children));
        case "q":
          return `“${inner()}”`;
        case "blockquote": {
          // 表のセルの中などで、段落の中に入った引用
          const link = markdownXPostLink(node);
          return link === null ? ` ${inner()} ` : ` ${inner()} ${link} `;
        }
        default:
          return BLOCK_TAGS.has(node.tag) ? ` ${inner()} ` : inner();
      }
    })
    .join("");
}

/** X の投稿へのリンク（Markdown）。X の投稿でなければ null */
function markdownXPostLink(element: ContentElement): string | null {
  const url = element.xPost === undefined ? null : xPostUrl(element.xPost);
  return url === null ? null : `[${escapeMarkdown(url)}](${markdownUrl(url)})`;
}

/** 強調などの記号で囲む。前後の空白は、記号の外に出す（中に残すと、書式として読まれない） */
function wrap(text: string, mark: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const [, before = "", core = "", after = ""] = match ?? [];
  return core === "" ? text : `${before}${mark}${core}${mark}${after}`;
}

function inlineCode(text: string): string {
  const flat = text.replace(/\s+/g, " ");
  if (flat.trim() === "") return "";
  const longest = Math.max(0, ...Array.from(flat.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

/** 木の文字だけ（コードの中身）。改行（br）は改行にする */
function plainText(nodes: readonly ContentNode[]): string {
  return nodes
    .map((node) => {
      if (typeof node === "string") return node;
      if (node.tag === "br") return "\n";
      return plainText(node.children);
    })
    .join("");
}

/** 段落にする。行の前後の空白を除き、空の行を落とし、改行は「\」＋改行（GFM の改行）にする */
function finishParagraph(text: string): string {
  return text
    .split("\n")
    .map((line) => escapeLineStarts(line.trim()))
    .filter((line) => line !== "")
    .join("\\\n");
}

/** 空白をまとめて 1 行にする（記事の情報） */
function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 1 行にする（見出し、表のセル、リンクの画像の代替テキスト） */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

/** 行の頭で、見出し・引用・リスト・区切り線として読まれる文字をエスケープする */
function escapeLineStarts(line: string): string {
  return line.replace(/^([#>+=-])/, "\\$1").replace(/^(\d+)([.)])/, "$1\\$2");
}

/**
 * 表のセルの | をエスケープする。GFM は、コードや URL の中の | も列の区切りに読む（セルを
 * 分けてから、\| を | に戻す）。文字の中の | は、もう \| になっている（前の \ が奇数）
 */
function escapeCellPipes(cell: string): string {
  return cell.replace(/(\\*)\|/g, (match, slashes: string) =>
    slashes.length % 2 === 0 ? `${slashes}\\|` : match,
  );
}

/** 見出しの終わりの # は、閉じの印として落とされる */
function escapeHeading(text: string): string {
  return text.replace(/#$/, "\\#");
}

/** リンクの URL。括弧と空白などは、URL として読み違えないよう符号にする */
function markdownUrl(url: string): string {
  return url.replace(
    /[()<>\s]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}
