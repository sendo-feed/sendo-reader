// 記事から受け取るのは投稿 ID だけ。公式ウィジェットはこのオリジンで動かす。
const postId = location.hash.slice(1);
const container = document.querySelector("main");

// 送るのは表示の高さだけ。受け手はこのフレームのオリジンと Window を照合する。
const notify = (height) => window.parent.postMessage({ type: "sendo:x-post-height", height }, "*");

if (/^[0-9]{1,20}$/.test(postId) && container && window.parent !== window) {
  const widget = document.createElement("script");
  widget.src = "https://platform.twitter.com/widgets.js";
  widget.onerror = () => notify(0);
  widget.onload = () => {
    if (!window.twttr) {
      notify(0);
      return;
    }
    window.twttr.ready(async ({ widgets }) => {
      try {
        const post = await widgets.createTweet(postId, container, {
          dnt: true,
          lang: "ja",
          conversation: "none",
        });
        if (post) {
          let previousHeight;
          const measure = () => {
            const measured = Math.ceil(container.getBoundingClientRect().height) + 16;
            const height = measured > 4000 ? 0 : measured;
            if (height === previousHeight) return;
            previousHeight = height;
            notify(height);
          };
          new ResizeObserver(measure).observe(container);
          // 画面外では描画が間引かれる。ウィジェットが枠の高さを変えたときはその場で測る。
          new MutationObserver(measure).observe(post, {
            attributes: true,
            attributeFilter: ["height", "style"],
          });
          measure();
        } else {
          notify(0);
        }
      } catch {
        notify(0);
      }
    });
  };
  document.head.append(widget);
}
