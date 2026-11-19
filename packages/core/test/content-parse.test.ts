import { describe, expect, test } from "vitest";
import {
  hasVisibleContent,
  MAX_CONTENT_DEPTH,
  MAX_CONTENT_ELEMENTS,
  parseContent,
} from "../src/content/parse";
import type { ContentElement, ContentNode } from "../src/models";

const IMAGE = "/api/v1/images?url=https%3A%2F%2Fblog.example%2Fa.png&sig=abc";

/** 木の中の要素を、すべて並べる */
function elements(nodes: readonly ContentNode[]): ContentElement[] {
  return nodes.flatMap((node) =>
    typeof node === "string" ? [] : [node, ...elements(node.children)],
  );
}

/** 木の中の文字を、すべてつなぐ */
function textOf(nodes: readonly ContentNode[]): string {
  return nodes.map((node) => (typeof node === "string" ? node : textOf(node.children))).join("");
}

const tags = (html: string) => elements(parseContent(html)).map((element) => element.tag);

/** 画面に渡す木の、要素の項目として出てよい名前 */
const ELEMENT_KEYS = new Set([
  ...["tag", "children", "href", "src", "alt", "width", "height", "colspan", "rowspan", "start"],
]);

describe("sendo が配る形の本文", () => {
  test("X の埋め込みは本文が空でも投稿 URL を持つ", () => {
    const nodes = parseContent(
      '<blockquote data-embed="x"><p></p> — (@user) <a href="https://twitter.com/user/status/123456789?ref=foo"></a><br></blockquote>',
    );
    expect(nodes[0]).toMatchObject({
      tag: "blockquote",
      xPost: "https://x.com/user/status/123456789",
    });
    expect(hasVisibleContent(nodes)).toBe(true);
    expect(nodes[0]).not.toMatchObject({
      children: expect.arrayContaining([
        expect.objectContaining({ href: expect.stringContaining("/status/") }),
      ]),
    });
  });

  test("アカウント名を照合できない公式の投稿リンクは通常のリンクとして残す", () => {
    const [quote] = parseContent(
      '<blockquote data-embed="x"><p>引用</p> — 表示名 (@user) <a href="https://x.com/i/web/status/123">投稿</a></blockquote>',
    );
    expect(quote).not.toHaveProperty("xPost");
    expect(quote).toMatchObject({
      children: expect.arrayContaining([
        expect.objectContaining({ href: "https://x.com/i/web/status/123" }),
      ]),
    });
  });

  test("照合できた同じ投稿への複数のリンクを一つの候補として扱う", () => {
    const [quote] = parseContent(
      '<blockquote data-embed="x"><p>引用</p> — 表示名\n (@user) <a href="https://twitter.com/user/status/123"></a> — (@User) <a href="https://x.com/User/status/123?ref=example"></a></blockquote>',
    );
    expect(quote).toMatchObject({ xPost: "https://x.com/user/status/123" });
  });

  test("末尾に出典があれば段落以外の本文でも埋め込む", () => {
    const [quote] = parseContent(
      '<blockquote data-embed="x"><div>引用本文</div> — (@user) <a href="https://x.com/user/status/123">投稿日</a></blockquote>',
    );
    expect(quote).toMatchObject({ xPost: "https://x.com/user/status/123" });
  });

  test("引用本文にある X リンクは投稿元と見なさない", () => {
    for (const contents of [
      '<p>引用文 <a href="https://x.com/other/status/998">本文のリンク</a></p>',
      '— (@user) <a href="https://x.com/user/status/123">冒頭のリンク</a><p>引用文</p>',
      '<p>引用の前半</p> — (@user) <a href="https://x.com/user/status/123">途中のリンク</a><p>引用の後半</p>',
      '<p>引用の前半</p> — (@user) <a href="https://x.com/user/status/123">途中のリンク</a><div>引用の後半</div>',
    ]) {
      const [quote] = parseContent(`<blockquote data-embed="x">${contents}</blockquote>`);
      expect(quote).not.toHaveProperty("xPost");
    }
  });

  test("出典がない・一致しない・複数ある引用は通常のリンクとして残す", () => {
    for (const body of [
      '<a href="https://x.com/user/status/123">言及した投稿</a>',
      '<p>引用</p> — (@other) <a href="https://x.com/user/status/123">別の投稿</a>',
      '<p>引用</p> — (@user) <a href="https://x.com/user/status/123">一つめ</a> — (@user) <a href="https://x.com/user/status/456">二つめ</a>',
      '<p>引用</p> <cite>— 表示名 (@user)</cite> <a href="https://x.com/user/status/123">一つめ</a> — (@user) <a href="https://x.com/user/status/456">二つめ</a>',
      '<p>引用</p> — <strong>表示名 <em>(@user)</em></strong> <a href="https://x.com/user/status/123">一つめ</a> — (@user) <a href="https://x.com/user/status/456">二つめ</a>',
      '<p>引用</p> — (@user) <a href="https://x.com/user/status/123">一つめ</a> — 表示名 — 肩書 (@user) <a href="https://x.com/user/status/456">二つめ</a>',
    ]) {
      const [quote] = parseContent(`<blockquote data-embed="x">${body}</blockquote>`);
      expect(quote).not.toHaveProperty("xPost");
      expect(quote).toMatchObject({
        children: expect.arrayContaining([expect.objectContaining({ tag: "a" })]),
      });
    }
  });

  test("埋め込めない X の引用にある空の投稿リンクを読めるようにする", () => {
    const [quote] = parseContent(
      '<blockquote data-embed="x"><p>引用</p> — (@user) <a href="https://x.com/user/status/123"></a> — (@user) <a href="https://x.com/user/status/456"> </a> — (@user) <a href="https://x.com/i/web/status/789"></a></blockquote>',
    );
    expect(quote).not.toHaveProperty("xPost");
    for (const path of ["user/status/123", "user/status/456", "i/web/status/789"]) {
      expect(quote).toMatchObject({
        children: expect.arrayContaining([
          expect.objectContaining({ href: `https://x.com/${path}`, children: ["X で開く"] }),
        ]),
      });
    }
  });

  test("HTTP の投稿リンクは埋め込まずリンクの名前を残す", () => {
    const [quote] = parseContent(
      '<blockquote data-embed="x"><p>引用</p> — (@user) <a href="http://twitter.com/user/status/222"></a></blockquote>',
    );
    expect(quote).not.toHaveProperty("xPost");
    expect(quote).toMatchObject({
      children: expect.arrayContaining([
        { tag: "a", href: "http://twitter.com/user/status/222", children: ["X で開く"] },
      ]),
    });
  });

  test("X 以外の URL や通常の投稿リンクからは埋め込みを作らない", () => {
    for (const href of [
      "https://x.com.example/user/status/123",
      "https://example.com@x.com/user/status/123",
      "https://x.com:444/user/status/123",
      "https://x.com/user/status/123/photo/1",
      "https://x.com/intent/post",
    ]) {
      const [quote] = parseContent(
        `<blockquote data-embed="x"><p>引用</p> — (@user) <a href="${href}">リンク</a></blockquote>`,
      );
      expect(quote).not.toHaveProperty("xPost");
    }
    const [quote] = parseContent(
      '<blockquote><a href="https://x.com/user/status/123">通常のリンク</a></blockquote>',
    );
    expect(quote).not.toHaveProperty("xPost");
  });

  test("段落、見出し、リスト、引用、コード、表を、入れ子のまま木にする", () => {
    const nodes = parseContent(
      "<h2>見出し</h2><p>本文 <strong>強い</strong> と <em>斜め</em></p>" +
        '<ul><li>1</li><li>2</li></ul><ol start="3"><li>3</li></ol>' +
        "<blockquote><p>引用</p></blockquote><pre><code>a &lt; b &amp;&amp; c</code></pre>" +
        '<table><thead><tr><th colspan="2">h</th></tr></thead>' +
        '<tbody><tr><td rowspan="2">a</td><td>b</td></tr></tbody></table><hr>',
    );
    expect(nodes).toEqual([
      { tag: "h2", children: ["見出し"] },
      {
        tag: "p",
        children: [
          "本文 ",
          { tag: "strong", children: ["強い"] },
          " と ",
          { tag: "em", children: ["斜め"] },
        ],
      },
      {
        tag: "ul",
        children: [
          { tag: "li", children: ["1"] },
          { tag: "li", children: ["2"] },
        ],
      },
      { tag: "ol", start: 3, children: [{ tag: "li", children: ["3"] }] },
      { tag: "blockquote", children: [{ tag: "p", children: ["引用"] }] },
      { tag: "pre", children: [{ tag: "code", children: ["a < b && c"] }] },
      {
        tag: "table",
        children: [
          {
            tag: "thead",
            children: [{ tag: "tr", children: [{ tag: "th", colspan: 2, children: ["h"] }] }],
          },
          {
            tag: "tbody",
            children: [
              {
                tag: "tr",
                children: [
                  { tag: "td", rowspan: 2, children: ["a"] },
                  { tag: "td", children: ["b"] },
                ],
              },
            ],
          },
        ],
      },
      { tag: "hr", children: [] },
    ]);
  });

  test("リンクは、絶対の URL（http ／ https）だけを通す。rel と target は持たない（画面が付ける）", () => {
    const nodes = parseContent(
      '<p><a href="https://example.com/a?x=1&amp;y=2" rel="noopener noreferrer nofollow">a</a>' +
        '<a href="http://example.com/">b</a></p>',
    );
    expect(elements(nodes).filter((element) => element.tag === "a")).toEqual([
      { tag: "a", href: "https://example.com/a?x=1&y=2", children: ["a"] },
      { tag: "a", href: "http://example.com/", children: ["b"] },
    ]);
  });

  test("画像は、sendo の中継の URL を受け取ったまま使い、大きさがあれば持つ", () => {
    expect(
      parseContent(
        `<img src="${IMAGE.replace(/&/g, "&amp;")}" alt="図 &quot;1&quot;" width="640" height="480">`,
      ),
    ).toEqual([{ tag: "img", children: [], src: IMAGE, alt: '図 "1"', width: 640, height: 480 }]);
    // 大きさは、両方そろっているときだけ（片方では、場所を取れない）
    expect(parseContent(`<img src="${IMAGE}" width="640">`)).toEqual([
      { tag: "img", children: [], src: IMAGE, alt: "" },
    ]);
  });

  test("文字参照は、文字に戻す。知らないものは、そのまま出す", () => {
    expect(
      parseContent("&lt;script&gt;alert(1)&lt;/script&gt; &#39;a&#x27; &copy; &amp;amp;"),
    ).toEqual(["<script>alert(1)</script> 'a' &copy; &amp;"]);
  });
});

