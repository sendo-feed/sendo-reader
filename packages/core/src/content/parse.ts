import type { ContentElement, ContentNode } from "../models";
import { toSafeHttpUrl, toSameOriginUrl } from "../url";

/**
 * 記事の本文の HTML を、通すと決めたタグと属性だけの木にする。
 *
 * 本文は sendo がサニタイズしてあるが、外から来たデータなので、reader の側でも信頼しない
 * （sendo の docs/decisions/content.md の 6）。HTML の文字列は、どこにも差し込まない。ここで
 * 読んで木にし、画面は、木から要素を 1 つずつ組み立てる。画面に出るのは、ここで通したタグ・
 * 属性・文字だけなので、読み方を誤っても、崩れるのは見た目だけで、スクリプトは動かない。
 *
 * - 通すタグと属性は、sendo が配るものと同じ。知らないタグは、タグを落として中身だけ残す
 * - script ／ style ／ 埋め込みなどは、中身ごと落とす
 * - リンクは http ／ https の絶対の URL だけ（toSafeHttpUrl。記事の URL と同じ決まり。sendo は
 *   mailto も通すが、reader の決定（docs/decisions/ui.md）は http ／ https だけなので、通さない）。画像は同じオリジンを指す URL だけ
 *   （sendo の中継。受け取ったまま使う）。そうでないリンクは中身だけ残し、画像は落とす
 * - ブラウザの HTML の読み方（閉じ忘れの補い方など）は真似ない。sendo は、開いたタグを必ず
 *   閉じた HTML を返す
 */

/** 中身を持たない要素 */
const VOID_TAGS = new Set(["br", "hr", "img"]);

/** 通す要素 */
const ALLOWED_TAGS = new Set([
  ...["p", "div", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6"],
  ...["ul", "ol", "li", "dl", "dt", "dd", "blockquote", "q", "cite", "pre", "code", "kbd"],
  ...["table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td", "figure", "figcaption"],
  ...["strong", "b", "em", "i", "u", "s", "del", "ins", "sub", "sup", "small", "mark", "abbr"],
  ...["a", "img"],
]);

/** 中身が文字として読まれる要素。閉じタグまでを、タグとして読まずに飛ばす */
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title", "xmp", "noscript"]);

/** 中身ごと落とす要素（RAW_TEXT_TAGS のほかに） */
const DROPPED_TAGS = new Set([
  ...["iframe", "object", "embed", "video", "audio", "canvas", "svg", "math", "head"],
  ...["select", "button", "template", "form", "frameset", "noembed", "noframes"],
]);

/** 落とす要素のうち、中身を持たないもの（閉じタグを待たない） */
const DROPPED_VOID_TAGS = new Set(["embed"]);

/** 入れ子の深さの上限（sendo と同じ）。これより深く開くタグは落とす（中身は残る） */
export const MAX_CONTENT_DEPTH = 100;

/** 要素の数の上限。超えた分のタグは落とす（中身は残る） */
export const MAX_CONTENT_ELEMENTS = 20_000;

/** 表のセルがまたぐ数の上限（ブラウザの上限と同じ） */
const MAX_SPAN = 1000;

const DIGITS = /^\d{1,5}$/;
const TAG_NAME = /^[a-zA-Z][a-zA-Z0-9-]*/;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const CHARACTER_REFERENCE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/g;
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function isXPostAddress(url: URL, allowAnonymous = false): boolean {
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname) &&
    (/^\/[A-Za-z0-9_]{1,15}\/status\/[0-9]{1,20}\/?$/.test(url.pathname) ||
      (allowAnonymous && /^\/i\/web\/status\/[0-9]{1,20}\/?$/.test(url.pathname)))
  );
}

function xPostUrl(href: string): string | undefined {
  const url = new URL(href);
  if (url.protocol !== "https:" || !isXPostAddress(url)) return undefined;
  return `https://x.com${url.pathname.replace(/\/$/, "")}`;
}

const ATTRIBUTION_INLINE_TAGS = new Set([
  "q",
  "cite",
  "code",
  "kbd",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "del",
  "ins",
  "sub",
  "sup",
  "small",
  "mark",
  "abbr",
]);

function attributionText(node: ContentNode): string | null {
  if (typeof node === "string") return node;
  if (node.tag === "br") return " ";
  if (!ATTRIBUTION_INLINE_TAGS.has(node.tag)) return null;
  const parts: string[] = [];
  for (const child of node.children) {
    const part = attributionText(child);
    if (part === null) return null;
    parts.push(part);
  }
  return parts.join("");
}

