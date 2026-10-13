/** The wheel on a canvas: it turns under a fixed marker, rolls while the table waits for its number, and slows to rest
 * with the landed number at the top. */
import { WHEEL, colour } from './table.ts';

const FILL = { red: '#b3261e', black: '#0a0d0e', green: '#1f7a4a' } as const,
  SLICE = (2 * Math.PI) / WHEEL.length,
  TURN = 2 * Math.PI,
  /** How fast the wheel rolls: a turn a second, in radians a millisecond. */
  SPEED = TURN / 1000;

export function mountWheel(canvas: HTMLCanvasElement, reducedMotion: boolean) {
  const g = canvas.getContext('2d')!,
    size = canvas.width,
    r = size / 2;
  let angle = 0,
    frame = 0;
  function draw() {
    g.clearRect(0, 0, size, size);
    g.save();
    g.translate(r, r);
    g.beginPath();
    g.arc(0, 0, r - 2, 0, TURN);
    g.fillStyle = '#2a3436';
    g.fill();
    g.rotate(angle);
    WHEEL.forEach((n, i) => {
      // Slice i is centred on the top when the wheel has turned by -i slices.
      const start = i * SLICE - SLICE / 2 - Math.PI / 2;
      g.beginPath();
      g.arc(0, 0, r * 0.93, start, start + SLICE);
      g.arc(0, 0, r * 0.66, start + SLICE, start, true);
      g.fillStyle = FILL[colour(n)];
      g.fill();
      g.strokeStyle = 'rgba(244, 245, 244, 0.18)';
      g.lineWidth = size / 400;
      g.stroke();
      g.save();
      g.rotate(i * SLICE);
      g.fillStyle = '#f4f5f4';
      g.font = `600 ${size / 26}px Inter, sans-serif`;
      g.textAlign = 'center';
      g.fillText(String(n), 0, -r * 0.82);
      g.restore();
    });
    g.beginPath();
    g.arc(0, 0, r * 0.66, 0, TURN);
    g.fillStyle = '#192022';
    g.fill();
    g.restore();
    // The marker the ball rests under.
    g.beginPath();
    g.moveTo(r - size / 40, 0);
    g.lineTo(r + size / 40, 0);
    g.lineTo(r, size / 18);
    g.fillStyle = '#c5ef91';
    g.fill();
  }
  function halt() {
    cancelAnimationFrame(frame);
    frame = 0;
  }
  draw();
  return {
    /** Roll on steadily until `spin` names the number. */
    roll() {
      if (reducedMotion || frame) return;
      let before = performance.now();
      const tick = (now: number) => {
        angle -= SPEED * (now - before);
        before = now;
        draw();
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    },
    /** Stop rolling, wherever the wheel is. */
    stop: halt,
    /** Slow down, from the roll's speed, over one more turn and some, to rest with `n` under the marker. */
    spin(n: number) {
      halt();
      const from = ((angle % TURN) + TURN) % TURN,
        to = -WHEEL.indexOf(n) * SLICE,
        distance = TURN + ((((from - to) % TURN) + TURN) % TURN),
        // Easing out as a cubic starts at three times the average speed: the roll's.
        duration = reducedMotion ? 0 : (3 * distance) / SPEED,
        started = performance.now();
      return new Promise<void>(resolve => {
        const tick = (now: number) => {
          const t = duration ? Math.min(1, (now - started) / duration) : 1;
          angle = from - distance * (1 - (1 - t) ** 3);
          draw();
          if (t < 1) frame = requestAnimationFrame(tick);
          else {
            frame = 0;
            resolve();
          }
        };
        frame = requestAnimationFrame(tick);
      });
    },
  };
}
