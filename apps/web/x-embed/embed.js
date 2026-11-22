// @ts-check
/**
 * X の投稿の隔離フレーム（docs/decisions/embeds.md の 2）。reader とは別のホスト名で配る。
 *
 * - URL のハッシュ（#id=<ID>&theme=<light か dark>）で受けた投稿を、X の公式の widgets.js で出す
 * - 親（reader）からの挨拶（sendo:x-post:hello）で親のオリジンを知り、そこにだけ結果を送る
 *   - sendo:x-post:rendered：createTweet の Promise が要素で解決したあと。高さは、余白を含めた
 *     入れ物の高さ（枠の高さによらない値）。解決の前には送らない。解決のあとに高さが変わったら、
 *     もう一度送る
 *   - sendo:x-post:failed：widgets.js が読めない、twttr がない、Promise が undefined で解決した、
 *     reject した
 * - 見た目は CSSOM で付ける（このページの CSP は、style 属性も <style> も許さない）
 */
(() => {
  const params = new URLSearchParams(location.hash.slice(1));
  const id = params.get("id") ?? "";
  const theme = params.get("theme");
  // フレームの中で開かれていない、または ID とテーマの形が合わなければ、何もしない
  if (window.parent === window) return;
  if (!/^[0-9]{1,20}$/.test(id) || (theme !== "light" && theme !== "dark")) return;

  // reader のテーマとそろえる（違うと、描画のあとに白い四角が出る）
  document.documentElement.style.colorScheme = theme;
  // 枠が中身より低い間に、スクロールバーで幅が縮むと、ウィジェットがその幅で組まれ、高さが枠の高さで
  // 変わってしまう。スクロールさせない（高さは、reader が枠に付ける）
  document.documentElement.style.overflow = "hidden";
  document.body.style.margin = "0";
  const container = document.getElementById("post");
  if (container === null) return;
  // 中の要素（div.twitter-tweet）の上下の余白も、入れ物の高さに入れる
  container.style.display = "flow-root";

  /** 親のオリジン。挨拶を受けるまでは null */
  let target = /** @type {string | null} */ (null);
  /** 最後に知らせる結果。挨拶より先に出たら、挨拶を受けてから送る */
  let result = /** @type {{ type: string, height?: number } | null} */ (null);
  let done = false;

  /** @param {{ type: string, height?: number }} message */
  const report = (message) => {
    result = message;
    if (target !== null) window.parent.postMessage(message, target);
  };
  const fail = () => {
    if (done) return;
    done = true;
    report({ type: "sendo:x-post:failed" });
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin === "null") return;
    if (event.data === null || typeof event.data !== "object") return;
    if (event.data.type !== "sendo:x-post:hello") return;
    target = event.origin;
    if (result !== null) window.parent.postMessage(result, target);
  });

  /** 余白を含めた入れ物の高さ（整数） */
  const height = () => Math.ceil(container.getBoundingClientRect().height);

  const rendered = () => {
    done = true;
    let last = height();
    report({ type: "sendo:x-post:rendered", height: last });
    // 枠の幅が変わると、ウィジェットの高さも変わる。縮んだときも送る
    new ResizeObserver(() => {
      const next = height();
      if (next === last) return;
      last = next;
      report({ type: "sendo:x-post:rendered", height: next });
    }).observe(container);
  };

  const script = document.createElement("script");
  script.src = "https://platform.twitter.com/widgets.js";
  script.async = true;
  script.addEventListener("error", fail);
  script.addEventListener("load", () => {
    /** @type {any} */
    const twttr = Reflect.get(window, "twttr");
    if (typeof twttr?.ready !== "function") {
      fail();
      return;
    }
    twttr.ready((/** @type {any} */ loaded) => {
      try {
        Promise.resolve(
          loaded.widgets.createTweet(id, container, {
            dnt: true,
            lang: "ja",
            conversation: "none",
            theme,
          }),
        ).then((element) => (element instanceof Element ? rendered() : fail()), fail);
      } catch {
        fail();
      }
    });
  });
  document.head.append(script);
})();