/** 本文の HTML を木にする */
export function parseContent(html: string): ContentNode[] {
  const root: ContentNode[] = [];
  const postQuotes = new Set<ContentElement>();
  const postLinks: ContentElement[] = [];
  /** 開いている要素（外から内へ） */
  const open: ContentElement[] = [];
  /** 中身ごと落としている要素と、その入れ子の数 */
  let dropping: { name: string; depth: number } | null = null;
  let elements = 0;

  const append = (node: ContentNode) => {
    const children = open.at(-1)?.children ?? root;
    const last = children.at(-1);
    // 続く文字は 1 つにまとめる
    if (typeof node === "string" && typeof last === "string") children[children.length - 1] += node;
    else children.push(node);
  };
  const text = (raw: string) => {
    if (raw !== "" && dropping === null) append(decodeText(raw));
  };
  const closeUntil = (tag: string) => {
    const index = open.findLastIndex((element) => element.tag === tag);
    if (index !== -1) open.length = index;
  };

  let position = 0;
  while (position < html.length) {
    const start = html.indexOf("<", position);
    if (start === -1) {
      text(html.slice(position));
      break;
    }
    text(html.slice(position, start));

    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      position = end === -1 ? html.length : end + 3;
      continue;
    }
    const closing = html[start + 1] === "/";
    const nameAt = start + (closing ? 2 : 1);
    const name = TAG_NAME.exec(html.slice(nameAt, nameAt + 32))?.[0].toLowerCase();
    if (name === undefined) {
      // <!doctype> などの宣言は飛ばす。タグでない < は、文字として出す
      const end = /^<[!?]/.test(html.slice(start, start + 2)) ? html.indexOf(">", start) : -2;
      if (end === -2) text("<");
      position = end === -2 ? start + 1 : end === -1 ? html.length : end + 1;
      continue;
    }
    const end = findTagEnd(html, nameAt + name.length);
    // 閉じていないタグ。残りは読まない
    if (end === -1) break;
    const attributes = html.slice(nameAt + name.length, end);
    position = end + 1;

    if (dropping !== null) {
      if (name === dropping.name) {
        dropping.depth += closing ? -1 : 1;
        if (dropping.depth === 0) dropping = null;
      }
      continue;
    }

    if (closing) {
      if (ALLOWED_TAGS.has(name) && !VOID_TAGS.has(name)) closeUntil(name);
      continue;
    }

    if (RAW_TEXT_TAGS.has(name)) {
      // 中身の < はタグではないので、閉じタグを文字で探す
      const pattern = new RegExp(`</${name}[\\s/>]`, "gi");
      pattern.lastIndex = position;
      const close = pattern.exec(html);
      if (close === null) break;
      const closeEnd = html.indexOf(">", close.index);
      position = closeEnd === -1 ? html.length : closeEnd + 1;
      continue;
    }
    if (DROPPED_TAGS.has(name)) {
      if (!DROPPED_VOID_TAGS.has(name) && !attributes.trimEnd().endsWith("/")) {
        dropping = { name, depth: 1 };
      }
      continue;
    }
    if (!ALLOWED_TAGS.has(name) || elements >= MAX_CONTENT_ELEMENTS) continue;

    const read = readAttributes(attributes);
    if (name === "img") {
      const src = toSameOriginUrl(read.get("src"));
      if (src === null) continue;
      const image: ContentElement = { tag: "img", children: [], src, alt: read.get("alt") ?? "" };
      const width = toCount(read.get("width"));
      const height = toCount(read.get("height"));
      // 場所を取るには、両方が要る
      if (width !== null && height !== null && width > 0 && height > 0) {
        image.width = width;
        image.height = height;
      }
      elements += 1;
      append(image);
      continue;
    }
    if (VOID_TAGS.has(name)) {
      elements += 1;
      append({ tag: name, children: [] });
      continue;
    }
    if (open.length >= MAX_CONTENT_DEPTH) continue;

    const element: ContentElement = { tag: name, children: [] };
    if (name === "a") {
      // リンクの中のリンクは作らない
      closeUntil("a");
      const href = toSafeHttpUrl(read.get("href")?.trim());
      // 行き先のないリンクは、タグを落として中身だけ残す
      if (href === null) continue;
      element.href = href;
      if (open.some((parent) => postQuotes.has(parent)) && isXPostAddress(new URL(href), true)) {
        postLinks.push(element);
      }
    } else if (name === "blockquote" && read.get("data-embed") === "x") {
      postQuotes.add(element);
    } else if (name === "td" || name === "th") {
      const colspan = toCount(read.get("colspan"));
      const rowspan = toCount(read.get("rowspan"));
      if (colspan !== null && colspan > 1) element.colspan = Math.min(colspan, MAX_SPAN);
      if (rowspan !== null && rowspan > 1) element.rowspan = Math.min(rowspan, MAX_SPAN);
    } else if (name === "ol") {
      const first = toCount(read.get("start"));
      if (first !== null) element.start = first;
    }
    elements += 1;
    append(element);
    open.push(element);
  }
  // 公式の引用は、本文のあとに出典のユーザー名と投稿元へのリンクを置く。
  for (const quote of postQuotes) {
    const posts = new Map<string, { url: string; links: ContentElement[] }>();
    let index = quote.children.length - 1;
    let bodyText = "";
    // 引用の末尾に並ぶ出典だけをたどり、途中にあったリンクは出典候補に含めない。
    while (index >= 0) {
      const child = quote.children[index];
      if (typeof child === "string" ? child.trim() === "" : child?.tag === "br") {
        index -= 1;
        continue;
      }
      if (typeof child === "string" || child?.tag !== "a") break;
      const parts: string[] = [];
      let before = index - 1;
      for (; before >= 0; before -= 1) {
        const node = quote.children[before];
        if (node === undefined) break;
        const part = attributionText(node);
        if (part === null) break;
        parts.push(part);
      }
      const text = parts.reverse().join("");
      const start = text.indexOf("—");
      const attribution = /\(@([A-Za-z0-9_]{1,15})\)\s*$/.exec(text);
      const handle = attribution?.[1];
      if (
        start === -1 ||
        attribution === null ||
        attribution.index <= start ||
        handle === undefined
      )
        break;

      const post = child.href === undefined ? undefined : xPostUrl(child.href);
      if (post !== undefined) {
        const [, , , user, , id] = post.split("/");
        if (id !== undefined && user?.toLowerCase() === handle.toLowerCase()) {
          const candidate = posts.get(id) ?? { url: post, links: [] };
          candidate.url = post;
          candidate.links.push(child);
          posts.set(id, candidate);
        }
      }
      index = before;
      bodyText = text.slice(0, start).trim();
      if (bodyText !== "") break;
    }
    // 本文用の段落が空でも、出典より手前に本文の要素があれば候補を使う。
    if (
      bodyText === "" &&
      !quote.children
        .slice(0, index + 1)
        .some((child) => (typeof child === "string" ? child.trim() !== "" : child.tag !== "br"))
    )
      continue;
    const candidate = posts.size === 1 ? posts.values().next().value : undefined;
    if (candidate !== undefined) {
      const { url, links } = candidate;
      quote.xPost = url;
      // 空の出典リンクだけは別に「X で開く」を出すため、Tab の操作対象を重ねない。
      const unnamed = new Set<ContentNode>(
        links.filter((link) => !hasVisibleContent(link.children)),
      );
      quote.children = quote.children.filter((node) => !unnamed.has(node));
    }
  }
  for (const link of postLinks) {
    if (!hasVisibleContent(link.children)) link.children = ["X で開く"];
  }
  return root;
}

