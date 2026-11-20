import { describe, expect, it } from "vitest";
import {
  type ExportArticle,
  exportArticle,
  fetchImageAsDataUrl,
  fileBaseName,
  type ImageLoader,
} from "../src/content/export";
import { parseContent } from "../src/content/parse";

const article: ExportArticle = {
  title: "記事のタイトル",
  url: "https://blog.example/posts/1",
  feedTitle: "Blog",
  author: "著者",
  publishedAt: Date.UTC(2026, 10, 20, 3, 4, 5),
};

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const noImages: ImageLoader = async () => null;

async function html(source: string, loadImage: ImageLoader = noImages, meta = article) {
  return (await exportArticle(meta, parseContent(source), "html", loadImage)).text;
}

async function markdown(source: string, loadImage: ImageLoader = noImages, meta = article) {
  const { text } = await exportArticle(meta, parseContent(source), "markdown", loadImage);
  // front matter・タイトル・情報の行のあとの本文
  return text.split("\n\n").slice(3).join("\n\n").trimEnd();
}

describe("exportArticle（HTML）", () => {
  it("1 つの HTML の文書にし、記事の情報と全文を入れる", async () => {
    const file = await exportArticle(
      article,
      parseContent('<h2>見出し</h2><p>本文と<a href="https://x.example/a">リンク</a></p>'),
      "html",
      noImages,
    );
    expect(file.name).toBe("記事のタイトル.html");
    expect(file.type).toBe("text/html;charset=utf-8");
    expect(file.text.startsWith("<!doctype html>")).toBe(true);
    expect(file.text).toContain("<title>記事のタイトル</title>");
    expect(file.text).toContain(
      '<h1><a href="https://blog.example/posts/1" rel="noopener noreferrer nofollow">記事のタイトル</a></h1>',
    );
    expect(file.text).toContain('<p class="meta">Blog</p>');
    expect(file.text).toContain('datetime="2026-11-20T03:04:05.000Z"');
    expect(file.text).toContain("著者");
    expect(file.text).toContain(
      '<h2>見出し</h2><p>本文と<a href="https://x.example/a" rel="noopener noreferrer nofollow">リンク</a></p>',
    );
    // 開いたときに、スクリプトと外への通信を止める
    expect(file.text).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`,
    );
  });

  it("文字と属性の値をエスケープし、通さないものは書かない", async () => {
    const text = await html(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; "q"</p>' +
        '<a href="javascript:alert(1)">危ない</a>' +
        '<a href="https://x.example/?a=&quot;&gt;&lt;b">引用符</a>' +
        "<script>alert(2)</script><iframe src=x></iframe>",
      noImages,
      { ...article, title: '<img src=x onerror="alert(3)">', author: "<b>&</b>" },
    );
    expect(text).not.toContain("<script");
    expect(text).not.toContain("<iframe");
    expect(text).not.toContain("javascript:");
    expect(text).not.toContain("<img src=x");
    expect(text).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;");
    expect(text).toContain("危ない");
    expect(text).toContain('href="https://x.example/?a=%22%3E%3Cb"');
    expect(text).toContain("<title>&lt;img src=x onerror=&quot;alert(3)&quot;&gt;</title>");
    expect(text).toContain("&lt;b&gt;&amp;&lt;/b&gt;");
  });

  it("木に通っていないタグは、中身だけ書く", async () => {
    const nodes = [
      { tag: "script", children: ["中身"] },
      { tag: "p", children: ["段落"] },
    ];
    const { text } = await exportArticle(article, nodes, "html", noImages);
    expect(text).not.toContain("<script>");
    expect(text).toContain("中身<p>段落</p>");
  });

  it("画像は data: URI で埋め込み、取れなければ代替テキストを残す", async () => {
    const requested: string[] = [];
    const text = await html(
      '<p><img src="/api/v1/images?url=a&amp;sig=1" alt="図 1" width="10" height="20">' +
        '<img src="/api/v1/images?url=b&amp;sig=2" alt="取れない図">' +
        '<img src="/api/v1/images?url=c&amp;sig=3" alt="">' +
        '<img src="/api/v1/images?url=a&amp;sig=1" alt="同じ図"></p>',
      async (src) => {
        requested.push(src);
        return src.includes("url=a") ? PNG : null;
      },
    );
    // 受け取った URL のまま、同じ URL は 1 度だけ取る
    expect(requested.sort()).toEqual([
      "/api/v1/images?url=a&sig=1",
      "/api/v1/images?url=b&sig=2",
      "/api/v1/images?url=c&sig=3",
    ]);
    expect(text).toContain(`<img src="${PNG}" alt="図 1" width="10" height="20">`);
    expect(text).toContain("[画像: 取れない図]");
    expect(text).toContain(`<img src="${PNG}" alt="同じ図">`);
    expect(text).not.toContain("/api/v1/images");
  });

  it("画像の読み込みが data:image でない値や失敗を返したら、埋め込まない", async () => {
    const text = await html('<img src="/i?1" alt="a"><img src="/i?2" alt="b">', async (src) => {
      if (src.endsWith("1")) return 'data:text/html;base64,PHNjcmlwdD4="';
      throw new Error("offline");
    });
    expect(text).not.toContain("data:text/html");
    expect(text).toContain("[画像: a][画像: b]");
  });
});

describe("exportArticle（Markdown）", () => {
  it("front matter と、タイトル・情報の行を付ける", async () => {
    const file = await exportArticle(article, parseContent("<p>本文</p>"), "markdown", noImages);
    expect(file.name).toBe("記事のタイトル.md");
    expect(file.type).toBe("text/markdown;charset=utf-8");
    const [front, heading, , body] = file.text.split("\n\n");
    expect(front).toBe(
      [
        "---",
        'title: "記事のタイトル"',
        'url: "https://blog.example/posts/1"',
        'feed: "Blog"',
        'author: "著者"',
        'published: "2026-11-20T03:04:05.000Z"',
        "---",
      ].join("\n"),
    );
    expect(heading).toBe("# [記事のタイトル](https://blog.example/posts/1)");
    expect(body).toBe("本文\n");
    expect(file.text.endsWith("本文\n")).toBe(true);
  });

  it("ない情報は書かず、front matter の値は引用符の中でエスケープする", async () => {
    const { text } = await exportArticle(
      {
        title: 'a "b"\nc',
        url: "javascript:alert(1)",
        feedTitle: null,
        author: null,
        publishedAt: 0,
      },
      [],
      "markdown",
      noImages,
    );
    expect(text).toContain('title: "a \\"b\\"\\nc"');
    expect(text).not.toContain("url:");
    expect(text).not.toContain("feed:");
    expect(text).not.toContain("author:");
    expect(text).not.toContain("javascript:");
    // 見出しは 1 行にする
    expect(text).toContain('# a "b" c\n');
  });

  it("見出し・段落・強調・リンク・改行・区切り線を変換する", async () => {
    expect(
      await markdown(
        "<h2>見出し</h2><p>本文の<strong>強調</strong>と<em>斜体</em>と<del>消した</del>と" +
          '<a href="https://x.example/a(b)">リンク</a>と<code>a`b</code></p>' +
          "<p>1 行目<br>2 行目</p><hr><h6>小さい #</h6>",
      ),
    ).toBe(
      [
        "## 見出し",
        "本文の**強調**と*斜体*と~~消した~~と[リンク](https://x.example/a%28b%29)と``a`b``",
        "1 行目\\\n2 行目",
        "---",
        "###### 小さい \\#",
      ].join("\n\n"),
    );
  });

  it("リスト（入れ子と番号）と引用を変換する", async () => {
    expect(
      await markdown(
        "<ul><li>一<ul><li>一の一</li></ul></li><li>二</li></ul>" +
          '<ol start="3"><li>三</li><li><p>四</p><p>続き</p></li></ol>' +
          "<blockquote><p>引用</p><p>二段落</p></blockquote>",
      ),
    ).toBe(
      ["- 一\n\n  - 一の一\n- 二", "3. 三\n4. 四\n\n   続き", "> 引用\n>\n> 二段落"].join("\n\n"),
    );
  });

  it("コードブロックは、中の ``` より長い囲みにする", async () => {
    expect(await markdown("<pre><code>a *b*\n```\nc</code></pre>")).toBe(
      "````\na *b*\n```\nc\n````",
    );
  });

  it("表を GFM の表にする", async () => {
    expect(
      await markdown(
        "<table><caption>表の名前</caption><thead><tr><th>名前</th><th>値</th></tr></thead>" +
          '<tbody><tr><td colspan="2">a|b</td></tr><tr><td>c<br>d</td></tr></tbody></table>',
      ),
    ).toBe(["表の名前", "| 名前 | 値 |\n| --- | --- |\n| a\\|b |  |\n| c d |  |"].join("\n\n"));
  });

  it("文字の中の記号と、行の頭の印をエスケープする", async () => {
    expect(
      await markdown(
        "<p>*星* _下線_ `引用` [括弧] &lt;tag&gt; ~消~ a&amp;b \\</p>" +
          "<p># 見出しではない</p><p>- リストではない</p><p>2026. 年</p><p>&gt; 引用ではない</p>",
      ),
    ).toBe(
      [
        "\\*星\\* \\_下線\\_ \\`引用\\` \\[括弧\\] \\<tag\\> \\~消\\~ a\\&b \\\\",
        "\\# 見出しではない",
        "\\- リストではない",
        "2026\\. 年",
        "\\> 引用ではない",
      ].join("\n\n"),
    );
  });

  it("画像は data: URI で埋め込み、取れなければ代替テキストを残す", async () => {
    expect(
      await markdown(
        '<p><img src="/i?ok" alt="図 [1]"><img src="/i?ng" alt="取れない"><img src="/i?ng2" alt=""></p>',
        async (src) => (src === "/i?ok" ? PNG : null),
      ),
    ).toBe(`![図 \\[1\\]](${PNG})\\[画像: 取れない\\]`);
  });
});

