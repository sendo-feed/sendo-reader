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
  "xPost",
]);

describe("sendo が配る形の本文", () => {
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

describe("X の投稿の印（data-x-post）", () => {
  const ID = "1234567890123456789";

  test("印の付いた引用は、投稿の ID を文字列で持ち、中身は今と同じに残す", () => {
    expect(
      parseContent(
        `<blockquote data-x-post="${ID}"><p>文</p>— 名前 (@user) <a href="https://x.com/user/status/${ID}">日付</a></blockquote>`,
      ),
    ).toEqual([
      {
        tag: "blockquote",
        xPost: ID,
        children: [
          { tag: "p", children: ["文"] },
          "— 名前 (@user) ",
          { tag: "a", href: `https://x.com/user/status/${ID}`, children: ["日付"] },
        ],
      },
    ]);
    // 数にすると桁があふれる値も、そのまま
    expect(parseContent('<blockquote data-x-post="99999999999999999999"></blockquote>')).toEqual([
      { tag: "blockquote", xPost: "99999999999999999999", children: [] },
    ]);
    expect(parseContent('<blockquote data-x-post="0">a</blockquote>')).toEqual([
      { tag: "blockquote", xPost: "0", children: ["a"] },
    ]);
  });

  test("ID の形でない値は、印のない、ふつうの引用にする", () => {
    for (const value of [
      "",
      "abc",
      "123a",
      "１２３",
      "123456789012345678901",
      " 123",
      "123 ",
      "+123",
      "-123",
      "1.5",
      "1e3",
    ]) {
      expect(
        parseContent(`<blockquote data-x-post="${value}"><p>文</p></blockquote>`),
        value,
      ).toEqual([{ tag: "blockquote", children: [{ tag: "p", children: ["文"] }] }]);
    }
    // 値のない属性
    expect(parseContent("<blockquote data-x-post><p>文</p></blockquote>")).toEqual([
      { tag: "blockquote", children: [{ tag: "p", children: ["文"] }] },
    ]);
  });

  test("属性の名前の大文字、同じ属性の 2 つめ、文字参照は、ブラウザーと同じに読む", () => {
    expect(parseContent('<BLOCKQUOTE DATA-X-POST="123">a</BLOCKQUOTE>')).toEqual([
      { tag: "blockquote", xPost: "123", children: ["a"] },
    ]);
    // 同じ名前は、最初のものを採る
    expect(parseContent('<blockquote data-x-post="x" data-x-post="123">a</blockquote>')).toEqual([
      { tag: "blockquote", children: ["a"] },
    ]);
    expect(parseContent('<blockquote data-x-post="123" data-x-post="x">a</blockquote>')).toEqual([
      { tag: "blockquote", xPost: "123", children: ["a"] },
    ]);
    expect(parseContent('<blockquote data-x-post="&#49;&#50;">a</blockquote>')).toEqual([
      { tag: "blockquote", xPost: "12", children: ["a"] },
    ]);
  });

  test("blockquote でない要素の印と、ほかの data-* 属性は通さない", () => {
    const nodes = parseContent(
      `<p data-x-post="${ID}">a</p><div data-x-post="${ID}">b</div><q data-x-post="${ID}">c</q>` +
        `<blockquote data-x-post="${ID}" data-id="1" data-content-node="0.1" class="twitter-tweet">d</blockquote>`,
    );
    expect(nodes).toEqual([
      { tag: "p", children: ["a"] },
      { tag: "div", children: ["b"] },
      { tag: "q", children: ["c"] },
      { tag: "blockquote", xPost: ID, children: ["d"] },
    ]);
  });

  test("入れ子の引用は、それぞれの印をそれぞれのノードに持つ", () => {
    expect(
      parseContent(
        '<blockquote data-x-post="111"><p>外</p><blockquote data-x-post="222"><p>内</p></blockquote></blockquote>' +
          '<blockquote><blockquote data-x-post="333">内だけ</blockquote></blockquote>',
      ),
    ).toEqual([
      {
        tag: "blockquote",
        xPost: "111",
        children: [
          { tag: "p", children: ["外"] },
          { tag: "blockquote", xPost: "222", children: [{ tag: "p", children: ["内"] }] },
        ],
      },
      { tag: "blockquote", children: [{ tag: "blockquote", xPost: "333", children: ["内だけ"] }] },
    ]);
  });

  test("引用の中の文もリンクの文字も空でも、出すものがあると数える（開くリンクを出すため）", () => {
    // fixture の B（文が空）と D（リンクだけ）の形
    expect(
      hasVisibleContent(
        parseContent(
          `<blockquote data-x-post="${ID}"><p></p> <a href="https://x.com/user/status/${ID}"></a></blockquote>`,
        ),
      ),
    ).toBe(true);
    expect(
      hasVisibleContent(parseContent(`<div><blockquote data-x-post="${ID}"></blockquote></div>`)),
    ).toBe(true);
    // 印のない空の引用は、今までどおり
    expect(hasVisibleContent(parseContent("<blockquote><p> </p></blockquote>"))).toBe(false);
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

  test("X の投稿の印の値で、属性やタグから抜け出せない", () => {
    expect(
      parseContent(
        '<blockquote data-x-post="1"><script>alert(1)</script>"><p>a</p></blockquote>' +
          `<blockquote data-x-post='1" onclick="alert(1)'>b</blockquote>` +
          "<blockquote data-x-post=1&gt;<img src=x onerror=alert(1)>c</blockquote>",
      ),
    ).toEqual([
      { tag: "blockquote", xPost: "1", children: ['">', { tag: "p", children: ["a"] }] },
      { tag: "blockquote", children: ["b"] },
      { tag: "blockquote", children: ["c"] },
    ]);
    // とても長い値は、印にせず、時間もかからない
    const started = performance.now();
    const nodes = parseContent(`<blockquote data-x-post="${"1".repeat(1_000_000)}">d</blockquote>`);
    expect(nodes).toEqual([{ tag: "blockquote", children: ["d"] }]);
    expect(performance.now() - started).toBeLessThan(2000);
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
