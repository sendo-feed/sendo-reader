import { getContext } from "svelte";
import type { ReaderState } from "./state.svelte";

const KEY = Symbol("reader");

/** mount に渡すコンテキスト（画面のどこからでも useReader で読める） */
export function readerContext(state: ReaderState): Map<symbol, ReaderState> {
  return new Map([[KEY, state]]);
}

export function useReader(): ReaderState {
  const state = getContext<ReaderState | undefined>(KEY);
  if (state === undefined) throw new Error("ReaderState がない（mount に readerContext を渡す）");
  return state;
}
