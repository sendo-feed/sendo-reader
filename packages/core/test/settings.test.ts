import { describe, expect, test } from "vitest";
import { type DeviceType, ReaderCore, type SettingItem } from "../src";
import { createSendoApi } from "../src/api/client";
import { pull } from "../src/sync/pull";
import { listPending } from "../src/sync/queue";
import type { FakeSendo } from "./fake-sendo";
import { openMemoryDb, setup } from "./helpers";

/** 同じ sendo につないだ、もう 1 台の端末 */
async function anotherDevice(server: FakeSendo) {
  const db = await openMemoryDb();
  const core = await ReaderCore.open({
    db,
    baseUrl: "https://sendo.test/api/v1",
    fetch: server.fetch,
    now: () => server.now,
  });
  await core.restoreSession();
  return core;
}

/** 設定を、名前から値への形で読む */
async function settingsOf(core: ReaderCore, deviceType: DeviceType = "mobile") {
  return Object.fromEntries(
    (await core.listSettings(deviceType)).map((item) => [item.name, item.value]),
  );
}

/** 送らずに、差分の取り込みだけをする（送り終えていない操作が残ったまま取り込む場面） */
async function pullOnly(context: Awaited<ReturnType<typeof setup>>) {
  const api = createSendoApi({ baseUrl: "https://sendo.test/api/v1", fetch: context.server.fetch });
  return pull(context.db, api, {});
}

