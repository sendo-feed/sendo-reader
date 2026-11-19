export interface XEmbedRequest {
  cancel(): void;
  cancelPending(): boolean;
  deprioritize(): void;
  prioritize(): void;
}

export function createXEmbedQueue() {
  const visible = new Set<() => void>();
  const restoring = new Set<() => void>();
  let loading = 0;

  function drain() {
    while (loading < 4) {
      // 復元で画面外の投稿を取るときも、画面内の投稿がすぐ始められる枠を残す。
      const start =
        visible.values().next().value ??
        (loading < 3 ? restoring.values().next().value : undefined);
      if (start === undefined) return;
      start();
    }
  }

  return function enqueue(load: (done: () => void) => void, inView: boolean): XEmbedRequest {
    let active = false;
    function done() {
      if (!active) return;
      active = false;
      loading -= 1;
      drain();
    }
    function start() {
      visible.delete(start);
      restoring.delete(start);
      active = true;
      loading += 1;
      load(done);
    }

    (inView ? visible : restoring).add(start);
    drain();
    return {
      cancel() {
        visible.delete(start);
        restoring.delete(start);
        done();
      },
      cancelPending() {
        return visible.delete(start) || restoring.delete(start);
      },
      deprioritize() {
        if (!visible.delete(start)) return;
        restoring.add(start);
      },
      prioritize() {
        if (!restoring.delete(start)) return;
        visible.add(start);
        drain();
      },
    };
  };
}
