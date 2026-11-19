/// <reference types="svelte" />
/// <reference types="vite/client" />

/** 動いている版（コミットと、ビルドした時刻）。vite.config.ts が埋め込む */
declare const __APP_VERSION__: { readonly commit: string; readonly builtAt: string };

declare const __X_EMBED_ORIGIN__: string;