describe("悪意のある本文（sendo のサニタイズをすり抜けたとして）", () => {
  test("スクリプトとスタイルは、中身ごと落とす", () => {
    const nodes = parseContent(
      "<p>前</p><script>alert('<p>x</p>')</script><style>body{display:none}</style>" +
        "<SCRIPT src=//evil.example/x.js></SCRIPT><p>後</p>",
    );
    expect(nodes).toEqual([
      { tag: "p", children: ["前"] },
      { tag: "p", children: ["後"] },
    ]);
  });

  test("埋め込み、フォーム、SVG などは、中身ごと落とす", () => {
    const html =
      '<iframe src="https://evil.example/"></iframe><svg><a href="javascript:alert(1)"><text>x</text></a></svg>' +
      '<form action="https://evil.example/"><input name="q"><button>go</button></form>' +
      '<object data="x"></object><embed src="x"><video src="x"><source src="y"></video>' +
      "<math><mi>x</mi></math><template><p>t</p></template><p>残る</p>";
    expect(parseContent(html)).toEqual([{ tag: "p", children: ["残る"] }]);
  });

  test("知らないタグは、タグを落として中身だけ残す", () => {
    expect(
      parseContent(
        '<span class="x">a</span><font color="red">b</font><input value="v"><base href="//evil.example/">' +
          '<link rel="stylesheet" href="//evil.example/x.css"><meta http-equiv="refresh" content="0;url=//evil.example/">c',
      ),
    ).toEqual(["abc"]);
  });

  test("通すタグでも、決めた属性のほかは持たない（イベント、style、class、id、target など）", () => {
    const nodes = parseContent(
      '<p onclick="alert(1)" style="position:fixed;inset:0" class="app" id="app">a</p>' +
        `<img src="${IMAGE}" onerror="alert(1)" srcset="//evil.example/a.png 2x" style="width:9999px">` +
        '<a href="https://example.com/" onmouseover="alert(1)" target="_top" download="x">b</a>' +
        '<td colspan="2" background="//evil.example/a.png">c</td>',
    );
    for (const element of elements(nodes)) {
      for (const key of Object.keys(element)) expect(ELEMENT_KEYS.has(key)).toBe(true);
    }
    expect(elements(nodes)).toEqual([
      { tag: "p", children: ["a"] },
      { tag: "img", children: [], src: IMAGE, alt: "" },
      { tag: "a", href: "https://example.com/", children: ["b"] },
      { tag: "td", colspan: 2, children: ["c"] },
    ]);
  });

  test("リンクにできない URL は、タグを落として中身だけ残す", () => {
    for (const href of [
      "javascript:alert(1)",
      " JaVaScRiPt:alert(1)",
      "java&#x09;script:alert(1)",
      "&#106;avascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:x",
      // sendo は通すが、reader は http ／ https だけ
      "mailto:me@example.com",
      "blob:https://example.com/x",
      "file:///etc/passwd",
      "/relative",
      "//evil.example/",
      "",
    ]) {
      const nodes = parseContent(`<a href="${href}">x</a>`);
      expect(elements(nodes), href).toEqual([]);
      expect(textOf(nodes)).toBe("x");
    }
  });

  test("同じオリジンを指さない画像は、落とす", () => {
    for (const src of [
      "https://evil.example/a.png",
      "//evil.example/a.png",
      "/\\evil.example/a.png",
      "data:image/svg+xml,<svg onload=alert(1)>",
      "javascript:alert(1)",
      "",
    ]) {
      expect(parseContent(`<p>a<img src="${src}">b</p>`), src).toEqual([
        { tag: "p", children: ["ab"] },
      ]);
    }
    expect(parseContent("<img>")).toEqual([]);
  });

  test("属性の値の中の > や、タグの形をした文字に、だまされない", () => {
    expect(
      parseContent('<p title="a > b"><img alt="x><script>alert(1)</script>" src="x://y">c</p>'),
    ).toEqual([{ tag: "p", children: ["c"] }]);
    // 文字参照から戻した < は、タグにならない
    expect(parseContent("&lt;img src=x onerror=alert(1)&gt;")).toEqual([
      "<img src=x onerror=alert(1)>",
    ]);
    expect(tags("<<script>script>alert(1)</script>")).toEqual([]);
    expect(tags("<scr<script></script>ipt>alert(1)</script>")).toEqual([]);
    expect(tags("<p><!-- <script> --><b>x</b><!-- 閉じていない</p>")).toEqual(["p", "b"]);
  });

  test("閉じていないタグや引用符で、残りを読まない（読みすぎて止まらない）", () => {
    expect(parseContent('<p>a</p><a href="https://example.com/')).toEqual([
      { tag: "p", children: ["a"] },
    ]);
    expect(parseContent("<p>a</p><script>alert(1)")).toEqual([{ tag: "p", children: ["a"] }]);
    const started = performance.now();
    parseContent('<a "'.repeat(200_000));
    parseContent("<script>".repeat(100_000));
    parseContent("<".repeat(500_000));
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("閉じ忘れや、合わない閉じタグでも、木が崩れない", () => {
    expect(parseContent("<p>a<b>b</p>c</i></div>")).toEqual([
      { tag: "p", children: ["a", { tag: "b", children: ["b"] }] },
      "c",
    ]);
    // リンクの中のリンクは作らない
    expect(
      parseContent('<a href="https://a.example/">a<a href="https://b.example/">b</a></a>'),
    ).toEqual([
      { tag: "a", href: "https://a.example/", children: ["a"] },
      { tag: "a", href: "https://b.example/", children: ["b"] },
    ]);
  });

  test("深すぎる入れ子と、多すぎる要素は、タグを落として中身だけ残す", () => {
    const deep = parseContent(`${"<div>".repeat(5000)}x${"</div>".repeat(5000)}`);
    expect(elements(deep)).toHaveLength(MAX_CONTENT_DEPTH);
    expect(textOf(deep)).toBe("x");
    const many = parseContent("<b>x</b>".repeat(MAX_CONTENT_ELEMENTS + 10));
    expect(elements(many)).toHaveLength(MAX_CONTENT_ELEMENTS);
    expect(textOf(many)).toHaveLength(MAX_CONTENT_ELEMENTS + 10);
  });

  test("数の属性は、数字だけを通し、表のまたぐ数は上限で切る", () => {
    expect(
      elements(
        parseContent(
          '<td colspan="99999" rowspan="-1">a</td><td colspan="2;x">b</td><ol start="1e3"></ol>' +
            `<img src="${IMAGE}" width="100%" height="50">`,
        ),
      ),
    ).toEqual([
      { tag: "td", colspan: 1000, children: ["a"] },
      { tag: "td", children: ["b"] },
      { tag: "ol", children: [] },
      { tag: "img", children: [], src: IMAGE, alt: "" },
    ]);
  });
});

describe("出すものがあるか", () => {
  test("空白でない文字か、画像があれば true", () => {
    expect(hasVisibleContent(parseContent("<p>a</p>"))).toBe(true);
    expect(hasVisibleContent(parseContent(`<p><img src="${IMAGE}"></p>`))).toBe(true);
    expect(hasVisibleContent(parseContent("<p> </p><div><br></div>\n"))).toBe(false);
    expect(hasVisibleContent(parseContent("<script>alert(1)</script>"))).toBe(false);
    expect(hasVisibleContent(parseContent(""))).toBe(false);
  });
});