describe("fetchImageAsDataUrl", () => {
  const respond =
    (body: BodyInit | null, init: ResponseInit): typeof fetch =>
    async () =>
      new Response(body, init);

  it("200 の画像を、同じオリジンのクッキー付きで取り、data: URI にする", async () => {
    let seen: RequestInit | undefined;
    const fetcher: typeof fetch = async (_url, init) => {
      seen = init;
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    };
    expect(await fetchImageAsDataUrl("/api/v1/images?url=a", fetcher)).toBe(
      "data:image/png;base64,AQID",
    );
    expect(seen?.credentials).toBe("same-origin");
  });

  it("画像でない応答・失敗・取れないときは null", async () => {
    expect(
      await fetchImageAsDataUrl(
        "/i",
        respond("<p>x</p>", { status: 200, headers: { "content-type": "text/html" } }),
      ),
    ).toBeNull();
    expect(
      await fetchImageAsDataUrl(
        "/i",
        respond("x", { status: 200, headers: { "content-type": "image/svg+xml" } }),
      ),
    ).toBeNull();
    expect(
      await fetchImageAsDataUrl(
        "/i",
        respond(null, { status: 502, headers: { "content-type": "image/png" } }),
      ),
    ).toBeNull();
    expect(
      await fetchImageAsDataUrl("/i", async () => {
        throw new TypeError("offline");
      }),
    ).toBeNull();
  });
});

describe("fileBaseName", () => {
  it("パスに使えない文字と制御文字を _ にし、100 文字までにする", () => {
    expect(fileBaseName('a/b\\c:d*e?f"g<h>i|j\u0000k\tl')).toBe("a_b_c_d_e_f_g_h_i_j_k_l");
    expect(fileBaseName("..隠し.")).toBe("隠し");
    expect(Array.from(fileBaseName("あ".repeat(150)))).toHaveLength(100);
    expect(fileBaseName(null)).toBe("article");
    expect(fileBaseName(" / ")).toBe("_");
    expect(fileBaseName("...")).toBe("article");
  });
});