/** 木の中に、出すもの（空白でない文字か、画像）があるか */
export function hasVisibleContent(nodes: readonly ContentNode[]): boolean {
  // 深さは MAX_CONTENT_DEPTH までなので、再帰で足りる
  return nodes.some((node) =>
    typeof node === "string"
      ? node.trim() !== ""
      : node.tag === "img" || node.xPost !== undefined || hasVisibleContent(node.children),
  );
}

/** タグの終わりの > の位置。引用符の中の > は数えない。なければ -1 */
function findTagEnd(html: string, from: number): number {
  let quote = "";
  for (let i = from; i < html.length; i++) {
    const char = html[i];
    if (quote !== "") {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ">") return i;
  }
  return -1;
}

/** タグの属性を読む。同じ名前が 2 度あれば、最初のものを採る（ブラウザと同じ） */
function readAttributes(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = (match[1] ?? "").toLowerCase();
    if (!out.has(name)) out.set(name, decodeText(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return out;
}

/**
 * 文字参照を戻す。sendo が出すのは &amp; &lt; &gt; &quot; &#39; だけなので、数字のものと、
 * 少しの名前だけを読む。ほかは、そのままの文字として出す
 */
function decodeText(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(CHARACTER_REFERENCE, (_, decimal, hex, named) => {
    if (named !== undefined) return NAMED[named] ?? "";
    const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex, 16);
    const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
    return valid ? String.fromCodePoint(code) : "�";
  });
}

function toCount(value: string | undefined): number | null {
  return value !== undefined && DIGITS.test(value) ? Number(value) : null;
}
