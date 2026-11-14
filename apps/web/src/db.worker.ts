// 手元の DB と同期を持つワーカー（タブごとに 1 つ）。代表になったものだけが DB を開く
// （docs/decisions/local-first.md）
import { runReaderWorker } from "@sendo-reader/core/web/worker";

runReaderWorker();
