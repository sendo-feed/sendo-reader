<script lang="ts">
  import { onMount } from "svelte";
  import { describePushSendError, PUSH_UNAVAILABLE } from "../../lib/errors";
  import { type DeviceState, IOS_HOME_SCREEN_GUIDE, type TurnOnResult } from "../../lib/push";
  import { pushDevice } from "../../lib/push-device";
  import Problem from "./Problem.svelte";

  /**
   * この端末で通知を受ける（docs/decisions/notifications.md の 1〜4）。sendo とプッシュサービスに
   * 届かないとできないので、開いたときに確かめ、済むまでは押せない状態で出す。許可の状態は、
   * 前に出たときにも読み直す（端末の設定で許可してから戻れば、押せる状態に変わる）
   */
  let device = $state<DeviceState | null>(null);
  let busy = $state(false);
  let failure = $state<string | null>(null);
  let checks = 0;

  async function check(): Promise<void> {
    const id = ++checks;
    const next = await pushDevice.check();
    if (id === checks) device = next;
  }

  function retry() {
    device = null;
    failure = null;
    void check();
  }

  onMount(() => {
    void check();
    const onVisibility = () => {
      if (document.visibilityState === "visible" && !busy) void check();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      checks += 1;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  });

  function failureOf(result: TurnOnResult): string | null {
    switch (result.kind) {
      case "subscribe-failed":
        return "この端末では通知を受けられませんでした。";
      case "send-failed":
        return describePushSendError(result.error);
      default:
        // 窓を決めずに閉じたら、何も出さずに押す前に戻す。拒んだら、下の案内を出す
        return null;
    }
  }

  async function run(action: () => Promise<string | null>) {
    busy = true;
    failure = null;
    try {
      failure = await action();
      await check();
    } finally {
      busy = false;
    }
  }

  function turnOn(publicKey: string) {
    if (busy) return;
    // 利用者の操作のすぐあとに許可を求める（間に待ちを挟まない）
    const result = pushDevice.turnOn(publicKey);
    void run(async () => failureOf(await result));
  }

  function turnOff() {
    if (busy) return;
    void run(async () => {
      await pushDevice.turnOff();
      return null;
    });
  }
</script>

<section class="device" aria-labelledby="notifications-device">
  <h2 id="notifications-device">This device</h2>
  {#if device === null}
    <p class="status" role="status">確かめています…</p>
    <div>
      <button type="button" class="primary" disabled>Turn on notifications</button>
    </div>
  {:else if device.kind === "unauthorized"}
    <Problem error={device.error} {retry} />
  {:else if device.kind === "unreachable"}
    <div class="problem" role="alert">
      <p>通知を使えるかを確かめられませんでした。</p>
      <button type="button" onclick={retry}>Retry</button>
    </div>
  {:else if device.kind === "ios-home-screen"}
    <p class="status">{IOS_HOME_SCREEN_GUIDE}</p>
  {:else if device.kind === "unsupported"}
    <p class="status">このブラウザーでは通知を受けられません。</p>
  {:else if device.kind === "unavailable"}
    <p class="status">{PUSH_UNAVAILABLE}</p>
    {#if device.subscribed}
      <div>
        <button type="button" disabled={busy} onclick={turnOff}>Turn off notifications</button>
      </div>
    {/if}
  {:else if device.kind === "on"}
    <p class="status" role="status">この端末で通知を受けています。</p>
    <div>
      <button type="button" disabled={busy} onclick={turnOff}>Turn off notifications</button>
    </div>
  {:else}
    {@const publicKey = device.publicKey}
    {#if device.kind === "denied"}
      <p class="status">
        通知が拒否されています。ホーム画面のアプリなら端末の設定（iPhone と iPad
        では、設定アプリの「通知」で Sendo
        を選ぶ）で、ブラウザーならサイトの設定で通知を許可してから、もう一度 Turn on notifications
        を押してください。
      </p>
    {:else}
      <p class="status" role="status">この端末では通知を受けていません。</p>
    {/if}
    <div>
      <button type="button" class="primary" disabled={busy} onclick={() => turnOn(publicKey)}>
        Turn on notifications
      </button>
    </div>
  {/if}
  {#if busy}
    <p class="note" role="status">処理しています…</p>
  {/if}
  {#if failure !== null}
    <p class="error" role="alert">{failure}</p>
  {/if}
  <p class="note">
    iPhone と iPad
    では、ホーム画面に追加すると受けられます。アイコンのバッジに、未読の数を出します。
  </p>
</section>

<style>
  .device {
    display: grid;
    gap: 0.75rem;
  }

  h2,
  p {
    margin: 0;
  }

  h2 {
    font-size: 1rem;
  }

  .status {
    font-size: 0.9375rem;
    line-height: 1.7;
  }

  .note {
    color: var(--muted);
    font-size: 0.8125rem;
    line-height: 1.7;
  }

  .error {
    color: var(--danger);
  }

  .problem {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    color: var(--danger);
  }
</style>
