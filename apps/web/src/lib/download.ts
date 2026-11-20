/** 文字のファイルを、ダウンロードさせる（Blob と <a download>。画面には出さない） */
export function downloadText(name: string, type: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // すぐに消すと、ダウンロードが始まる前に読めなくなるブラウザがある
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
