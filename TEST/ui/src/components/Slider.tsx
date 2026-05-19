import { useEffect, useRef } from "react";

interface SliderMark {
  value: number;
  label: string;
}

interface Props {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  marks?: SliderMark[];
}

// Custom slider with the silver thumb + black track. Uses native <input
// type="range"> for keyboard accessibility (left/right arrows, Home/End).
// The track is colored via a CSS custom property `--p` that we sync to the
// current value's percentage so the filled portion follows the thumb.

export function Slider({ value, onChange, min, max, step = 0.01, marks = [] }: Props): JSX.Element {
  const ref = useRef<HTMLInputElement>(null);

  const pct = ((value - min) / (max - min)) * 100;

  // Push the percentage into the input's CSS so the gradient follows it.
  useEffect(() => {
    if (ref.current) ref.current.style.setProperty("--p", `${pct}%`);
  }, [pct]);

  return (
    <div>
      <div className="slider-row">
        <div className="slider-track">
          <input
            ref={ref}
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => onChange(parseFloat(e.target.value))}
          />
        </div>
        <div className="slider-value">{value.toFixed(2)}</div>
      </div>
      {marks.length > 0 && (
        <div className="slider-marks">
          {marks.map((m) => (
            <span
              key={m.value}
              className="mark"
              data-active={Math.abs(value - m.value) < 0.05}
              onClick={() => onChange(m.value)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onChange(m.value); }}
            >
              {m.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
