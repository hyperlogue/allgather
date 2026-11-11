const sizes = {
  sm: { w: 32, h: 26, persp: 83, stroke: 2, count: 4, tilt: "38deg", step: 0.26 },
  md: { w: 44, h: 35, persp: 114, stroke: 2, count: 5, tilt: "38deg", step: 0.22 },
  lg: { w: 60, h: 48, persp: 156, stroke: 2, count: 6, tilt: "38deg", step: 0.18 },
} as const;

type SizeName = keyof typeof sizes;
type SizeConfig = (typeof sizes)[SizeName];

const shrink = 0.72;
const fade = 0.8;
const tierMs = 750;
const strokeTaper = 0.32;
const colors = ["var(--accent)", "var(--agent)"] as const;

function frame(p: number, cfg: SizeConfig) {
  const { h, persp, count, tilt, step, stroke } = cfg;
  const s = shrink ** (count - 1 - p);
  const y = (p * step * h).toFixed(2);
  const opacity = Math.max(0, Math.min(1, p / fade, (count - p) / fade));
  const z = Math.round((count - p) * 1000);
  const bw = (stroke * s ** (strokeTaper - 1)).toFixed(3);
  return {
    transform: `translate(-50%,${y}px) perspective(${persp}px) rotateX(${tilt}) scale(${s.toFixed(4)})`,
    opacity,
    z,
    bw,
  };
}

function sizeCss(name: SizeName, cfg: SizeConfig) {
  const { w, h, count, step } = cfg;
  const dur = count * tierMs;
  const sel = `.loading-indicator-${name}`;
  const odd = count % 2 === 1;
  const containerH = ((count - 1) * step * h + h).toFixed(2);
  let kf = `@keyframes loading-indicator-fall-${name}{`;
  for (let p = 0; p <= count; p++) {
    const fr = frame(p, cfg);
    const pct = ((p / count) * 100).toFixed(3).replace(/\.?0+$/, "");
    const ease = p < count ? "animation-timing-function:cubic-bezier(.45,0,.55,1);" : "";
    kf += `${pct}%{transform:${fr.transform};opacity:${fr.opacity.toFixed(3)};z-index:${fr.z};border-width:${fr.bw}px;${ease}}`;
  }
  kf += "}";
  let css =
    `${sel}{position:relative;width:${w}px;height:${containerH}px}` +
    `${sel}>i{position:absolute;top:0;left:50%;width:${w}px;height:${h}px;` +
    "box-sizing:border-box;border-style:solid;background:var(--bg-page);" +
    "box-shadow:0 0 10px color-mix(in srgb,var(--loading-indicator-glow) 50%,transparent);will-change:transform}" +
    kf;
  for (let k = 0; k < count; k++) {
    const fr = frame(k, cfg);
    const delay = -(k * tierMs);
    const c = colors[k % 2];
    let rule = `transform:${fr.transform};opacity:1;z-index:${fr.z};border-width:${fr.bw}px;border-color:${c};--loading-indicator-glow:${c};`;
    if (odd) {
      const flip = k % 2 === 0 ? "loading-indicator-flip-a" : "loading-indicator-flip-b";
      rule +=
        `animation:loading-indicator-fall-${name} ${dur}ms linear infinite,${flip} ${2 * dur}ms steps(2,jump-none) infinite;` +
        `animation-delay:${delay}ms,${delay}ms;`;
    } else {
      rule += `animation:loading-indicator-fall-${name} ${dur}ms linear infinite;animation-delay:${delay}ms;`;
    }
    css += `${sel}>i:nth-child(${k + 1}){${rule}}`;
  }
  return css;
}

const flipCss =
  `@keyframes loading-indicator-flip-a{0%{border-color:${colors[0]};--loading-indicator-glow:${colors[0]}}100%{border-color:${colors[1]};--loading-indicator-glow:${colors[1]}}}` +
  `@keyframes loading-indicator-flip-b{0%{border-color:${colors[1]};--loading-indicator-glow:${colors[1]}}100%{border-color:${colors[0]};--loading-indicator-glow:${colors[0]}}}`;

export const loadingIndicatorCss = `${Object.entries(sizes)
  .map(([name, cfg]) => sizeCss(name as SizeName, cfg))
  .join(
    "",
  )}${flipCss}@media (prefers-reduced-motion:reduce){.loading-indicator-sm>i,.loading-indicator-md>i,.loading-indicator-lg>i{animation:none!important}}`;

function installStyles() {
  if (document.getElementById("loading-indicator-styles")) return;
  const style = document.createElement("style");
  style.id = "loading-indicator-styles";
  style.textContent = loadingIndicatorCss;
  document.head.append(style);
}

export function LoadingIndicator({ size = "md", label }: { size?: SizeName; label?: string }) {
  installStyles();
  return (
    <div className="loading-indicator" role="status">
      <div className={`loading-indicator-${size}`} aria-hidden="true">
        {Array.from({ length: sizes[size].count }, (_, k) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Boxes are a fixed decorative sequence.
          <i key={k} />
        ))}
      </div>
      {label && <span>{label}</span>}
    </div>
  );
}
