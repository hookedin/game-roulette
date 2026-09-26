/** The wheel on a canvas: it turns under a fixed marker and stops with the landed number at the top. */
import { WHEEL, colour } from './table.ts';

const FILL = { red: '#b3261e', black: '#0a0d0e', green: '#1f7a4a' } as const,
  SLICE = (2 * Math.PI) / WHEEL.length;

export function mountWheel(canvas: HTMLCanvasElement, reducedMotion: boolean) {
  const g = canvas.getContext('2d')!,
    size = canvas.width,
    r = size / 2;
  let angle = 0;
  function draw() {
    g.clearRect(0, 0, size, size);
    g.save();
    g.translate(r, r);
    g.rotate(angle);
    WHEEL.forEach((n, i) => {
      // Slice i is centred on the top when the wheel has turned by -i slices.
      const start = i * SLICE - SLICE / 2 - Math.PI / 2;
      g.beginPath();
      g.moveTo(0, 0);
      g.arc(0, 0, r - 4, start, start + SLICE);
      g.fillStyle = FILL[colour(n)];
      g.fill();
      g.save();
      g.rotate(i * SLICE);
      g.fillStyle = '#f4f5f4';
      g.font = `600 ${size / 30}px Inter, sans-serif`;
      g.textAlign = 'center';
      g.fillText(String(n), 0, -(r - size / 16));
      g.restore();
    });
    g.beginPath();
    g.arc(0, 0, r * 0.62, 0, 2 * Math.PI);
    g.fillStyle = '#192022';
    g.fill();
    g.restore();
    // The marker the ball rests under.
    g.beginPath();
    g.moveTo(r - 9, 0);
    g.lineTo(r + 9, 0);
    g.lineTo(r, 20);
    g.fillStyle = '#c5ef91';
    g.fill();
  }
  const resting = (n: number) => -WHEEL.indexOf(n) * SLICE;
  draw();
  return {
    rest(n: number) {
      angle = resting(n);
      draw();
    },
    /** Turn several times and come to rest on `n`. */
    spin(n: number) {
      const from = angle % (2 * Math.PI),
        to = resting(n) - 8 * Math.PI,
        started = performance.now(),
        duration = reducedMotion ? 0 : 5200;
      return new Promise<void>(resolve => {
        const frame = (now: number) => {
          const t = duration ? Math.min(1, (now - started) / duration) : 1;
          angle = from + (to - from) * (1 - (1 - t) ** 4);
          draw();
          if (t < 1) requestAnimationFrame(frame);
          else resolve();
        };
        requestAnimationFrame(frame);
      });
    },
  };
}
