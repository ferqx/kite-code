import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { Slider } from './components/ui/slider';

export const effortNames = ['极低', '低', '中', '高', '极高', '最大'];
const allPositions = [0, 1, 2, 3, 4, 5];

export function GemSlider({
  value,
  valueText,
  onValueChange,
  allowedValues = allPositions,
}: {
  value: number;
  valueText?: string;
  onValueChange: (value: number) => void;
  allowedValues?: readonly number[];
}) {
  const root = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const target = useRef(value);
  const positions = useRef(allowedValues);
  positions.current = allowedValues;
  const position = Math.max(0, allowedValues.indexOf(value));
  const redraw = useRef<(() => void) | null>(null);
  const pressedPointer = useRef<number | null>(null);
  const [release, setRelease] = useState(0);
  useEffect(() => {
    target.current = value;
    redraw.current?.();
  }, [value]);

  useEffect(() => {
    const surface = canvas.current!;
    const slider = root.current!;
    const context = surface.getContext('2d');
    if (!context) return;
    const ctx = context;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let width = 0,
      height = 0,
      thumbSize = 0,
      frame = 0,
      last = 0,
      energy = target.current;
    let points: {
      x: number;
      y: number;
      r: number;
      speed: number;
      phase: number;
      frequency: number;
      brightness: number;
      glint: boolean;
    }[] = [];

    function draw(delta: number) {
      ctx.clearRect(0, 0, width, height);
      const fraction =
        Math.max(0, positions.current.indexOf(target.current)) /
        Math.max(1, positions.current.length - 1);
      const active = thumbSize / 2 + (width - thumbSize) * fraction;
      const speed = 0.6 + energy * 0.5 + energy * energy * 0.16;
      const staticMode = motion.matches;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, Math.max(0, active - thumbSize / 2), height);
      ctx.clip();
      if (!staticMode) {
        const depth = 0.045 + 0.018 * Math.cos(last * 0.00037);
        const jewel = ctx.createRadialGradient(
          active * 0.35,
          height * 0.28,
          0,
          active * 0.35,
          height * 0.28,
          Math.max(40, active * 0.55),
        );
        jewel.addColorStop(
          0,
          `rgba(${target.current === 5 ? '188,148,230' : '116,198,255'},${depth})`,
        );
        jewel.addColorStop(1, '#70bdff00');
        ctx.fillStyle = jewel;
        ctx.fillRect(0, 0, active, height);
      }
      for (const point of points) {
        if (!staticMode) {
          point.x = (point.x + point.speed * speed * delta) % width;
          point.phase += point.frequency * delta;
        }
        const shimmer = staticMode ? 0.3 : ((Math.cos(point.phase) + 1) / 2) ** 7;
        const alpha = (0.07 + point.brightness * 0.12 + shimmer * 0.5) * 1.18;
        ctx.beginPath();
        ctx.arc(point.x, point.y, point.r + shimmer * 0.22, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${point.glint ? '235,239,255' : target.current === 5 && point.x > width * 0.3 && point.x < width * 0.8 ? '195,188,245' : '170,212,255'},${alpha})`;
        ctx.fill();
        if (point.glint && shimmer > 0.45) {
          const reach = 0.9 + shimmer * 1.9;
          ctx.beginPath();
          ctx.moveTo(point.x - reach, point.y);
          ctx.lineTo(point.x + reach, point.y);
          ctx.moveTo(point.x, point.y - reach * 0.8);
          ctx.lineTo(point.x, point.y + reach * 0.8);
          ctx.strokeStyle = `rgba(229,231,255,${(shimmer - 0.45) * 0.6})`;
          ctx.lineWidth = 0.55;
          ctx.stroke();
          const halo = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, reach * 2);
          halo.addColorStop(0, `rgba(164,177,247,${shimmer * 0.1})`);
          halo.addColorStop(1, '#a4b1f700');
          ctx.fillStyle = halo;
          ctx.fillRect(point.x - reach * 2, point.y - reach * 2, reach * 4, reach * 4);
        }
        if (!staticMode && point.r > 0.85 && shimmer > 0.4) {
          const trail = 2 + speed * 0.55;
          const gradient = ctx.createLinearGradient(point.x - trail, point.y, point.x, point.y);
          gradient.addColorStop(0, '#a9dfff00');
          gradient.addColorStop(1, `rgba(212,218,252,${alpha * 0.3})`);
          ctx.fillStyle = gradient;
          ctx.fillRect(point.x - trail, point.y - 0.3, trail, 0.6);
        }
      }
      ctx.restore();
    }

    function resize() {
      width = slider.clientWidth;
      height = slider.querySelector<HTMLElement>('[data-slot="slider-track"]')!.clientHeight;
      thumbSize = slider.querySelector<HTMLElement>('[data-slot="slider-thumb"]')!.offsetWidth;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      surface.width = width * dpr;
      surface.height = height * dpr;
      surface.style.width = `${width}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      points = Array.from({ length: Math.round((width * height) / 42) }, () => ({
        x: Math.random() * width,
        y: 3 + Math.random() * (height - 6),
        r: 0.2 + Math.random() ** 3 * 0.95,
        speed: 0.18 + Math.random() * 0.42,
        phase: Math.random() * Math.PI * 2,
        frequency: 0.01 + Math.random() * 0.018,
        brightness: Math.random(),
        glint: Math.random() < 0.075,
      }));
      draw(0);
    }

    function animate(time: number) {
      const delta = Math.min((time - last) / 16.67, 2);
      last = time;
      energy += (target.current - energy) * (1 - Math.exp(-delta * 0.08));
      draw(delta);
      frame = requestAnimationFrame(animate);
    }

    function resume() {
      cancelAnimationFrame(frame);
      if (motion.matches) setRelease(0);
      if (!document.hidden && !motion.matches) {
        last = performance.now();
        frame = requestAnimationFrame(animate);
      } else {
        energy = target.current;
        draw(0);
      }
    }

    const observer = new ResizeObserver(resize);
    redraw.current = () => {
      if (motion.matches) {
        energy = target.current;
        draw(0);
      }
    };
    observer.observe(slider);
    resize();
    resume();
    motion.addEventListener('change', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      redraw.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
      motion.removeEventListener('change', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);

  return (
    <Slider
      ref={root}
      className="gem-slider"
      data-maximum={value === 5}
      value={[position]}
      onValueChange={([next]) => {
        if (next !== undefined && allowedValues[next] !== undefined)
          onValueChange(allowedValues[next]!);
      }}
      onValueCommit={([next]) => {
        if (next !== undefined && allowedValues[next] !== undefined)
          onValueChange(allowedValues[next]!);
      }}
      onPointerDown={(event) => {
        if (event.button === 0) pressedPointer.current = event.pointerId;
      }}
      onPointerUp={(event) => {
        if (pressedPointer.current !== event.pointerId) return;
        pressedPointer.current = null;
        if (!matchMedia('(prefers-reduced-motion: reduce)').matches)
          setRelease((previous) => previous + 1);
      }}
      onPointerCancel={() => {
        pressedPointer.current = null;
      }}
      min={0}
      max={allowedValues.length - 1}
      step={1}
      aria-label="思考程度"
      aria-valuetext={valueText ?? effortNames[value]}
      rangeContent={<canvas ref={canvas} tabIndex={-1} aria-hidden="true" />}
      trackContent={
        <span className="gem-ticks" aria-hidden="true">
          {allowedValues.map((value, index) => (
            <i key={value} data-passed={index <= position} />
          ))}
        </span>
      }
      thumbContent={
        release > 0 && (
          <span key={release} className="gem-release" aria-hidden="true">
            {Array.from({ length: 18 }, (_, index) => {
              const angle = (index / 18) * Math.PI * 2 + Math.sin(index * 4) * 0.13;
              return (
                <i
                  key={index}
                  className="gem-release-particle"
                  style={
                    {
                      '--x': Math.cos(angle),
                      '--y': Math.sin(angle),
                      '--distance': `${32 + (index % 4) * 3}px`,
                      '--delay': `${index * 4}ms`,
                    } as CSSProperties
                  }
                  onAnimationEnd={index === 17 ? () => setRelease(0) : undefined}
                />
              );
            })}
          </span>
        )
      }
    />
  );
}