describe("設定を預ける", () => {
  test("手元にすぐ反映し、同期で sendo に送る。同じ種類のもう 1 台に、同期で届く", async () => {
    const { server, core } = await setup();
    const other = await anotherDevice(server);
    await core.sync();
    await other.sync();
    const changes: string[][] = [];
    other.onChange((tables) => changes.push([...tables]));

    await core.changeSettings("mobile", { put: [{ name: "reader.theme", value: "dark" }] });
    expect(await settingsOf(core)).toEqual({ "reader.theme": "dark" });
    expect(server.settingsOf("mobile")).toEqual({});
    expect(await core.countPending()).toBe(1);

    await core.sync();
    expect(await core.countPending()).toBe(0);
    expect(server.settingsOf("mobile")).toEqual({ "reader.theme": "dark" });

    await other.sync();
    expect(await settingsOf(other)).toEqual({ "reader.theme": "dark" });
    expect(changes).toContainEqual(["settings"]);
  });

  test("種類の違う 2 台では、互いの設定が混ざらない（手元には、どちらの分も届く）", async () => {
    const { server, core } = await setup();
    const desktop = await anotherDevice(server);
    await core.changeSettings("mobile", { put: [{ name: "reader.theme", value: "dark" }] });
    await desktop.changeSettings("desktop", { put: [{ name: "reader.theme", value: "light" }] });
    await core.sync();
    await desktop.sync();
    await core.sync();

    expect(await settingsOf(core, "mobile")).toEqual({ "reader.theme": "dark" });
    expect(await settingsOf(desktop, "desktop")).toEqual({ "reader.theme": "light" });
    expect(await settingsOf(core, "desktop")).toEqual({ "reader.theme": "light" });
    expect(server.settingsOf("mobile")).toEqual({ "reader.theme": "dark" });
    expect(server.settingsOf("desktop")).toEqual({ "reader.theme": "light" });
  });

  test("オフラインで変えた設定は、つながったあとに送る。送り直しても壊れない", async () => {
    const { server, core } = await setup();
    await core.sync();
    await core.changeSettings("mobile", { put: [{ name: "reader.textSize", value: "large" }] });

    // /me のあと、PATCH が届かない
    server.failNext(null, "network");
    await expect(core.sync()).rejects.toMatchObject({ kind: "network" });
    expect(await core.countPending()).toBe(1);
    expect(await settingsOf(core)).toEqual({ "reader.textSize": "large" });

    // sendo には届いたが、応答を失った。もう一度送っても、同じ結果になる
    server.onRequest = async (path) => {
      if (path !== "PATCH /settings/mobile") return;
      server.onRequest = null;
      server.putSetting("mobile", "reader.textSize", "large");
      throw new TypeError("fetch failed");
    };
    await expect(core.sync()).rejects.toMatchObject({ kind: "network" });
    await core.sync();
    expect(await core.countPending()).toBe(0);
    expect(server.settingsOf("mobile")).toEqual({ "reader.textSize": "large" });
    expect(await settingsOf(core)).toEqual({ "reader.textSize": "large" });
  });

  test("2 台で別の項目を同時に変えても、どちらも残る。同じ項目は、後から受けたほうになる", async () => {
    const { server, core } = await setup();
    const other = await anotherDevice(server);
    await core.changeSettings("mobile", {
      put: [
        { name: "reader.theme", value: "dark" },
        { name: "reader.layout", value: "compact" },
      ],
    });
    await other.changeSettings("mobile", {
      put: [
        { name: "reader.textSize", value: "large" },
        { name: "reader.layout", value: "comfortable" },
      ],
    });
    await core.sync();
    await other.sync();
    await core.sync();

    const expected = {
      "reader.theme": "dark",
      "reader.textSize": "large",
      "reader.layout": "comfortable",
    };
    expect(server.settingsOf("mobile")).toEqual(expected);
    expect(await settingsOf(core)).toEqual(expected);
    expect(await settingsOf(other)).toEqual(expected);
  });

  test("既定に戻した項目は消して送り、もう 1 台でも既定に戻る", async () => {
    const { server, core } = await setup();
    const other = await anotherDevice(server);
    await core.changeSettings("mobile", { put: [{ name: "reader.theme", value: "dark" }] });
    await core.sync();
    await other.sync();
    expect(await settingsOf(other)).toEqual({ "reader.theme": "dark" });

    await core.changeSettings("mobile", { remove: ["reader.theme"] });
    expect(await settingsOf(core)).toEqual({});
    await core.sync();
    expect(server.settingsRequests.at(-1)?.body).toEqual({ put: [], remove: ["reader.theme"] });
    await other.sync();
    expect(await settingsOf(other)).toEqual({});
  });

  test("まだ送っていない変更のある項目は、同期で届いた値で上書きしない", async () => {
    const context = await setup();
    const { server, core } = context;
    await core.sync();
    await core.changeSettings("mobile", { put: [{ name: "reader.theme", value: "dark" }] });
    server.putSetting("mobile", "reader.theme", "light");
    server.putSetting("mobile", "reader.textSize", "small");

    await pullOnly(context);
    expect(await settingsOf(core)).toEqual({
      "reader.theme": "dark",
      "reader.textSize": "small",
    });
    // 送ると、後から受けたこちらの値になる
    await core.sync();
    expect(server.settingsOf("mobile")).toMatchObject({ "reader.theme": "dark" });
  });

  test("続けて変えた設定はまとめ、名前ごとに最後の操作だけを送る", async () => {
    const { server, core } = await setup();
    await core.sync();
    await core.changeSettings("mobile", { put: [{ name: "reader.theme", value: "dark" }] });
    await core.changeSettings("mobile", { put: [{ name: "reader.textSize", value: "large" }] });
    await core.changeSettings("mobile", { put: [{ name: "reader.theme", value: "light" }] });
    await core.changeSettings("mobile", { remove: ["reader.textSize"] });
    // 別の種類の操作には、まとめない
    await core.changeSettings("desktop", { put: [{ name: "reader.theme", value: "dark" }] });
    expect(await core.countPending()).toBe(2);

    await core.sync();
    expect(server.settingsRequests).toEqual([
      {
        deviceType: "mobile",
        body: { put: [{ name: "reader.theme", value: "light" }], remove: ["reader.textSize"] },
      },
      {
        deviceType: "desktop",
        body: { put: [{ name: "reader.theme", value: "dark" }], remove: [] },
      },
    ]);
  });

  test("100 項目を超える変更は、100 項目ずつに分けて送る", async () => {
    const { server, core } = await setup();
    await core.sync();
    const items = (from: number, count: number): SettingItem[] =>
      Array.from({ length: count }, (_, i) => ({
        name: `reader.list:/feeds/${from + i}`,
        value: { layout: "compact" },
      }));
    await core.changeSettings("mobile", { put: items(0, 90) });
    await core.changeSettings("mobile", { put: items(90, 90), remove: ["reader.theme"] });
    expect(await core.countPending()).toBe(1);

    await core.sync();
    const sizes = server.settingsRequests.map(
      ({ body }) => (body.put as unknown[]).length + (body.remove as unknown[]).length,
    );
    expect(sizes).toEqual([100, 81]);
    expect(Object.keys(server.settingsOf("mobile"))).toHaveLength(180);
  });

  test("名前の形が違う、値が大きすぎる、同じ名前が 2 度ある変更は、積まずに断る", async () => {
    const { core } = await setup();
    const change = (put: SettingItem[], remove: string[] = []) =>
      core.changeSettings("mobile", { put, remove });
    await expect(change([{ name: "theme", value: "dark" }])).rejects.toBeInstanceOf(RangeError);
    await expect(change([{ name: "reader.テーマ", value: 1 }])).rejects.toBeInstanceOf(RangeError);
    await expect(change([{ name: "reader.a b", value: 1 }])).rejects.toBeInstanceOf(RangeError);
    await expect(change([{ name: `reader.${"a".repeat(122)}`, value: 1 }])).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(change([{ name: "reader.big", value: "あ".repeat(3000) }])).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(change([{ name: "reader.a", value: 1 }], ["reader.a"])).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(
      core.changeSettings("tablet" as DeviceType, { remove: ["reader.a"] }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(await core.countPending()).toBe(0);
    // 何も変えない変更は、積まない
    await core.changeSettings("mobile", {});
    expect(await core.countPending()).toBe(0);
  });
});

describe("同期で届いた設定", () => {
  test("知らない端末の種類の項目は置かない。同じ項目が続けて来たら、後のものを採る", async () => {
    const { server, core, db } = await setup();
    server.putSetting("tablet", "reader.theme", "dark");
    server.putSetting("mobile", "reader.theme", "dark");
    server.removeSetting("mobile", "reader.theme");
    server.putSetting("mobile", "reader.theme", "light");
    server.putSetting("mobile", "reader.list:/feeds/1", { layout: "compact", extra: [1, null] });
    await core.sync();

    expect(await settingsOf(core)).toEqual({
      "reader.theme": "light",
      "reader.list:/feeds/1": { layout: "compact", extra: [1, null] },
    });
    expect(await db.all("select distinct device_type from synced_settings")).toEqual([
      { device_type: "mobile" },
    ]);
  });

  test("形の違う応答は、同期の失敗として扱う", async () => {
    const { server, core } = await setup();
    server.putSetting("mobile", "reader.theme", "dark");
    const original = server.fetch;
    const broken = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await original(input, init);
      if (!String(input instanceof Request ? input.url : input).includes("/sync")) return response;
      const body = (await response.json()) as { settings: { name?: string }[] };
      for (const setting of body.settings) delete setting.name;
      return new Response(JSON.stringify(body), { status: 200, headers: response.headers });
    };
    const other = await ReaderCore.open({
      db: await openMemoryDb(),
      baseUrl: "https://sendo.test/api/v1",
      fetch: broken,
    });
    await other.restoreSession();
    await expect(other.sync()).rejects.toMatchObject({ kind: "server" });
    expect(await settingsOf(other)).toEqual({});
    void core;
  });
});

describe("sendo が受け付けなかった設定", () => {
  test("上限を超えた（409）変更は、送り直さず、手元を sendo の状態に戻して捨てる", async () => {
    const { server, core } = await setup();
    server.maxSettings = 2;
    server.putSetting("mobile", "reader.theme", "dark");
    server.putSetting("mobile", "reader.textSize", "large");
    await core.sync();

    await core.changeSettings("mobile", {
      put: [
        { name: "reader.theme", value: "light" },
        { name: "reader.layout", value: "compact" },
      ],
    });
    // あとの操作は、戻したあとにも残る
    await core.changeSettings("desktop", { put: [{ name: "reader.theme", value: "dark" }] });
    const changes: string[][] = [];
    core.onChange((tables) => changes.push([...tables]));

    const result = await core.sync();
    expect(result.push.rejected).toHaveLength(1);
    expect(result.push.rejected[0]?.error).toMatchObject({ status: 409, code: "settings_full" });
    expect(await core.countPending()).toBe(0);
    expect(await settingsOf(core)).toEqual({
      "reader.theme": "dark",
      "reader.textSize": "large",
    });
    expect(await settingsOf(core, "desktop")).toEqual({ "reader.theme": "dark" });
    expect(changes).toContainEqual(["settings"]);
    // 全体の同期し直しは、頼まない
    expect(result.pull.reset).toBe(false);
  });

  test("戻すための読み出しが届かなければ、操作を残してやり直す", async () => {
    const { server, core } = await setup();
    server.maxSettings = 0;
    await core.sync();
    await core.changeSettings("mobile", { put: [{ name: "reader.theme", value: "dark" }] });

    // /me、PATCH（409）のあと、GET /settings が届かない
    server.failNext(null, null, "network");
    await expect(core.sync()).rejects.toMatchObject({ kind: "network" });
    expect(await core.countPending()).toBe(1);

    await core.sync();
    expect(await core.countPending()).toBe(0);
    expect(await settingsOf(core)).toEqual({});
  });
});

describe("なくなった一覧の設定", () => {
  test("購読をやめたら、そのフィードの一覧の設定を、両方の種類で消す", async () => {
    const { server, core } = await setup();
    const feed = server.subscribe({ url: "https://a.example/feed" });
    const kept = server.subscribe({ url: "https://b.example/feed" });
    const name = `reader.list:/feeds/${feed.id}`;
    const keptName = `reader.list:/feeds/${kept.id}`;
    server.putSetting("mobile", name, { layout: "compact" });
    server.putSetting("desktop", name, { oldestFirst: true });
    server.putSetting("mobile", keptName, { layout: "compact" });
    await core.sync();

    await core.unsubscribe(feed.id);
    expect(await settingsOf(core, "mobile")).toEqual({ [keptName]: { layout: "compact" } });
    expect(await settingsOf(core, "desktop")).toEqual({});
    await core.sync();
    expect(server.settingsOf("mobile")).toEqual({ [keptName]: { layout: "compact" } });
    expect(server.settingsOf("desktop")).toEqual({});
    expect(server.feeds.get(feed.id)?.deletedAt).not.toBeNull();
  });

  test("一覧の設定がなければ、設定の操作は積まない", async () => {
    const { server, core, db } = await setup();
    const feed = server.subscribe({ url: "https://a.example/feed" });
    await core.sync();
    await core.unsubscribe(feed.id);
    expect((await listPending(db)).map(({ op }) => op.kind)).toEqual(["unsubscribe"]);
  });

  test("フォルダを消したら、そのフォルダの一覧の設定を消す", async () => {
    const { server, core } = await setup();
    const folderId = await core.createFolder("Tech");
    await core.changeSettings("mobile", {
      put: [{ name: `reader.list:/folders/${folderId}`, value: { unreadOnly: true } }],
    });
    await core.sync();
    expect(Object.keys(server.settingsOf("mobile"))).toHaveLength(1);

    await core.deleteFolder(folderId);
    expect(await settingsOf(core)).toEqual({});
    await core.sync();
    expect(server.settingsOf("mobile")).toEqual({});
  });
});

describe("localStorage からの移行", () => {
  const seed: SettingItem[] = [
    { name: "reader.theme", value: "dark" },
    { name: "reader.textSize", value: "large" },
  ];

  test("先に同期してから、sendo にない項目だけを送る（ほかの端末の設定を上書きしない）", async () => {
    const { server, core } = await setup();
    // ほかの端末が、先に置いている
    server.putSetting("mobile", "reader.theme", "light");

    await core.seedSettings("mobile", seed);
    // 同期が済むまでは、移行待ちの値を使う（見た目が既定に戻らない）
    expect(await settingsOf(core)).toEqual({ "reader.theme": "dark", "reader.textSize": "large" });
    expect(await core.countPending()).toBe(0);

    await core.sync();
    expect(server.settingsRequests).toEqual([
      {
        deviceType: "mobile",
        body: { put: [{ name: "reader.textSize", value: "large" }], remove: [] },
      },
    ]);
    const expected = { "reader.theme": "light", "reader.textSize": "large" };
    expect(server.settingsOf("mobile")).toEqual(expected);
    expect(await settingsOf(core)).toEqual(expected);
    expect(await core.countPending()).toBe(0);

    // 移行は 1 度だけ。あとで sendo から消えても、送り直さない
    server.removeSetting("mobile", "reader.textSize");
    await core.sync();
    await core.sync();
    expect(await settingsOf(core)).toEqual({ "reader.theme": "light" });
    expect(server.settingsRequests).toHaveLength(1);
  });

  test("もう一方の種類の設定とは、比べない", async () => {
    const { server, core } = await setup();
    server.putSetting("desktop", "reader.theme", "light");
    await core.seedSettings("mobile", seed);
    await core.sync();
    expect(server.settingsOf("mobile")).toEqual({
      "reader.theme": "dark",
      "reader.textSize": "large",
    });
    expect(server.settingsOf("desktop")).toEqual({ "reader.theme": "light" });
  });

  test("同期できない間に変えた ／ 既定に戻した項目は、移行待ちの値で戻らない", async () => {
    const { server, core } = await setup();
    await core.seedSettings("mobile", seed);
    await core.changeSettings("mobile", { put: [{ name: "reader.theme", value: "light" }] });
    await core.changeSettings("mobile", { remove: ["reader.textSize"] });
    expect(await settingsOf(core)).toEqual({ "reader.theme": "light" });

    await core.sync();
    await core.sync();
    expect(server.settingsOf("mobile")).toEqual({ "reader.theme": "light" });
    expect(await settingsOf(core)).toEqual({ "reader.theme": "light" });
  });

  test("設定を配る前の版の sendo が相手なら、同期は止めず、移行待ちのまま残す", async () => {
    const { server, core } = await setup();
    server.settingsSupported = false;
    server.subscribe({ url: "https://a.example/feed" });
    await core.seedSettings("mobile", seed);

    await core.sync();
    expect(await core.listFeeds()).toHaveLength(1);
    expect(await core.countPending()).toBe(0);
    expect(await settingsOf(core)).toEqual({ "reader.theme": "dark", "reader.textSize": "large" });

    // sendo を新しくしたら、今のカーソルのままで、移行が進む
    server.settingsSupported = true;
    await core.sync();
    expect(server.settingsOf("mobile")).toEqual({
      "reader.theme": "dark",
      "reader.textSize": "large",
    });
  });
});

describe("同期し直しとログアウト", () => {
  test("最初から同期し直すと、手元の設定を届いたもので置き換える（送っていない変更は残す）", async () => {
    const context = await setup();
    const { server, core } = context;
    server.putSetting("mobile", "reader.theme", "dark");
    server.putSetting("mobile", "reader.textSize", "large");
    await core.sync();

    // 長く同期しない間に、ほかの端末が消し、消した印も回収された
    server.removeSetting("mobile", "reader.textSize");
    server.purgeTombstones();
    await core.changeSettings("mobile", { put: [{ name: "reader.layout", value: "compact" }] });

    const result = await pullOnly(context);
    expect(result.reset).toBe(true);
    expect(await settingsOf(core)).toEqual({
      "reader.theme": "dark",
      "reader.layout": "compact",
    });
    expect(await core.countPending()).toBe(1);
  });

  test("ログアウトすると、手元の設定と移行待ちを消す", async () => {
    const { server, core } = await setup();
    server.putSetting("mobile", "reader.theme", "dark");
    await core.sync();
    await core.seedSettings("mobile", [{ name: "reader.textSize", value: "large" }]);
    expect(Object.keys(await settingsOf(core))).toHaveLength(2);

    await core.signOut();
    expect(await settingsOf(core)).toEqual({});
    await expect(
      core.changeSettings("mobile", { put: [{ name: "reader.theme", value: "dark" }] }),
    ).rejects.toMatchObject({ kind: "unauthorized" });
  });
});
