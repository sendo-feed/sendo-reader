<script lang="ts" module>
  /** 24×24 の線のアイコン。1 つの path で描く（画像を足さず、CSP も緩めない） */
  const PATHS = {
    panelLeft: "M3 4h18v16H3zM9 4v16M15 9l-3 3 3 3",
    panelRight: "M3 4h18v16H3zM9 4v16M13 9l3 3-3 3",
    menu: "M4 6h16M4 12h16M4 18h16",
    more: "M5 12h.01M12 12h.01M19 12h.01",
    plus: "M12 5v14M5 12h14",
    close: "M6 6l12 12M18 6L6 18",
    chevronRight: "M9 6l6 6-6 6",
    chevronDown: "M6 9l6 6 6-6",
    arrowLeft: "M19 12H5M11 6l-6 6 6 6",
    arrowUp: "M12 19V5M6 11l6-6 6 6",
    arrowDown: "M12 5v14M6 13l6 6 6-6",
    check: "M5 12.5l4.5 4.5L19 7.5",
    checkAll: "M2 12.5l4.5 4.5L15 8M11.5 16.5l1 1L22 8",
    circle: "M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10z",
    bookmark: "M6 4h12v17l-6-4-6 4z",
    history: "M3 4v5h5M3 9a9 9 0 1 1 .6 8M12 7v5l3 2",
    inbox: "M3 13l3-8h12l3 8v6H3zM3 13h5l1.5 3h5l1.5-3h5",
    layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
    folder: "M3 6h6l2 2.5h10V19H3z",
    search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM16.5 16.5L21 21",
    share: "M12 15V4M8 8l4-4 4 4M5 12v7h14v-7",
    external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
    refresh: "M20 11A8 8 0 0 0 5.5 7M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4",
    sliders: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
    rss: "M5 5a14 14 0 0 1 14 14M5 11a8 8 0 0 1 8 8M5.5 18.5h.01",
    keyboard: "M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M8 14h8",
    logout: "M10 4H4v16h6M15 8l4 4-4 4M19 12H9",
    sort: "M7 5v14M4 16l3 3 3-3M17 19V5M14 8l3-3 3 3",
    filter: "M4 5h16l-6 7v6l-4 2v-8z",
  } as const;

  export type IconName = keyof typeof PATHS;
</script>

<script lang="ts">
  let { name, filled = false }: { name: IconName; filled?: boolean } = $props();
</script>

<svg class="icon" class:filled viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path d={PATHS[name]} />
</svg>

<style>
  .icon {
    flex: none;
    width: 1.25em;
    height: 1.25em;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.75;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .filled {
    fill: currentColor;
  }
</style>
