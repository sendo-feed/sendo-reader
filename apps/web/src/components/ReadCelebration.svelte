<script lang="ts">
  import { reducedMotion } from "../lib/layout.svelte";

  let active = $state(!reducedMotion());

  /** 両下隅から飛び出す紙吹雪。描く間だけ canvas と rAF を持ち、操作やフォーカスは奪わない */
  function burst(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (context === null) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const style = getComputedStyle(canvas);
    const colors = ["teal", "gold", "rose", "violet", "sky"].map((color) =>
      style.getPropertyValue(`--confetti-${color}`).trim(),
    );
    const particles = Array.from({ length: 120 }, (_, i) => ({
      side: i % 2,
      x: 0,
      y: 0,
      vx: (i % 2 === 0 ? 1 : -1) * (180 + Math.random() * 480),
      vy: -400 - Math.random() * 650,
      size: 4 + Math.random() * 5,
      spin: Math.random() * Math.PI,
      color: colors[i % colors.length] ?? "",
    }));
    let width = window.innerWidth;
    let height = window.innerHeight;
    let frame = 0;
    let previous: number | undefined;
    let start: number | undefined;

    function resize() {
      width = window.innerWidth;
      height = window.innerHeight;
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * scale;
      canvas.height = height * scale;
      context?.setTransform(scale, 0, 0, scale, 0, 0);
    }
    resize();
    for (const particle of particles) {
      particle.x = particle.side === 0 ? width * 0.08 : width * 0.92;
      particle.y = height * 0.9;
    }

    function draw(now: number) {
      if (context === null) return;
      start ??= now;
      const elapsed = now - start;
      const dt = Math.min((now - (previous ?? now)) / 1000, 0.04);
      previous = now;
      context.clearRect(0, 0, width, height);
      if (elapsed > 2600 || motion.matches) {
        active = false;
        return;
      }
      context.globalAlpha = Math.min(1, (2600 - elapsed) / 700);
      for (const particle of particles) {
        particle.vx *= 0.99;
        particle.vy += 780 * dt;
        particle.x += particle.vx * dt;
        particle.y += particle.vy * dt;
        particle.spin += dt * 7;
        context.save();
        context.translate(particle.x, particle.y);
        context.rotate(particle.spin);
        context.fillStyle = particle.color;
        context.fillRect(
          -particle.size / 2,
          -particle.size / 2,
          particle.size,
          particle.size * 0.6,
        );
        context.restore();
      }
      frame = requestAnimationFrame(draw);
    }
    function stopMotion() {
      if (motion.matches) active = false;
    }
    window.addEventListener("resize", resize);
    motion.addEventListener("change", stopMotion);
    frame = requestAnimationFrame(draw);
    return {
      destroy() {
        cancelAnimationFrame(frame);
        window.removeEventListener("resize", resize);
        motion.removeEventListener("change", stopMotion);
      },
    };
  }
</script>

{#if active}
  <canvas class="read-celebration" aria-hidden="true" use:burst></canvas>
{/if}

<style>
  .read-celebration {
    position: fixed;
    inset: 0;
    z-index: 5;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
</style>
